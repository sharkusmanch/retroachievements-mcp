import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore, defaultCacheDir, type CatalogGame } from '../src/catalog.js';
import { TTL, type Params, type RAClient } from '../src/client.js';
import { createLogger, type Logger } from '../src/logger.js';

const game = (id: number, consoleId: number): CatalogGame => ({
  ID: id,
  Title: `Game ${id}`,
  ConsoleID: consoleId,
  ConsoleName: `Console ${consoleId}`,
});

type GetFn = (endpoint: string, params: Params, ttl: number) => Promise<unknown>;

function fakeClient(fn: GetFn) {
  const get = vi.fn(fn);
  return { client: { get } as unknown as RAClient, get };
}

function capLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger('debug', l => lines.push(l)), lines };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

const exists = (p: string) =>
  readFile(p).then(
    () => true,
    () => false,
  );

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ra-catalog-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const DAY = 24 * 3600 * 1000;

describe('CatalogStore.get', () => {
  it('fetches GetGameList with booleans and TTL.none, then serves from memory', async () => {
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 7)]));
    const store = new CatalogStore(client, capLog().log, undefined);
    expect(store.peek(7, true)).toBeUndefined();
    expect(await store.get(7, true)).toEqual([game(1, 7)]);
    expect(get).toHaveBeenCalledWith('GetGameList', { i: 7, f: true }, TTL.none);
    expect(store.peek(7, true)).toEqual([game(1, 7)]);
    await store.get(7, true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keys by (console, withAchievements)', async () => {
    const { client, get } = fakeClient(() => Promise.resolve([]));
    const store = new CatalogStore(client, capLog().log, undefined);
    await store.get(1, true);
    await store.get(1, false);
    await store.get(1, true);
    await store.get(2, true);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('stores only the searched fields, frozen', async () => {
    const { client } = fakeClient(() =>
      Promise.resolve([
        { ...game(1, 7), NumAchievements: 3, ImageIcon: '/x.png', ForumTopicID: 9, Hashes: ['a'] },
      ]),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    const games = await store.get(7, true);
    expect(games).toEqual([{ ...game(1, 7), NumAchievements: 3 }]);
    expect(Object.keys(games[0] ?? {})).not.toContain('ImageIcon');
    expect(Object.isFrozen(games)).toBe(true);
    expect(Object.isFrozen(games[0])).toBe(true);
  });

  it('treats a null upstream body as an empty catalog', async () => {
    const { client } = fakeClient(() => Promise.resolve(null));
    const store = new CatalogStore(client, capLog().log, undefined);
    expect(await store.get(1, true)).toEqual([]);
  });

  it('coalesces concurrent loads of the same catalog', async () => {
    const d = deferred<CatalogGame[]>();
    const { client, get } = fakeClient(() => d.promise);
    const store = new CatalogStore(client, capLog().log, undefined);
    const a = store.get(3, true);
    const b = store.get(3, true);
    d.resolve([game(9, 3)]);
    expect(await a).toEqual(await b);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('stale-while-revalidate: >1 day serves memory and refreshes in background; >7 days refetches', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { client, get } = fakeClient(() => Promise.resolve([game(++n, 1)]));
    const store = new CatalogStore(client, capLog().log, undefined);
    await store.get(1, true);
    vi.advanceTimersByTime(DAY - 1);
    expect(await store.get(1, true)).toEqual([game(1, 1)]);
    expect(get).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await store.get(1, true)).toEqual([game(1, 1)]); // stale copy, immediately
    expect(get).toHaveBeenCalledTimes(2); // ...while a refresh runs
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.get(1, true)).toEqual([game(2, 1)]);
    expect(get).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(7 * DAY);
    expect(store.peek(1, true)).toBeUndefined();
    expect(await store.get(1, true)).toEqual([game(3, 1)]); // too old: refetched first
  });

  it('backs off background refreshes for 15 minutes after an attempt', async () => {
    vi.useFakeTimers();
    let n = 0;
    const { client, get } = fakeClient(() =>
      ++n === 1 ? Promise.resolve([game(1, 1)]) : Promise.reject(new Error('down')),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    await store.get(1, true);
    vi.advanceTimersByTime(DAY);
    for (let i = 0; i < 5; i++) {
      expect(await store.get(1, true)).toEqual([game(1, 1)]); // stale copy keeps serving
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(get).toHaveBeenCalledTimes(2); // one failed refresh, not five
    vi.advanceTimersByTime(15 * 60_000);
    await store.get(1, true);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('a failed load rejects and is retried on the next call', async () => {
    let n = 0;
    const { client, get } = fakeClient(() =>
      ++n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve([game(1, 1)]),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    await expect(store.get(1, true)).rejects.toThrow('boom');
    expect(await store.get(1, true)).toEqual([game(1, 1)]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('undefined dir = memory only (nothing written anywhere)', async () => {
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 1)]));
    await new CatalogStore(client, capLog().log, undefined).get(1, true);
    // A fresh store has no persistence to fall back on → upstream again.
    await new CatalogStore(client, capLog().log, undefined).get(1, true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('disk layer', () => {
  const file = (k = 'c7-f1-h0') => join(dir, `${k}.json`);

  it('writes atomically to the cache dir (no tmp files left behind)', async () => {
    const { client } = fakeClient(() => Promise.resolve([game(1, 7)]));
    const store = new CatalogStore(client, capLog().log, join(dir, 'nested', 'deeper'));
    await store.get(7, true);
    const target = join(dir, 'nested', 'deeper', 'c7-f1-h0.json');
    await waitFor(() => exists(target));
    const stored = JSON.parse(await readFile(target, 'utf8')) as {
      fetched: number;
      games: unknown;
    };
    expect(stored.games).toEqual([game(1, 7)]);
    expect(Math.abs(stored.fetched - Date.now())).toBeLessThan(5000);
    const files = await readdir(join(dir, 'nested', 'deeper'));
    expect(files).toEqual(['c7-f1-h0.json']);
  });

  it('order is memory → disk → upstream', async () => {
    await writeFile(file(), JSON.stringify({ fetched: Date.now(), games: [game(42, 7)] }));
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 7)]));
    const store = new CatalogStore(client, capLog().log, dir);

    expect(await store.get(7, true)).toEqual([game(42, 7)]); // disk
    expect(get).not.toHaveBeenCalled();

    await rm(file());
    expect(await store.get(7, true)).toEqual([game(42, 7)]); // memory
    expect(get).not.toHaveBeenCalled();

    const fresh = new CatalogStore(client, capLog().log, dir);
    expect(await fresh.get(7, true)).toEqual([game(1, 7)]); // upstream
    expect(get).toHaveBeenCalledTimes(1);
    await waitFor(() => exists(file())); // let the background write land before cleanup
  });

  it('serves a day-old disk entry immediately and refreshes it in the background', async () => {
    await writeFile(
      file(),
      JSON.stringify({ fetched: Date.now() - DAY - 1, games: [game(42, 7)] }),
    );
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 7)]));
    const store = new CatalogStore(client, capLog().log, dir);
    expect(await store.get(7, true)).toEqual([game(42, 7)]);
    expect(get).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      const s = JSON.parse(await readFile(file(), 'utf8')) as { games: CatalogGame[] };
      return s.games[0]?.ID === 1;
    });
    expect(await store.get(7, true)).toEqual([game(1, 7)]);
  });

  it('refetches a week-old disk entry, but serves it if upstream fails', async () => {
    await writeFile(
      file(),
      JSON.stringify({ fetched: Date.now() - 8 * DAY, games: [game(42, 7)] }),
    );
    const { client, get } = fakeClient(() => Promise.reject(new Error('upstream down')));
    const { log, lines } = capLog();
    const store = new CatalogStore(client, log, dir);
    expect(await store.get(7, true)).toEqual([game(42, 7)]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(lines.some(l => l.includes('serving stale copy'))).toBe(true);
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['wrong shape', JSON.stringify({ fetched: 'yesterday', games: [] })],
    ['missing games', JSON.stringify({ fetched: Date.now() })],
  ])('falls through to upstream on %s', async (_label, body) => {
    await writeFile(file(), body);
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 7)]));
    expect(await new CatalogStore(client, capLog().log, dir).get(7, true)).toEqual([game(1, 7)]);
    expect(get).toHaveBeenCalledTimes(1);
    // ...and repairs the bad file with the fresh catalog.
    await waitFor(async () => {
      const txt = await readFile(file(), 'utf8');
      return txt.includes('"games":[{"ID":1');
    });
  });

  it('an unwritable cache dir does not break loading', async () => {
    const blocker = join(dir, 'a-file');
    await writeFile(blocker, 'x');
    const { client } = fakeClient(() => Promise.resolve([game(1, 7)]));
    const { log, lines } = capLog();
    const store = new CatalogStore(client, log, join(blocker, 'sub'));
    expect(await store.get(7, true)).toEqual([game(1, 7)]);
    await waitFor(() => lines.some(l => l.includes('catalog cache write failed')));
  });
});

describe('getMany', () => {
  it('returns everything when within budget, in the requested console order', async () => {
    const { client } = fakeClient((_e, p) =>
      Promise.resolve([game(Number(p.i) * 10, Number(p.i))]),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    const r = await store.getMany([3, 1, 2], true, 1000);
    expect(r.loading).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.games.map(g => g.ConsoleID)).toEqual([3, 1, 2]);
  });

  it('returns partial results + missing at the budget, and keeps loading in background', async () => {
    const slow = deferred<CatalogGame[]>();
    const { client } = fakeClient((_e, p) =>
      p.i === 2 ? slow.promise : Promise.resolve([game(Number(p.i), Number(p.i))]),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    const t0 = Date.now();
    const r = await store.getMany([1, 2, 3], true, 30);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.loading).toEqual([2]);
    expect(r.failed).toEqual([]);
    expect(r.games.map(g => g.ID)).toEqual([1, 3]);

    slow.resolve([game(2, 2)]);
    await waitFor(() => store.peek(2, true) !== undefined);
    const again = await store.getMany([1, 2, 3], true, 30);
    expect(again.loading).toEqual([]);
    expect(again.games.map(g => g.ID)).toEqual([1, 2, 3]);
  });

  it('a failing console is reported as failed (not loading) and logged without breaking the others', async () => {
    const { client } = fakeClient((_e, p) =>
      p.i === 2
        ? Promise.reject(new Error('upstream down'))
        : Promise.resolve([game(Number(p.i), Number(p.i))]),
    );
    const { log, lines } = capLog();
    const store = new CatalogStore(client, log, undefined);
    const r = await store.getMany([1, 2, 3], true, 1000);
    expect(r.failed).toEqual([2]);
    expect(r.loading).toEqual([]);
    expect(r.games.map(g => g.ID)).toEqual([1, 3]);
    expect(lines.some(l => l.includes('catalog load failed') && l.includes('"consoleId":2'))).toBe(
      true,
    );
  });

  it('does not leave a budget timer running once all loads finish', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(() => Promise.resolve([]));
    const store = new CatalogStore(client, capLog().log, undefined);
    await store.getMany([1], true, 60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('defaultCacheDir', () => {
  it('prefers XDG_CACHE_HOME', () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/xdg' })).toBe(join('/xdg', 'retroachievements-mcp'));
  });
  it('falls back to ~/.cache', () => {
    expect(defaultCacheDir({})).toMatch(/\.cache[/\\]retroachievements-mcp$/);
  });
});
