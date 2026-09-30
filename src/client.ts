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
 * Per-endpoint cache lifetimes, in seconds. Chosen by how fast the data actually moves:
 * console/game metadata changes on set revisions (hours), user progress changes the
 * moment an achievement pops (a minute is the most a chat turn will tolerate).
 */
export const TTL = {
  static: 24 * 3600, // console list, hashes
  catalog: 6 * 3600, // per-console game lists
  game: 3600, // game metadata, achievement sets, leaderboards definitions
  feed: 300, // AotW, top ten, claims, recent awards, rankings
  user: 60, // anything that changes when the user plays
  none: 0,
} as const;

interface CacheEntry {
  expires: number;
  value: unknown;
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
        this.tokens = Math.min(
          this.burst,
          this.tokens + ((now - this.last) / 60_000) * this.perMinute,
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
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
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

  private readonly cache = new Map<string, CacheEntry>();
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
    >,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.sem = new Semaphore(cfg.RA_MAX_CONCURRENCY);
    this.bucket = new TokenBucket(cfg.RA_RATE_PER_MINUTE, cfg.RA_RATE_BURST);
  }
  private readonly bucket: TokenBucket;

  /**
   * GET `/API/API_<endpoint>.php`. `endpoint` is the bare name, e.g. `GetGame`.
   * Returns `null` for an empty 200 body, which RA uses for "no such id" on several
   * endpoints.
   */
  async get<T = unknown>(endpoint: string, params: Params, ttlSeconds: number): Promise<T> {
    const clean = canonical(params);
    const key = cacheKey(endpoint, params);
    const ttl = ttlSeconds * this.cfg.RA_CACHE_TTL_SCALE;

    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit && hit.expires > Date.now()) {
        // Refresh LRU position.
        this.cache.delete(key);
        this.cache.set(key, hit);
        this.stats.cacheHits++;
        return hit.value as T;
      }
      if (hit) this.cache.delete(key);
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending as Promise<T>;
    }

    const p = this.sem
      .run(() => this.fetchWithRetry(endpoint, clean))
      .then(value => {
        if (ttl > 0 && this.cfg.RA_CACHE_MAX_ENTRIES > 0) {
          this.cache.set(key, { expires: Date.now() + ttl * 1000, value });
          while (this.cache.size > this.cfg.RA_CACHE_MAX_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p as Promise<T>;
  }

  private async fetchWithRetry(endpoint: string, params: [string, string][]): Promise<unknown> {
    const url = new URL(`/API/API_${endpoint}.php`, this.cfg.RA_BASE_URL);
    for (const [k, v] of params) url.searchParams.set(k, v);
    url.searchParams.set('y', this.cfg.RA_API_KEY);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.bucket.take();
        this.stats.upstreamCalls++;
        const res = await this.fetchImpl(url, {
          headers: {
            accept: 'application/json',
            'user-agent':
              'retroachievements-mcp (+https://github.com/sharkusmanch/retroachievements-mcp)',
          },
          signal: AbortSignal.timeout(this.cfg.RA_TIMEOUT_MS),
        });
        const text = await res.text();
        if (res.ok) return parseBody(text, endpoint, res.status);

        if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
          // 429s need a real pause (the window is ~a minute); 5xx a short one.
          const base = res.status === 429 ? 2000 : 500;
          const wait = retryAfterMs(res.headers.get('retry-after')) ?? base * 2 ** (attempt - 1);
          this.log.warn('upstream retry', { endpoint, status: res.status, attempt, wait });
          await sleep(wait);
          continue;
        }
        throw new RAError(errorMessage(res.status, text), res.status, endpoint);
      } catch (e) {
        if (e instanceof RAError) throw e;
        lastErr = e;
        // Network error / timeout: retry, then surface a fixed, URL-free message.
        if (attempt < MAX_ATTEMPTS) {
          this.log.warn('upstream network retry', { endpoint, attempt, error: e });
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }
    }
    const reason =
      lastErr instanceof Error && lastErr.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new RAError(`request ${reason}`, 0, endpoint);
  }
}

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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RAError('upstream returned non-JSON', status, endpoint);
  }
}

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.min(Math.max(s, 0) * 1000, 10_000);
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.min(Math.max(d - Date.now(), 0), 10_000);
}

function errorMessage(status: number, body: string): string {
  if (status === 401) return 'API key rejected (401). Check RA_API_KEY.';
  if (status === 404) return 'not found';
  try {
    const j = JSON.parse(body) as { message?: unknown };
    if (typeof j.message === 'string' && j.message) return j.message.slice(0, 300);
  } catch {
    /* fall through */
  }
  return `HTTP ${status}`;
}
