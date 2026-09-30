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
    expect(store.peek(7, true, false)).toBeUndefined();
    expect(await store.get(7, true, false)).toEqual([game(1, 7)]);
    expect(get).toHaveBeenCalledWith('GetGameList', { i: 7, f: true, h: false }, TTL.none);
    expect(store.peek(7, true, false)).toEqual([game(1, 7)]);
    await store.get(7, true, false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keys by (console, withAchievements, hashes)', async () => {
    const { client, get } = fakeClient(() => Promise.resolve([]));
    const store = new CatalogStore(client, capLog().log, undefined);
    await store.get(1, true, false);
    await store.get(1, false, false);
    await store.get(1, true, true);
    await store.get(2, true, false);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('treats a null upstream body as an empty catalog', async () => {
    const { client } = fakeClient(() => Promise.resolve(null));
    const store = new CatalogStore(client, capLog().log, undefined);
    expect(await store.get(1, true, false)).toEqual([]);
  });

  it('coalesces concurrent loads of the same catalog', async () => {
    const d = deferred<CatalogGame[]>();
    const { client, get } = fakeClient(() => d.promise);
    const store = new CatalogStore(client, capLog().log, undefined);
    const a = store.get(3, true, false);
    const b = store.get(3, true, false);
    d.resolve([game(9, 3)]);
    expect(await a).toEqual(await b);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('memory expires after a day', async () => {
    vi.useFakeTimers();
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 1)]));
    const store = new CatalogStore(client, capLog().log, undefined);
    await store.get(1, true, false);
    vi.advanceTimersByTime(DAY - 1);
    expect(store.peek(1, true, false)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(store.peek(1, true, false)).toBeUndefined();
    await store.get(1, true, false);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a failed load rejects and is retried on the next call', async () => {
    let n = 0;
    const { client, get } = fakeClient(() =>
      ++n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve([game(1, 1)]),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    await expect(store.get(1, true, false)).rejects.toThrow('boom');
    expect(await store.get(1, true, false)).toEqual([game(1, 1)]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('undefined dir = memory only (nothing written anywhere)', async () => {
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 1)]));
    await new CatalogStore(client, capLog().log, undefined).get(1, true, false);
    // A fresh store has no persistence to fall back on → upstream again.
    await new CatalogStore(client, capLog().log, undefined).get(1, true, false);
    expect(get).toHaveBeenCalledTimes(2);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('disk layer', () => {
  const file = (k = 'c7-f1-h0') => join(dir, `${k}.json`);

  it('writes atomically to the cache dir (no tmp files left behind)', async () => {
    const { client } = fakeClient(() => Promise.resolve([game(1, 7)]));
    const store = new CatalogStore(client, capLog().log, join(dir, 'nested', 'deeper'));
    await store.get(7, true, false);
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

    expect(await store.get(7, true, false)).toEqual([game(42, 7)]); // disk
    expect(get).not.toHaveBeenCalled();

    await rm(file());
    expect(await store.get(7, true, false)).toEqual([game(42, 7)]); // memory
    expect(get).not.toHaveBeenCalled();

    const fresh = new CatalogStore(client, capLog().log, dir);
    expect(await fresh.get(7, true, false)).toEqual([game(1, 7)]); // upstream
    expect(get).toHaveBeenCalledTimes(1);
    await waitFor(() => exists(file())); // let the background write land before cleanup
  });

  it('ignores a stale disk entry and refreshes it', async () => {
    await writeFile(
      file(),
      JSON.stringify({ fetched: Date.now() - DAY - 1, games: [game(42, 7)] }),
    );
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 7)]));
    const store = new CatalogStore(client, capLog().log, dir);
    expect(await store.get(7, true, false)).toEqual([game(1, 7)]);
    expect(get).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      const s = JSON.parse(await readFile(file(), 'utf8')) as { games: CatalogGame[] };
      return s.games[0]?.ID === 1;
    });
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['wrong shape', JSON.stringify({ fetched: 'yesterday', games: [] })],
    ['missing games', JSON.stringify({ fetched: Date.now() })],
  ])('falls through to upstream on %s', async (_label, body) => {
    await writeFile(file(), body);
    const { client, get } = fakeClient(() => Promise.resolve([game(1, 7)]));
    expect(await new CatalogStore(client, capLog().log, dir).get(7, true, false)).toEqual([
      game(1, 7),
    ]);
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
    expect(await store.get(7, true, false)).toEqual([game(1, 7)]);
    await waitFor(() => lines.some(l => l.includes('catalog cache write failed')));
  });
});

describe('getMany', () => {
  it('returns everything when within budget, in the requested console order', async () => {
    const { client } = fakeClient((_e, p) =>
      Promise.resolve([game(Number(p.i) * 10, Number(p.i))]),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    const r = await store.getMany([3, 1, 2], true, false, 1000);
    expect(r.missing).toEqual([]);
    expect(r.games.map(g => g.ConsoleID)).toEqual([3, 1, 2]);
  });

  it('returns partial results + missing at the budget, and keeps loading in background', async () => {
    const slow = deferred<CatalogGame[]>();
    const { client } = fakeClient((_e, p) =>
      p.i === 2 ? slow.promise : Promise.resolve([game(Number(p.i), Number(p.i))]),
    );
    const store = new CatalogStore(client, capLog().log, undefined);
    const t0 = Date.now();
    const r = await store.getMany([1, 2, 3], true, false, 30);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.missing).toEqual([2]);
    expect(r.games.map(g => g.ID)).toEqual([1, 3]);

    slow.resolve([game(2, 2)]);
    await waitFor(() => store.peek(2, true, false) !== undefined);
    const again = await store.getMany([1, 2, 3], true, false, 30);
    expect(again.missing).toEqual([]);
    expect(again.games.map(g => g.ID)).toEqual([1, 2, 3]);
  });

  it('a failing console is reported missing and logged without breaking the others', async () => {
    const { client } = fakeClient((_e, p) =>
      p.i === 2
        ? Promise.reject(new Error('upstream down'))
        : Promise.resolve([game(Number(p.i), Number(p.i))]),
    );
    const { log, lines } = capLog();
    const store = new CatalogStore(client, log, undefined);
    const r = await store.getMany([1, 2, 3], true, false, 1000);
    expect(r.missing).toEqual([2]);
    expect(r.games.map(g => g.ID)).toEqual([1, 3]);
    expect(lines.some(l => l.includes('catalog load failed') && l.includes('"consoleId":2'))).toBe(
      true,
    );
  });

  it('does not leave a budget timer running once all loads finish', async () => {
    vi.useFakeTimers();
    const { client } = fakeClient(() => Promise.resolve([]));
    const store = new CatalogStore(client, capLog().log, undefined);
    await store.getMany([1], true, false, 60_000);
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
