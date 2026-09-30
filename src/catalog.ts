import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deepFreeze, TTL, type RAClient } from './client.js';
import type { Logger } from './logger.js';

export interface CatalogGame {
  ID: number;
  Title: string;
  ConsoleID: number;
  ConsoleName: string;
  NumAchievements?: number;
  NumLeaderboards?: number;
  Points?: number;
  DateModified?: string | null;
}

interface Stored {
  fetched: number;
  games: readonly CatalogGame[];
}

/**
 * Freshness policy (stale-while-revalidate). Sets are added/revised daily at most, so a
 * catalog younger than TTL.catalog (24h) is served as-is; up to a week old it is still
 * served immediately (a title search does not need today's additions) while a refresh
 * runs in the background; older than that it is refetched before answering. If
 * upstream is down, any disk copy — however old — beats an error.
 */
const REFRESH_AFTER_MS = TTL.catalog * 1000;
const MAX_STALE_MS = 7 * 24 * 3600 * 1000;
/** Minimum gap between background refresh attempts of one catalog. */
const REFRESH_RETRY_MS = 15 * 60_000;

/** Keep only the fields find_games uses; GetGameList rows carry more (icons, hashes). */
function slim(g: CatalogGame): CatalogGame {
  const out: CatalogGame = {
    ID: g.ID,
    Title: g.Title,
    ConsoleID: g.ConsoleID,
    ConsoleName: g.ConsoleName,
  };
  if (g.NumAchievements !== undefined) out.NumAchievements = g.NumAchievements;
  if (g.Points !== undefined) out.Points = g.Points;
  if (g.NumLeaderboards !== undefined) out.NumLeaderboards = g.NumLeaderboards;
  if (g.DateModified !== undefined) out.DateModified = g.DateModified;
  return out;
}

const project = (games: readonly CatalogGame[]): readonly CatalogGame[] =>
  deepFreeze(games.map(slim));

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = env.XDG_CACHE_HOME || (homedir() ? join(homedir(), '.cache') : undefined);
  return base ? join(base, 'retroachievements-mcp') : undefined;
}

/**
 * Per-console game catalogs (GetGameList, c=0) — the one large, slow-moving dataset.
 * RA has no title-search endpoint, so searching across systems means holding every
 * catalog: ~50 requests, which at the rate RA tolerates is most of a minute.
 *
 * Hence three layers: memory → disk (survives restarts; stdio clients restart the
 * server constantly) → upstream. And callers get a time BUDGET: whatever cannot be
 * loaded in time keeps loading in the background and the caller is told the search was
 * partial, rather than the whole tool call timing out on the client.
 */
export class CatalogStore {
  private readonly mem = new Map<string, Stored>();
  private readonly loading = new Map<string, Promise<readonly CatalogGame[]>>();
  private readonly refreshing = new Set<string>();

  constructor(
    private readonly client: RAClient,
    private readonly log: Logger,
    private readonly dir: string | undefined,
  ) {}

  // The `-h0` suffix is historical (a hashes variant once existed); kept so existing
  // on-disk caches stay valid.
  private key(consoleId: number, withAchievements: boolean): string {
    return `c${consoleId}-f${withAchievements ? 1 : 0}-h0`;
  }

  /** Returns the catalog if it is already in memory and servable (no I/O). */
  peek(consoleId: number, withAchievements: boolean): readonly CatalogGame[] | undefined {
    const s = this.mem.get(this.key(consoleId, withAchievements));
    return s && Date.now() - s.fetched < MAX_STALE_MS ? s.games : undefined;
  }

  get(consoleId: number, withAchievements: boolean): Promise<readonly CatalogGame[]> {
    const k = this.key(consoleId, withAchievements);
    const warm = this.mem.get(k);
    if (warm && this.serveable(k, warm, consoleId, withAchievements)) {
      return Promise.resolve(warm.games);
    }
    const pending = this.loading.get(k);
    if (pending) return pending;
    const p = this.load(k, consoleId, withAchievements).finally(() => this.loading.delete(k));
    this.loading.set(k, p);
    return p;
  }

  /** Servable now? Kicks off a background refresh when stale-but-usable. */
  private serveable(k: string, s: Stored, consoleId: number, f: boolean): boolean {
    const age = Date.now() - s.fetched;
    if (age >= MAX_STALE_MS) return false;
    if (age >= REFRESH_AFTER_MS) this.refreshInBackground(k, consoleId, f);
    return true;
  }

  private readonly lastRefreshAttempt = new Map<string, number>();

  private refreshInBackground(k: string, consoleId: number, f: boolean): void {
    if (this.refreshing.has(k)) return;
    // Back off after an attempt (successful or not): while RA is down or rate-limiting,
    // every find_games call would otherwise launch a fresh ~50-console refresh round.
    const last = this.lastRefreshAttempt.get(k) ?? 0;
    if (Date.now() - last < REFRESH_RETRY_MS) return;
    this.lastRefreshAttempt.set(k, Date.now());
    this.refreshing.add(k);
    void this.fetchUpstream(k, consoleId, f)
      .catch((e: unknown) =>
        this.log.warn('catalog background refresh failed', { consoleId, error: e }),
      )
      .finally(() => this.refreshing.delete(k));
  }

  private async load(
    k: string,
    consoleId: number,
    withAchievements: boolean,
  ): Promise<readonly CatalogGame[]> {
    const disk = this.mem.get(k) ?? (await this.readDisk(k));
    if (disk && this.serveable(k, disk, consoleId, withAchievements)) {
      this.mem.set(k, disk);
      return disk.games;
    }
    try {
      return await this.fetchUpstream(k, consoleId, withAchievements);
    } catch (e) {
      if (!disk) throw e;
      // Upstream down: a week-plus-old index still answers "what's the game ID".
      this.log.warn('catalog refresh failed; serving stale copy', {
        consoleId,
        ageHours: Math.round((Date.now() - disk.fetched) / 3_600_000),
        error: e,
      });
      this.mem.set(k, disk);
      return disk.games;
    }
  }

  private async fetchUpstream(
    k: string,
    consoleId: number,
    withAchievements: boolean,
  ): Promise<readonly CatalogGame[]> {
    // TTL.none: this store owns catalog caching; don't also hold it in the LRU.
    const raw =
      (await this.client.get<CatalogGame[] | null>(
        'GetGameList',
        { i: consoleId, f: withAchievements },
        TTL.none,
      )) ?? [];
    const stored: Stored = { fetched: Date.now(), games: project(raw) };
    this.mem.set(k, stored);
    void this.writeDisk(k, stored);
    return stored.games;
  }

  /**
   * Load many catalogs within `budgetMs`. Loads that miss the budget CONTINUE in the
   * background (so the next call finds them warm); the result reports which consoles
   * are still `loading` and which `failed`.
   */
  async getMany(
    consoleIds: number[],
    withAchievements: boolean,
    budgetMs: number,
  ): Promise<{ games: CatalogGame[]; loading: number[]; failed: number[] }> {
    const done = new Map<number, readonly CatalogGame[]>();
    const failed = new Set<number>();
    const all = consoleIds.map(id =>
      this.get(id, withAchievements).then(
        g => void done.set(id, g),
        (e: unknown) => {
          failed.add(id);
          this.log.warn('catalog load failed', { consoleId: id, error: e });
        },
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(all),
      new Promise<void>(r => {
        timer = setTimeout(r, budgetMs);
      }),
    ]);
    clearTimeout(timer);
    return {
      games: consoleIds.flatMap(id => done.get(id) ?? []),
      loading: consoleIds.filter(id => !done.has(id) && !failed.has(id)),
      failed: consoleIds.filter(id => failed.has(id)),
    };
  }

  private async readDisk(k: string): Promise<Stored | undefined> {
    if (!this.dir) return undefined;
    try {
      const s = JSON.parse(await readFile(join(this.dir, `${k}.json`), 'utf8')) as Stored;
      return typeof s.fetched === 'number' && Array.isArray(s.games)
        ? { fetched: s.fetched, games: project(s.games) }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeDisk(k: string, s: Stored): Promise<void> {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, `${k}.json.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(s));
      await rename(tmp, join(this.dir, `${k}.json`));
    } catch (e) {
      // Persistence is an optimisation; a read-only FS must not break the tool.
      this.log.debug('catalog cache write failed', e);
    }
  }
}
