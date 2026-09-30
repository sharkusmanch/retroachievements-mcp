import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TTL, type RAClient } from './client.js';
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
  Hashes?: string[];
}

interface Stored {
  fetched: number;
  games: CatalogGame[];
}

/** Catalog lifetime. Sets are added/revised daily at most; a day-old index is fine for search. */
const CATALOG_MAX_AGE_MS = 24 * 3600 * 1000;

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
  private readonly loading = new Map<string, Promise<CatalogGame[]>>();

  constructor(
    private readonly client: RAClient,
    private readonly log: Logger,
    private readonly dir: string | undefined,
  ) {}

  private key(consoleId: number, withAchievements: boolean, hashes: boolean): string {
    return `c${consoleId}-f${withAchievements ? 1 : 0}-h${hashes ? 1 : 0}`;
  }

  /** Returns the catalog if it is already in memory and fresh (no I/O). */
  peek(consoleId: number, withAchievements: boolean, hashes: boolean): CatalogGame[] | undefined {
    const s = this.mem.get(this.key(consoleId, withAchievements, hashes));
    return s && Date.now() - s.fetched < CATALOG_MAX_AGE_MS ? s.games : undefined;
  }

  get(consoleId: number, withAchievements: boolean, hashes: boolean): Promise<CatalogGame[]> {
    const k = this.key(consoleId, withAchievements, hashes);
    const warm = this.peek(consoleId, withAchievements, hashes);
    if (warm) return Promise.resolve(warm);
    const pending = this.loading.get(k);
    if (pending) return pending;
    const p = this.load(k, consoleId, withAchievements, hashes).finally(() =>
      this.loading.delete(k),
    );
    this.loading.set(k, p);
    return p;
  }

  private async load(
    k: string,
    consoleId: number,
    withAchievements: boolean,
    hashes: boolean,
  ): Promise<CatalogGame[]> {
    const disk = await this.readDisk(k);
    if (disk && Date.now() - disk.fetched < CATALOG_MAX_AGE_MS) {
      this.mem.set(k, disk);
      return disk.games;
    }
    // TTL.none: this store owns catalog caching; don't also hold it in the LRU.
    const games =
      (await this.client.get<CatalogGame[] | null>(
        'GetGameList',
        { i: consoleId, f: withAchievements, h: hashes },
        TTL.none,
      )) ?? [];
    const stored = { fetched: Date.now(), games };
    this.mem.set(k, stored);
    void this.writeDisk(k, stored);
    return games;
  }

  /**
   * Load many catalogs within `budgetMs`. Loads that miss the budget CONTINUE in the
   * background (so the next call finds them warm); the result reports what is missing.
   */
  async getMany(
    consoleIds: number[],
    withAchievements: boolean,
    hashes: boolean,
    budgetMs: number,
  ): Promise<{ games: CatalogGame[]; missing: number[] }> {
    const done = new Map<number, CatalogGame[]>();
    const all = consoleIds.map(id =>
      this.get(id, withAchievements, hashes).then(
        g => void done.set(id, g),
        e => this.log.warn('catalog load failed', { consoleId: id, error: e as unknown }),
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
      missing: consoleIds.filter(id => !done.has(id)),
    };
  }

  private async readDisk(k: string): Promise<Stored | undefined> {
    if (!this.dir) return undefined;
    try {
      const s = JSON.parse(await readFile(join(this.dir, `${k}.json`), 'utf8')) as Stored;
      return typeof s.fetched === 'number' && Array.isArray(s.games) ? s : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeDisk(k: string, s: Stored): Promise<void> {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, `${k}.json.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify(s));
      await rename(tmp, join(this.dir, `${k}.json`));
    } catch (e) {
      // Persistence is an optimisation; a read-only FS must not break the tool.
      this.log.debug('catalog cache write failed', e);
    }
  }
}
