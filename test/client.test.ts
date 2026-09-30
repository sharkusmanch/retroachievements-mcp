import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENDPOINT_TTL,
  RAClient,
  RAError,
  REQUEST_DEADLINE_MS,
  TTL,
  cacheKey,
} from '../src/client.js';
import { createLogger, registerSecret } from '../src/logger.js';

const KEY = 'SuperSecretApiKey0123456789abcdef';
registerSecret(KEY);

type Cfg = ConstructorParameters<typeof RAClient>[0];
const baseCfg: Cfg = {
  RA_API_KEY: KEY,
  RA_BASE_URL: 'https://ra.test',
  RA_TIMEOUT_MS: 1000,
  RA_MAX_CONCURRENCY: 4,
  RA_CACHE_MAX_ENTRIES: 500,
  RA_CACHE_TTL_SCALE: 1,
  RA_RATE_PER_MINUTE: 600,
  RA_RATE_BURST: 60,
};

type FetchFn = (url: URL, init?: RequestInit) => Promise<Response>;

function setup(fn: FetchFn, cfg: Partial<Cfg> = {}) {
  const lines: string[] = [];
  const log = createLogger('debug', l => lines.push(l));
  const fetchMock = vi.fn(fn);
  const client = new RAClient({ ...baseCfg, ...cfg }, log, fetchMock as unknown as typeof fetch);
  return { client, fetchMock, lines };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending microtasks (and the async hops inside the client) drain. */
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const calledUrl = (m: ReturnType<typeof setup>['fetchMock'], i = 0): URL => {
  const call = m.mock.calls[i];
  if (!call) throw new Error(`no fetch call #${i}`);
  return call[0];
};

afterEach(() => {
  vi.useRealTimers();
});

describe('request construction', () => {
  it('builds the endpoint URL with the key as y= and sends JSON accept + UA', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(json({ ok: 1 })));
    await expect(client.get('GetGame', { i: 1 }, TTL.game)).resolves.toEqual({ ok: 1 });
    const url = calledUrl(fetchMock);
    expect(url.origin + url.pathname).toBe('https://ra.test/API/API_GetGame.php');
    expect(url.searchParams.get('y')).toBe(KEY);
    expect(url.searchParams.get('i')).toBe('1');
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.accept).toBe('application/json');
    expect(headers['user-agent']).toMatch(/retroachievements-mcp/);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('drops undefined and empty params and maps booleans to 1/0', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(json([])));
    await client.get('GetGameList', { i: 5, f: true, h: false, u: undefined, z: '' }, TTL.none);
    const sp = calledUrl(fetchMock).searchParams;
    expect(sp.get('f')).toBe('1');
    expect(sp.get('h')).toBe('0');
    expect(sp.has('u')).toBe(false);
    expect(sp.has('z')).toBe(false);
    expect([...sp.keys()].sort()).toEqual(['f', 'h', 'i', 'y']);
  });

  it('canonicalises cache keys: order-insensitive, blanks dropped, booleans as 1/0', () => {
    expect(cacheKey('X', { b: 2, a: 1 })).toBe(cacheKey('X', { a: 1, b: 2 }));
    expect(cacheKey('X', { a: 1, u: undefined, e: '' })).toBe(cacheKey('X', { a: 1 }));
    expect(cacheKey('X', { f: true, h: false })).toBe(cacheKey('X', { f: 1, h: 0 }));
    expect(cacheKey('X', { a: 1 })).not.toBe(cacheKey('Y', { a: 1 }));
    expect(cacheKey('X', { a: 1 })).toBe('X?a=1');
  });
});

describe('cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('serves a hit within TTL and refetches after expiry', async () => {
    let n = 0;
    const { client, fetchMock } = setup(() => Promise.resolve(json({ n: ++n })));
    expect(await client.get('GetUserProfile', { u: 'a' }, TTL.user)).toEqual({ n: 1 });
    expect(await client.get('GetUserProfile', { u: 'a' }, TTL.user)).toEqual({ n: 1 });
    expect(client.stats.cacheHits).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TTL.user * 1000 - 1);
    expect(await client.get('GetUserProfile', { u: 'a' }, TTL.user)).toEqual({ n: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    expect(client.peek('GetUserProfile', { u: 'a' })).toBeUndefined();
    expect(await client.get('GetUserProfile', { u: 'a' }, TTL.user)).toEqual({ n: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats param order as the same cache entry', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(json({})));
    await client.get('GetGame', { i: 1, x: 'a' }, TTL.game);
    await client.get('GetGame', { x: 'a', i: 1, junk: undefined }, TTL.game);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('peek returns warm values without fetching', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(json({ v: 1 })));
    expect(client.peek('GetGame', { i: 1 })).toBeUndefined();
    await client.get('GetGame', { i: 1 }, TTL.game);
    expect(client.peek('GetGame', { i: 1 })).toEqual({ v: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TTL.none and RA_CACHE_TTL_SCALE=0 bypass the cache', async () => {
    const a = setup(() => Promise.resolve(json({})));
    await a.client.get('GetGame', { i: 1 }, TTL.none);
    await a.client.get('GetGame', { i: 1 }, TTL.none);
    expect(a.fetchMock).toHaveBeenCalledTimes(2);

    const b = setup(() => Promise.resolve(json({})), { RA_CACHE_TTL_SCALE: 0 });
    await b.client.get('GetGame', { i: 1 }, TTL.static);
    await b.client.get('GetGame', { i: 1 }, TTL.static);
    expect(b.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('RA_CACHE_TTL_SCALE multiplies lifetimes', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(json({})), {
      RA_CACHE_TTL_SCALE: 0.5,
    });
    await client.get('GetGame', { i: 1 }, 10);
    vi.advanceTimersByTime(4_999);
    await client.get('GetGame', { i: 1 }, 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await client.get('GetGame', { i: 1 }, 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('RA_CACHE_MAX_ENTRIES=0 disables storage', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(json({})), {
      RA_CACHE_MAX_ENTRIES: 0,
    });
    await client.get('GetGame', { i: 1 }, TTL.game);
    await client.get('GetGame', { i: 1 }, TTL.game);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used entry at RA_CACHE_MAX_ENTRIES', async () => {
    const { client, fetchMock } = setup(
      url => Promise.resolve(json({ i: url.searchParams.get('i') })),
      { RA_CACHE_MAX_ENTRIES: 2 },
    );
    await client.get('GetGame', { i: 'a' }, TTL.game);
    await client.get('GetGame', { i: 'b' }, TTL.game);
    await client.get('GetGame', { i: 'a' }, TTL.game); // hit → a is now most recent
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await client.get('GetGame', { i: 'c' }, TTL.game); // evicts b
    expect(client.peek('GetGame', { i: 'b' })).toBeUndefined();
    expect(client.peek('GetGame', { i: 'a' })).toEqual({ i: 'a' });
    expect(client.peek('GetGame', { i: 'c' })).toEqual({ i: 'c' });
    await client.get('GetGame', { i: 'a' }, TTL.game);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await client.get('GetGame', { i: 'b' }, TTL.game);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses the per-endpoint default TTL when none is passed', async () => {
    expect(ENDPOINT_TTL.GetUserAwards).toBe(600);
    expect(ENDPOINT_TTL.GetGameProgression).toBeGreaterThanOrEqual(TTL.game);
    expect(Object.keys(ENDPOINT_TTL)).toHaveLength(38);
    vi.useFakeTimers();
    const { client, fetchMock } = setup(() => Promise.resolve(json({ ok: 1 })));
    await client.get('GetUserAwards', { u: 'x' });
    vi.advanceTimersByTime(599_000);
    await client.get('GetUserAwards', { u: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await client.get('GetUserAwards', { u: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Unknown endpoint → TTL.feed.
    await client.get('GetSomethingNew', {});
    vi.advanceTimersByTime(299_000);
    await client.get('GetSomethingNew', {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never caches a body over 1 MB', async () => {
    const big = JSON.stringify({ x: 'y'.repeat(1024 * 1024) });
    const { client, fetchMock } = setup(() => Promise.resolve(new Response(big)));
    await client.get('GetGame', { i: 1 }, TTL.game);
    await client.get('GetGame', { i: 1 }, TTL.game);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.cacheSize().entries).toBe(0);
  });

  it('evicts LRU entries to stay under RA_CACHE_MAX_BYTES', async () => {
    const body = JSON.stringify({ x: 'y'.repeat(990) }); // ~1000 bytes
    const { client, fetchMock } = setup(() => Promise.resolve(new Response(body)), {
      RA_CACHE_MAX_BYTES: 2500,
    });
    for (const i of [1, 2, 3]) await client.get('GetGame', { i }, TTL.game);
    expect(client.cacheSize().entries).toBe(2);
    expect(client.cacheSize().bytes).toBeLessThanOrEqual(2500);
    await client.get('GetGame', { i: 3 }, TTL.game); // still cached
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await client.get('GetGame', { i: 1 }, TTL.game); // evicted
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not cache failures', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(new Response('', { status: 404 })));
    await expect(client.get('GetGame', { i: 1 }, TTL.game)).rejects.toBeInstanceOf(RAError);
    await expect(client.get('GetGame', { i: 1 }, TTL.game)).rejects.toBeInstanceOf(RAError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('coalescing and concurrency', () => {
  it('coalesces concurrent identical requests into one fetch', async () => {
    const d = deferred<Response>();
    const { client, fetchMock } = setup(() => d.promise);
    const a = client.get('GetGame', { i: 1, f: true }, TTL.game);
    const b = client.get('GetGame', { f: 1, i: 1 }, TTL.game);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.stats.coalesced).toBe(1);
    d.resolve(json({ ok: true }));
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(client.stats.upstreamCalls).toBe(1);
  });

  it('coalesces even with TTL.none, then refetches once settled', async () => {
    const { client, fetchMock } = setup(() => Promise.resolve(json({})));
    await Promise.all([
      client.get('GetGame', { i: 1 }, TTL.none),
      client.get('GetGame', { i: 1 }, TTL.none),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await client.get('GetGame', { i: 1 }, TTL.none);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares a rejection between coalesced callers', async () => {
    const { client } = setup(() => Promise.resolve(new Response('', { status: 401 })));
    const r = await Promise.allSettled([
      client.get('GetGame', { i: 1 }, TTL.game),
      client.get('GetGame', { i: 1 }, TTL.game),
    ]);
    expect(r.map(x => x.status)).toEqual(['rejected', 'rejected']);
  });

  it('never exceeds RA_MAX_CONCURRENCY in-flight fetches', async () => {
    let active = 0;
    let peak = 0;
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const { client, fetchMock } = setup(
      async () => {
        active++;
        peak = Math.max(peak, active);
        const g = deferred<void>();
        gates.push(g);
        await g.promise;
        active--;
        return json({});
      },
      { RA_MAX_CONCURRENCY: 2 },
    );
    const all = Promise.all([1, 2, 3, 4, 5].map(i => client.get('GetGame', { i }, TTL.game)));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (let released = 0; released < 5; released++) {
      await flush();
      gates[released]?.resolve();
    }
    await all;
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  /**
   * Regression: the semaphore used to decrement on release and let the woken waiter
   * re-increment a microtask later. A request arriving in that gap saw a free slot, so
   * both it and the waiter ran — exceeding the ceiling. Probe every gap position.
   */
  it('does not let a new request jump the slot handed to a queued waiter', async () => {
    for (let hops = 0; hops < 40; hops++) {
      let active = 0;
      let peak = 0;
      const gates = new Map<string, ReturnType<typeof deferred<void>>>();
      const { client } = setup(
        async url => {
          active++;
          peak = Math.max(peak, active);
          const g = deferred<void>();
          gates.set(url.searchParams.get('i') ?? '', g);
          await g.promise;
          active--;
          return json({});
        },
        { RA_MAX_CONCURRENCY: 1 },
      );
      const a = client.get('GetGame', { i: 'a' }, TTL.game);
      const b = client.get('GetGame', { i: 'b' }, TTL.game); // queued waiter
      await flush();
      let c: Promise<unknown> | undefined;
      // Schedule a fresh request `hops` microtasks after A is released.
      void (async () => {
        for (let i = 0; i < hops; i++) await Promise.resolve();
        c = client.get('GetGame', { i: 'c' }, TTL.game);
      })();
      gates.get('a')?.resolve();
      await a;
      await flush(60);
      for (const k of ['b', 'c']) {
        gates.get(k)?.resolve();
        await flush(60);
      }
      await b;
      await c;
      expect({ hops, peak }).toEqual({ hops, peak: 1 });
    }
  });
});

describe('token-bucket pacing', () => {
  it('allows a burst, then paces at RA_RATE_PER_MINUTE', async () => {
    vi.useFakeTimers();
    const { client, fetchMock } = setup(() => Promise.resolve(json({})), {
      RA_RATE_PER_MINUTE: 60, // one per second
      RA_RATE_BURST: 2,
    });
    const all = Promise.all([1, 2, 3, 4].map(i => client.get('GetGame', { i }, TTL.game)));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await all;
  });

  it('refills tokens while idle (up to burst)', async () => {
    vi.useFakeTimers();
    const { client, fetchMock } = setup(() => Promise.resolve(json({})), {
      RA_RATE_PER_MINUTE: 60,
      RA_RATE_BURST: 2,
    });
    await Promise.all([1, 2].map(i => client.get('GetGame', { i }, TTL.none)));
    vi.advanceTimersByTime(60_000); // would be 60 tokens without the burst cap
    const all = Promise.all([3, 4, 5].map(i => client.get('GetGame', { i }, TTL.none)));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await all;
  });
});

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('retries 429 honouring Retry-After seconds', async () => {
    const responses = [json({}, 429, { 'retry-after': '3' }), json({ ok: 1 })];
    const { client, fetchMock, lines } = setup(() => Promise.resolve(responses.shift()!));
    const p = client.get('GetGame', { i: 1 }, TTL.game);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await p).toEqual({ ok: 1 });
    expect(lines.some(l => l.includes('upstream retry') && l.includes('"wait":3000'))).toBe(true);
  });

  it('honours an HTTP-date Retry-After and caps it at 10s', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toUTCString();
    const responses = [json({}, 503, { 'retry-after': future }), json({ ok: 1 })];
    const { client, fetchMock } = setup(() => Promise.resolve(responses.shift()!));
    const p = client.get('GetGame', { i: 1 }, TTL.game);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await p;
  });

  it('backs off exponentially on 5xx without Retry-After', async () => {
    const responses = [json({}, 502), json({}, 500), json({ ok: 1 })];
    const { client, fetchMock } = setup(() => Promise.resolve(responses.shift()!));
    const p = client.get('GetGame', { i: 1 }, TTL.game);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await p).toEqual({ ok: 1 });
  });

  it('gives up after 4 attempts with the last status', async () => {
    const { client, fetchMock } = setup(() =>
      Promise.resolve(json({ message: 'Too many requests' }, 429)),
    );
    const p = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as RAError;
    expect(err).toBeInstanceOf(RAError);
    expect(err.status).toBe(429);
    expect(err.endpoint).toBe('GetGame');
    expect(err.message).toBe('Too many requests');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a 429 pauses the shared bucket: queued requests wait out the window', async () => {
    const { client, fetchMock } = setup(url =>
      Promise.resolve(
        url.searchParams.get('i') === '1' && fetchMock.mock.calls.length === 1
          ? json({}, 429, { 'retry-after': '3' })
          : json({ ok: 1 }),
      ),
    );
    const a = client.get('GetGame', { i: 1 }, TTL.game);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const b = client.get('GetGame', { i: 2 }, TTL.game);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1); // b held by the cooldown
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // a's retry gets the single token
    await vi.advanceTimersByTimeAsync(100); // then pacing resumes (600/min)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await a).toEqual({ ok: 1 });
    expect(await b).toEqual({ ok: 1 });
  });

  it('a 429 on the final attempt still starts the shared cooldown', async () => {
    const { client, fetchMock } = setup(url =>
      Promise.resolve(
        url.searchParams.get('i') === '1'
          ? json({ message: 'Too many requests' }, 429, { 'retry-after': '3' })
          : json({ ok: 1 }),
      ),
    );
    const a = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
    // Four 429s, each followed by a 3s cooldown: the last one is not retried...
    await vi.advanceTimersByTimeAsync(9_001);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(((await a) as RAError).status).toBe(429);
    // ...but it still holds back the next request for the window.
    const b = client.get('GetGame', { i: 2 }, TTL.game);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await b).toEqual({ ok: 1 });
  });

  it('stops retrying when the next attempt would pass the overall deadline', async () => {
    const { client, fetchMock } = setup(
      () =>
        new Promise<Response>(r =>
          setTimeout(() => r(json({ message: 'busy' }, 503, { 'retry-after': '10' })), 12_000),
        ),
      { RA_TIMEOUT_MS: 20_000 },
    );
    const p = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as RAError;
    expect(err.status).toBe(503);
    expect(err.message).toBe('busy');
    // 0→12s fail, wait 10 → 22→34s fail; 34+10 > 35 → give up.
    expect(REQUEST_DEADLINE_MS).toBe(35_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('does not retry %i', async status => {
    const { client, fetchMock } = setup(() => Promise.resolve(json({}, status)));
    const p = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await p).toBeInstanceOf(RAError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('response handling', () => {
  const errOf = async (res: () => Response) => {
    const { client } = setup(() => Promise.resolve(res()));
    return (await client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e)) as RAError;
  };

  it('401 → fixed key-rejected message', async () => {
    const e = await errOf(() => json({ message: 'Unauthenticated.' }, 401));
    expect(e).toBeInstanceOf(RAError);
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/API key rejected/);
  });

  it('404 → not found (non-JSON body)', async () => {
    const e = await errOf(() => new Response('<html>nope</html>', { status: 404 }));
    expect(e.status).toBe(404);
    expect(e.message).toBe('not found');
  });

  it('404 with a JSON message → the body text', async () => {
    const e = await errOf(() => json({ message: 'Game not found.' }, 404));
    expect(e.message).toBe('Game not found.');
  });

  it('array-of-strings body → joined message (capped at 300)', async () => {
    const e = await errOf(() => json(['User has no leaderboards on this game', 'second'], 422));
    expect(e.message).toBe('User has no leaderboards on this game; second');
    const long = await errOf(() => json(['a'.repeat(200), 'b'.repeat(200)], 422));
    expect(long.message).toHaveLength(300);
    const junk = await errOf(() => json([1, null], 422));
    expect(junk.message).toBe('HTTP 422');
  });

  it('401 keeps its fixed text even with a body message', async () => {
    const e = await errOf(() => json(['nope'], 401));
    expect(e.message).toMatch(/API key rejected/);
  });

  it('deep-freezes parsed bodies (cache values are shared)', async () => {
    const { client } = setup(() => Promise.resolve(json({ a: [{ b: 1 }], c: { d: [2, 1] } })));
    const v = await client.get<{ a: { b: number }[]; c: { d: number[] } }>(
      'GetGame',
      { i: 1 },
      TTL.game,
    );
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.a[0])).toBe(true);
    expect(() => v.c.d.sort()).toThrow(TypeError);
    const again = await client.get<typeof v>('GetGame', { i: 1 }, TTL.game);
    expect(again.c.d).toEqual([2, 1]);
  });

  it('422 → body message (truncated to 300 chars)', async () => {
    const e = await errOf(() => json({ message: 'The i field is required.' }, 422));
    expect(e.status).toBe(422);
    expect(e.message).toBe('The i field is required.');
    const long = await errOf(() => json({ message: 'x'.repeat(1000) }, 422));
    expect(long.message).toHaveLength(300);
  });

  it('non-JSON error body → HTTP <status>', async () => {
    const e = await errOf(() => new Response('<html>bad</html>', { status: 400 }));
    expect(e.message).toBe('HTTP 400');
  });

  it('empty / whitespace 200 body → null', async () => {
    const { client } = setup(() => Promise.resolve(new Response('  \n', { status: 200 })));
    expect(await client.get('GetGame', { i: 1 }, TTL.game)).toBeNull();
  });

  it('non-JSON 200 → RAError, not retried', async () => {
    const { client, fetchMock } = setup(() =>
      Promise.resolve(new Response('<html>cloudflare</html>', { status: 200 })),
    );
    const e = (await client.get('GetGame', { i: 1 }, TTL.game).catch((x: unknown) => x)) as RAError;
    expect(e).toBeInstanceOf(RAError);
    expect(e.message).toBe('upstream returned non-JSON');
    expect(e.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('network errors and secret hygiene', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** A fetch that fails the way undici does, with the full keyed URL in message + cause. */
  const leakyFetch: FetchFn = url => {
    const href = url.toString();
    expect(href).toContain(KEY); // precondition: the URL really carries the key
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${href}`), {
      code: 'ECONNREFUSED',
      url: href,
    });
    return Promise.reject(new TypeError(`fetch failed for ${href}`, { cause }));
  };

  it('retries, then throws a URL-free RAError and never logs the key', async () => {
    const { client, fetchMock, lines } = setup(leakyFetch);
    const p = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as RAError;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(err).toBeInstanceOf(RAError);
    expect(err.status).toBe(0);
    expect(err.message).toBe('request network error');
    for (const s of [err.message, String(err), err.stack ?? '', JSON.stringify(err)]) {
      expect(s).not.toContain(KEY);
      expect(s).not.toContain('ra.test');
    }
    expect(lines.length).toBe(3); // one warn per retry
    const all = lines.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).toContain('[REDACTED]');
    expect(all).toContain('ECONNREFUSED'); // the useful part survives redaction
  });

  it('reports timeouts as "request timed out"', async () => {
    const { client } = setup(() =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );
    const p = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as RAError;
    expect(err).toBeInstanceOf(RAError);
    expect(err.message).toBe('request timed out');
  });

  it('retries a timeout only once', async () => {
    const { client, fetchMock } = setup(() =>
      Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );
    const p = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when a later attempt succeeds', async () => {
    let n = 0;
    const { client } = setup(url => (++n < 3 ? leakyFetch(url) : Promise.resolve(json([1]))));
    const p = client.get('GetGame', { i: 1 }, TTL.game);
    await vi.runAllTimersAsync();
    expect(await p).toEqual([1]);
  });

  it('never puts the key in any RAError message across failure modes', async () => {
    const bodies: (() => Promise<Response>)[] = [
      () => Promise.resolve(new Response('not json', { status: 200 })),
      () => Promise.resolve(json({}, 401)),
      () => Promise.resolve(json({}, 404)),
      () => Promise.resolve(json({ message: 'bad' }, 422)),
      () => Promise.resolve(json({}, 503)),
    ];
    for (const b of bodies) {
      const { client, lines } = setup(b);
      const p = client.get('GetGame', { i: 1 }, TTL.game).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = (await p) as RAError;
      expect(err).toBeInstanceOf(RAError);
      expect(err.message).not.toContain(KEY);
      expect(lines.join('\n')).not.toContain(KEY);
    }
  });
});
