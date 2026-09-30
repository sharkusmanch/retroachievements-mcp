import type { Config } from './config.js';
import type { Logger } from './logger.js';

/**
 * Upstream error. `message` is built from the RESPONSE (or a fixed string) only — never
 * from the request URL, which carries the API key as `y=`.
 */
export class RAError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = 'RAError';
  }
}

export type Params = Record<string, string | number | boolean | undefined>;

/**
 * Cache lifetimes, in seconds. Chosen by how fast the data actually moves:
 * console/game metadata changes on set revisions (hours), user progress changes the
 * moment an achievement pops (a minute is the most a chat turn will tolerate).
 */
export const TTL = {
  static: 24 * 3600, // console list, hashes
  catalog: 24 * 3600, // per-console game lists (CatalogStore refresh age)
  slow: 6 * 3600, // aggregate stats recomputed rarely (median completion times)
  game: 3600, // game metadata, achievement sets, leaderboards definitions
  social: 600, // follows, want-to-play, site awards: change on deliberate user action
  feed: 300, // AotW, top ten, claims, recent awards, rankings
  user: 60, // anything that changes when the user plays
  none: 0,
} as const;

/**
 * Default lifetime per endpoint — used when a caller passes no TTL (notably
 * `ra_api_raw`). Also the canonical list of every documented Web API endpoint
 * (38), without the `API_` prefix / `.php` suffix.
 */
export const ENDPOINT_TTL = {
  GetAchievementCount: TTL.game,
  GetAchievementDistribution: TTL.game,
  GetAchievementOfTheWeek: TTL.feed,
  GetAchievementUnlocks: TTL.feed,
  GetAchievementsEarnedBetween: TTL.user,
  GetAchievementsEarnedOnDay: TTL.user,
  GetActiveClaims: TTL.feed,
  GetClaims: TTL.feed,
  GetComments: TTL.feed,
  GetConsoleIDs: TTL.static,
  GetGame: TTL.game,
  GetGameExtended: TTL.game,
  GetGameHashes: TTL.static,
  GetGameInfoAndUserProgress: TTL.user,
  GetGameLeaderboards: TTL.game,
  GetGameList: TTL.catalog,
  GetGameProgression: TTL.slow,
  GetGameRankAndScore: TTL.feed,
  GetLeaderboardEntries: TTL.feed,
  GetRecentGameAwards: TTL.feed,
  GetTicketData: TTL.feed,
  GetTopTenUsers: TTL.feed,
  GetUserAwards: TTL.social,
  GetUserClaims: TTL.feed,
  GetUserCompletedGames: TTL.user,
  GetUserCompletionProgress: TTL.user,
  GetUserGameLeaderboards: TTL.user,
  GetUserGameRankAndScore: TTL.user,
  GetUserPoints: TTL.user,
  GetUserProfile: TTL.user,
  GetUserProgress: TTL.user,
  GetUserRecentAchievements: TTL.user,
  GetUserRecentlyPlayedGames: TTL.user,
  GetUserSetRequests: TTL.feed,
  GetUserSummary: TTL.user,
  GetUserWantToPlayList: TTL.social,
  GetUsersFollowingMe: TTL.social,
  GetUsersIFollow: TTL.social,
} as const satisfies Record<string, number>;

export type Endpoint = keyof typeof ENDPOINT_TTL;

/** A single response larger than this is never cached (it would crowd out everything). */
export const MAX_CACHEABLE_BYTES = 1024 * 1024;
const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Wall-clock budget for one upstream request including retries and backoff, measured
 * from when it gets a concurrency slot. Keeps a tool call inside typical client
 * timeouts even when RA is slow and rate-limiting at the same time.
 */
export const REQUEST_DEADLINE_MS = 35_000;

interface CacheEntry {
  expires: number;
  value: unknown;
  /** Estimated size (response text length). */
  bytes: number;
}

/** Tiny async semaphore — bounds concurrent upstream requests. */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is HANDED to the next waiter (active stays constant) rather than
    // freed and re-taken: otherwise a caller arriving in the microtask gap before the
    // waiter resumes sees a free slot too, and the ceiling is exceeded.
    if (this.active >= this.max) await new Promise<void>(r => this.queue.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * Token bucket. RetroAchievements publishes no rate-limit headers; measured behaviour
 * (2026-09) is that ~80 req/min sustained is fine but a burst of ~20 back-to-back
 * requests starts drawing 429s. Pacing ourselves is far cheaper than eating a 429 and
 * backing off.
 */
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private pausedUntil = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }
  /** Resolves when a token is available. Serialised so waiters are FIFO. */
  take(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        if (now < this.pausedUntil) {
          await sleep(this.pausedUntil - now);
          continue;
        }
        this.tokens = Math.min(
          this.burst,
          this.tokens + (Math.max(0, now - this.last) / 60_000) * this.perMinute,
        );
        this.last = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000));
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
  /**
   * Shared cooldown after a 429: drain the bucket and hold every waiter for `ms`, so
   * queued requests don't fire into the same rate-limit window. When the pause ends a
   * single token is available (the first waiter goes), then normal pacing resumes.
   */
  pause(ms: number): void {
    const until = Date.now() + ms;
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.tokens = 1;
    this.last = until;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
/** Attempts that may end in a timeout: a slow upstream gets ONE retry, not three. */
const MAX_TIMEOUTS = 2;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface ClientStats {
  upstreamCalls: number;
  cacheHits: number;
  coalesced: number;
}

/**
 * RetroAchievements Web API client.
 *
 * Efficiency is the point of this layer, not an afterthought:
 *  - TTL cache keyed on endpoint + canonicalised params (LRU-evicted at a fixed size), so
 *    a model that re-asks the same question in one conversation costs no upstream call.
 *  - In-flight coalescing: concurrent identical requests share one fetch (a fan-out tool
 *    and a follow-up call racing for the same game list hit RA once).
 *  - A concurrency ceiling, plus bounded retry with backoff on 429/5xx, honouring
 *    Retry-After when present.
 */
export class RAClient {
  /** Direct cache read (no fetch) — lets callers check what is already warm. */
  peek<T>(endpoint: string, params: Params): T | undefined {
    const hit = this.cache.get(cacheKey(endpoint, params));
    return hit && hit.expires > Date.now() ? (hit.value as T) : undefined;
  }

  /**
   * First fresh cached value of `endpoint` whose params include every given pair —
   * e.g. any user's GetGameInfoAndUserProgress for game `g`. No fetch, no LRU bump.
   */
  peekAny<T>(endpoint: string, subset: Params): T | undefined {
    const prefix = `${endpoint}?`;
    const want = canonical(subset);
    const now = Date.now();
    for (const [key, hit] of this.cache) {
      if (!key.startsWith(prefix) || hit.expires <= now) continue;
      const have = new URLSearchParams(key.slice(prefix.length));
      if (want.every(([k, v]) => have.get(k) === v)) return hit.value as T;
    }
    return undefined;
  }

  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly sem: Semaphore;
  readonly stats: ClientStats = { upstreamCalls: 0, cacheHits: 0, coalesced: 0 };

  constructor(
    private readonly cfg: Pick<
      Config,
      | 'RA_API_KEY'
      | 'RA_BASE_URL'
      | 'RA_TIMEOUT_MS'
      | 'RA_MAX_CONCURRENCY'
      | 'RA_CACHE_MAX_ENTRIES'
      | 'RA_CACHE_TTL_SCALE'
      | 'RA_RATE_PER_MINUTE'
      | 'RA_RATE_BURST'
    > &
      Partial<Pick<Config, 'RA_CACHE_MAX_BYTES'>>,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.sem = new Semaphore(cfg.RA_MAX_CONCURRENCY);
    this.bucket = new TokenBucket(cfg.RA_RATE_PER_MINUTE, cfg.RA_RATE_BURST);
  }
  private readonly bucket: TokenBucket;

  /**
   * GET `/API/API_<endpoint>.php`. `endpoint` is the bare name, e.g. `GetGame`.
   * `ttlSeconds` defaults to the endpoint's entry in ENDPOINT_TTL (TTL.feed if unknown).
   * Returns `null` for an empty 200 body, which RA uses for "no such id" on several
   * endpoints. Parsed bodies are deep-frozen: they may be shared through the cache, so a
   * caller that sorts/mutates in place must copy first (and now fails loudly if not).
   */
  async get<T = unknown>(endpoint: string, params: Params, ttlSeconds?: number): Promise<T> {
    const clean = canonical(params);
    const key = cacheKey(endpoint, params);
    const ttl =
      (ttlSeconds ?? (ENDPOINT_TTL as Record<string, number>)[endpoint] ?? TTL.feed) *
      this.cfg.RA_CACHE_TTL_SCALE;

    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit && hit.expires > Date.now()) {
        // Refresh LRU position.
        this.cache.delete(key);
        this.cache.set(key, hit);
        this.stats.cacheHits++;
        return hit.value as T;
      }
      if (hit) this.evict(key);
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending as Promise<T>;
    }

    const p = this.sem
      .run(() => this.fetchWithRetry(endpoint, clean))
      .then(({ value, bytes }) => {
        if (ttl > 0) this.store(key, { expires: Date.now() + ttl * 1000, value, bytes });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p as Promise<T>;
  }

  private store(key: string, entry: CacheEntry): void {
    const maxEntries = this.cfg.RA_CACHE_MAX_ENTRIES;
    const maxBytes = this.cfg.RA_CACHE_MAX_BYTES ?? DEFAULT_CACHE_MAX_BYTES;
    if (maxEntries <= 0 || entry.bytes > Math.min(MAX_CACHEABLE_BYTES, maxBytes)) return;
    this.evict(key);
    this.cache.set(key, entry);
    this.cacheBytes += entry.bytes;
    while (this.cache.size > maxEntries || this.cacheBytes > maxBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
  }

  private evict(key: string): void {
    const e = this.cache.get(key);
    if (!e) return;
    this.cache.delete(key);
    this.cacheBytes -= e.bytes;
  }

  /** Current cache footprint (entries, estimated bytes). */
  cacheSize(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.cacheBytes };
  }

  private async fetchWithRetry(
    endpoint: string,
    params: [string, string][],
  ): Promise<{ value: unknown; bytes: number }> {
    const url = new URL(`/API/API_${endpoint}.php`, this.cfg.RA_BASE_URL);
    for (const [k, v] of params) url.searchParams.set(k, v);
    url.searchParams.set('y', this.cfg.RA_API_KEY);

    const deadline = Date.now() + Math.max(REQUEST_DEADLINE_MS, this.cfg.RA_TIMEOUT_MS);
    /** True when a retry after `wait` ms could still start before the deadline. */
    const canRetry = (attempt: number, wait: number) =>
      attempt < MAX_ATTEMPTS && Date.now() + wait < deadline;
    let lastErr: unknown;
    let timeouts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.bucket.take();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          // The rate limiter (usually a 429 cooldown) consumed the whole budget.
          if (lastErr === undefined) {
            throw new RAError('rate limited (429 cooldown); retry shortly', 429, endpoint);
          }
          break;
        }
        this.stats.upstreamCalls++;
        const res = await this.fetchImpl(url, {
          headers: {
            accept: 'application/json',
            'user-agent':
              'retroachievements-mcp (+https://github.com/sharkusmanch/retroachievements-mcp)',
          },
          signal: AbortSignal.timeout(Math.min(this.cfg.RA_TIMEOUT_MS, remaining)),
        });
        const text = await res.text();
        if (res.ok) return { value: parseBody(text, endpoint, res.status), bytes: text.length };

        if (RETRYABLE.has(res.status)) {
          // 429s need a real pause (the window is ~a minute); 5xx a short one.
          const base = res.status === 429 ? 2000 : 500;
          const wait = retryAfterMs(res.headers.get('retry-after')) ?? base * 2 ** (attempt - 1);
          // Shared cooldown: every queued request waits out the window with us (take()
          // blocks until it ends), instead of drawing more 429s — applied even when this
          // request is out of retries, since the others are not.
          if (res.status === 429) this.bucket.pause(wait);
          if (canRetry(attempt, wait)) {
            this.log.warn('upstream retry', { endpoint, status: res.status, attempt, wait });
            if (res.status !== 429) await sleep(wait);
            continue;
          }
        }
        throw new RAError(errorMessage(res.status, text), res.status, endpoint);
      } catch (e) {
        if (e instanceof RAError) throw e;
        lastErr = e;
        if (isTimeout(e)) timeouts++;
        // Network error / timeout: retry, then surface a fixed, URL-free message.
        const wait = 500 * 2 ** (attempt - 1);
        if (timeouts < MAX_TIMEOUTS && canRetry(attempt, wait)) {
          this.log.warn('upstream network retry', { endpoint, attempt, error: e });
          await sleep(wait);
          continue;
        }
        break;
      }
    }
    const reason = isTimeout(lastErr) || lastErr === undefined ? 'timed out' : 'network error';
    throw new RAError(`request ${reason}`, 0, endpoint);
  }
}

const isTimeout = (e: unknown) => e instanceof Error && e.name === 'TimeoutError';

function canonical(params: Params): [string, string][] {
  const out: [string, string][] = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)]);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function cacheKey(endpoint: string, params: Params): string {
  return `${endpoint}?${new URLSearchParams(canonical(params)).toString()}`;
}

function parseBody(text: string, endpoint: string, status: number): unknown {
  if (text.trim() === '') return null;
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch {
    throw new RAError('upstream returned non-JSON', status, endpoint);
  }
  return deepFreeze(v);
}

/**
 * Recursively freeze a JSON value. Cached bodies are shared by every caller, so an
 * in-place mutation (e.g. `.sort()`) by one tool would corrupt the next caller's view.
 */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(Math.max(s, 0) * 1000, 10_000);
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.min(Math.max(d - Date.now(), 0), 10_000);
}

/**
 * Error text for a failed response — built ONLY from the response body (or a fixed
 * string), never the URL. RA uses `{"message": "..."}` and, on some 422s, a bare array
 * of strings (`["User has no leaderboards on this game"]`).
 */
function errorMessage(status: number, body: string): string {
  if (status === 401) return 'API key rejected (401). Check RA_API_KEY.';
  const fromBody = bodyMessage(body);
  if (fromBody) return fromBody;
  return status === 404 ? 'not found' : `HTTP ${status}`;
}

function bodyMessage(body: string): string | undefined {
  let j: unknown;
  try {
    j = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (Array.isArray(j)) {
    const parts = j.filter((x): x is string => typeof x === 'string' && x !== '');
    return parts.length ? parts.join('; ').slice(0, 300) : undefined;
  }
  if (j && typeof j === 'object') {
    const m = (j as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m.slice(0, 300);
  }
  return undefined;
}
