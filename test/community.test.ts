import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { TTL, type RAClient } from '../src/client.js';
import type { CatalogStore } from '../src/catalog.js';
import type { ToolContext } from '../src/tools/common.js';
import { ENDPOINTS, clip, rawText, registerCommunityTools } from '../src/tools/community.js';
import { frozen } from './helpers.js';

// Fresh mock per test (mockReset() on a shared fn made vitest report a caught throw as a failure).
let get = vi.fn();
const noop = () => undefined;

async function connect(defaultUser: string | undefined = 'me') {
  const ctx: ToolContext = {
    client: {
      get: (...a: unknown[]) => Promise.resolve(get(...a) as unknown).then(frozen),
    } as unknown as RAClient,
    catalog: {} as CatalogStore,
    log: { debug: noop, info: noop, warn: noop, error: noop },
    defaultUser,
  };
  const server = new McpServer({ name: 't', version: '0' });
  registerCommunityTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(name: string, args: Record<string, unknown>, user?: string) {
  const client = await connect(user);
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[]).map(c => c.text).join('');
  await client.close();
  return { isError: r.isError === true, text, json: r.isError ? {} : parse(text) };
}

function parse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeEach(() => {
  get = vi.fn();
});

// ---------- get_feed ----------

describe('get_feed', () => {
  const aotw = {
    Achievement: {
      ID: 1,
      Title: 'Ach',
      Description: 'Do it',
      Points: 3,
      TrueRatio: 4,
      Type: 'progression',
      Author: 'dev',
      AuthorULID: 'ULIDXXXX',
      BadgeURL: '/Badge/1.png',
    },
    Console: { ID: 21, Title: 'PlayStation 2' },
    ForumTopic: { ID: 9 },
    Game: { ID: 20, Title: 'Game' },
    StartAt: '2026-09-28T00:00:00.000000Z',
    TotalPlayers: 100,
    Unlocks: Array.from({ length: 30 }, (_, i) => ({
      User: `u${i}`,
      ULID: 'ULID',
      RAPoints: i,
      RASoftcorePoints: 0,
      HardcoreMode: 1,
      DateAwarded: `2026-09-${String(28 + (i % 2)).padStart(2, '0')}T00:${String(i).padStart(2, '0')}:00.000000Z`,
    })),
    UnlocksCount: 30,
    UnlocksHardcoreCount: 30,
  };

  it('aotw: header + only the newest `limit` unlocks, no ULIDs/images', async () => {
    get.mockResolvedValue(aotw);
    const { json, text } = await call('get_feed', { kind: 'aotw', limit: 3 });
    expect(get).toHaveBeenCalledWith('GetAchievementOfTheWeek', {}, TTL.feed);
    expect(json.achievement).toEqual({
      id: 1,
      title: 'Ach',
      description: 'Do it',
      points: 3,
      retro: 4,
      type: 'progression',
      author: 'dev',
    });
    expect(json.unlocks_hc).toBe(30);
    expect(json.hardcore_unlocks).toBeUndefined();
    expect(json.game).toEqual({ id: 20, title: 'Game', console: 'PlayStation 2' });
    expect(json).toMatchObject({ start: '2026-09-28', players: 100, unlocks: 30, total: 30 });
    const recent = json.recent as { cols: string[]; rows: unknown[][] };
    expect(recent.cols).toEqual(['date', 'user', 'points']); // all hardcore → no softcore col
    expect(recent.rows).toHaveLength(3);
    expect(recent.rows[0]).toEqual(['2026-09-29 00:29', 'u29', 29]);
    expect(json.next_offset).toBe(3);
    expect(text).not.toMatch(/ULID|Badge|ForumTopic/);
  });

  it('aotw: flags softcore unlocks', async () => {
    get.mockResolvedValue({
      ...aotw,
      Unlocks: [{ User: 'x', RAPoints: 1, HardcoreMode: 0, DateAwarded: '2026-09-28 01:00:00' }],
    });
    const { json } = await call('get_feed', { kind: 'aotw' });
    expect((json.recent as { cols: string[] }).cols).toContain('softcore');
  });

  const AOTW_SAMPLE = '/tmp/ref/samples/API_GetAchievementOfTheWeek.json';
  it.skipIf(!exists(AOTW_SAMPLE))('aotw on the real 69 KB sample stays small', async () => {
    const sample: unknown = JSON.parse(readFileSync(AOTW_SAMPLE, 'utf8'));
    get.mockResolvedValue(sample);
    const { text } = await call('get_feed', { kind: 'aotw' });
    expect(text.length).toBeLessThan(1200);
  });

  it('recent_awards: award kinds use the shared short labels; date is checked', async () => {
    get.mockResolvedValue({
      Total: 2,
      Results: [
        {
          User: 'u',
          AwardKind: 'beaten-hardcore',
          AwardDate: '2026-09-30',
          GameID: 5,
          GameTitle: 'G',
          ConsoleName: 'NES',
        },
        {
          User: 'v',
          AwardKind: 'beaten-softcore',
          AwardDate: '2026-09-30',
          GameID: 6,
          GameTitle: 'H',
          ConsoleName: 'NES',
        },
      ],
    });
    const { json } = await call('get_feed', { kind: 'recent_awards' });
    expect((json.rows as unknown[][]).map(r => r[2])).toEqual(['beaten_hc', 'beaten']);
    const bad = await call('get_feed', { kind: 'recent_awards', date: '09/01/2026' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/YYYY-MM-DD/);
  });

  it('top_users: positional keys → table with rank', async () => {
    get.mockResolvedValue([
      { '1': 'A', '2': 10, '3': 20, '4': 'ULID' },
      { '1': 'B', '2': '9', '3': '19', '4': 'ULID' },
    ]);
    const { json } = await call('get_feed', { kind: 'top_users' });
    expect(json).toEqual({
      cols: ['rank', 'user', 'points', 'retro'],
      rows: [
        [1, 'A', 10, 20],
        [2, 'B', 9, 19],
      ],
    });
  });

  it('recent_awards: passes d/k/c/o upstream and paginates by Total', async () => {
    get.mockResolvedValue({
      Count: 1,
      Total: 50,
      Results: [
        {
          User: 'u',
          ULID: 'X',
          AwardKind: 'mastered',
          AwardDate: '2026-09-30T02:38:09+00:00',
          GameID: 5,
          GameTitle: 'G',
          ConsoleID: 1,
          ConsoleName: 'NES',
        },
      ],
    });
    const { json } = await call('get_feed', {
      kind: 'recent_awards',
      date: '2026-09-01',
      award_kind: 'beaten_hardcore',
      limit: 200,
      offset: 5,
    });
    expect(get).toHaveBeenCalledWith(
      'GetRecentGameAwards',
      { d: '2026-09-01', k: 'beaten-hardcore', c: 100, o: 5 },
      TTL.feed,
    );
    expect(json).toMatchObject({
      total: 50,
      cols: ['date', 'user', 'game_id', 'game', 'console'], // award col dropped when filtered
      offset: 5,
      next_offset: 6,
    });
  });

  const claim = (over: Record<string, unknown>) => ({
    ID: 1,
    ULID: 'X',
    User: 'dev',
    GameID: 1,
    GameTitle: 'G',
    GameIcon: '/Images/1.png',
    ConsoleID: 1,
    ConsoleName: 'NES',
    ClaimType: 0,
    SetType: 0,
    Status: 0,
    Extension: 0,
    Special: 0,
    Created: '2026-01-01 00:00:00',
    DoneTime: '2026-04-01 00:00:00',
    Updated: '2026-01-01 00:00:00',
    UserIsJrDev: 0,
    MinutesLeft: 10,
    ...over,
  });

  it('active_claims: client-side console filter, newest first', async () => {
    get.mockResolvedValue([
      claim({ GameID: 1, Created: '2026-01-01 00:00:00' }),
      claim({ GameID: 2, Created: '2026-03-01 00:00:00', ClaimType: 1, Extension: 2 }),
      claim({ GameID: 3, ConsoleID: 2, ConsoleName: 'SNES' }),
    ]);
    const { json, text } = await call('get_feed', { kind: 'active_claims', console_id: 1 });
    expect(get).toHaveBeenCalledWith('GetActiveClaims', {}, TTL.feed);
    expect(json.cols).toEqual([
      'user',
      'game_id',
      'game',
      'set',
      'collab',
      'created',
      'expires',
      'extensions',
    ]);
    expect((json.rows as unknown[][]).map(r => r[1])).toEqual([2, 1]);
    expect(json.total).toBe(2);
    expect(text).not.toMatch(/Images|ULID/);
  });

  it('claims: claim_kind → k, game filter', async () => {
    get.mockResolvedValue([claim({ GameID: 7 }), claim({ GameID: 8 })]);
    const { json } = await call('get_feed', { kind: 'claims', claim_kind: 'dropped', game_id: 7 });
    expect(get).toHaveBeenCalledWith('GetClaims', { k: 2 }, TTL.feed);
    expect(json.claim_kind).toBeUndefined(); // the caller's own input is not echoed
    expect(json.cols).toContain('ended');
    expect(json.rows).toHaveLength(1);
  });

  it('rejects args that do not apply to the kind', async () => {
    for (const args of [
      { kind: 'aotw', date: '2026-01-01' },
      { kind: 'top_users', claim_kind: 'dropped' },
      { kind: 'recent_awards', console_id: 3 },
      { kind: 'active_claims', claim_kind: 'expired' },
    ]) {
      const r = await call('get_feed', args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/only apply to/);
    }
    expect(get).not.toHaveBeenCalled();
  });
});

// ---------- get_comments ----------

describe('get_comments', () => {
  const comments = {
    Count: 3,
    Total: 8,
    Results: [
      {
        User: 'Server',
        ULID: 'U1',
        Submitted: '2023-02-07T01:12:46.000000Z',
        CommentText: 'x uploaded',
      },
      {
        User: 'a',
        ULID: 'U2',
        Submitted: '2026-09-28T01:53:19.000000Z',
        CommentText: 'hi\n\nthere',
      },
      {
        User: 'b',
        ULID: 'U3',
        Submitted: '2026-09-28T02:00:00.000000Z',
        CommentText: 'z'.repeat(900),
      },
    ],
  };

  it('game target: t/i/c/o/sort upstream, strips ULIDs and system rows, clips long text', async () => {
    get.mockResolvedValue(comments);
    const { json, text } = await call('get_comments', { target: 'game', id: 5, limit: 3 });
    expect(get).toHaveBeenCalledWith(
      'GetComments',
      { t: 1, i: 5, c: 25, o: undefined, sort: '-submitted' },
      TTL.feed,
    );
    expect(json).toMatchObject({ total: 8, system_hidden: 1, next_offset: 3 });
    const rows = json.rows as string[][];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['2026-09-28 01:53', 'a', 'hi there']);
    expect(rows[1]![2]).toHaveLength(500);
    expect(rows[1]![2]!.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/ULID|U2/);
  });

  it('include_system keeps Server rows; oldest sort; achievement target', async () => {
    get.mockResolvedValue(comments);
    const { json } = await call('get_comments', {
      target: 'achievement',
      id: '9',
      sort: 'oldest',
      include_system: true,
      offset: 5,
    });
    expect(get).toHaveBeenCalledWith(
      'GetComments',
      { t: 2, i: 9, c: 25, o: 5, sort: 'submitted' },
      TTL.feed,
    );
    expect(json.rows).toHaveLength(3);
    expect(json.system_hidden).toBeUndefined();
    expect(json.next_offset).toBeUndefined(); // 5 + 3 = 8 = total
  });

  it('user target defaults to configured user; bare [] = empty wall', async () => {
    get.mockResolvedValue([]);
    const { json } = await call('get_comments', { target: 'user' }, 'marcus');
    expect(get.mock.calls[0]![1]).toMatchObject({ t: 3, i: 'marcus' });
    expect(json).toEqual({ total: 0, cols: [], rows: [] });
  });

  it('non-numeric id for game/achievement is a ToolInputError', async () => {
    const r = await call('get_comments', { target: 'game', id: 'Zelda' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/numeric game ID/);
    const r2 = await call('get_comments', { target: 'achievement' });
    expect(r2.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});

// ---------- get_tickets ----------

describe('get_tickets', () => {
  const ticket = (id: number, over: Record<string, unknown> = {}) => ({
    ID: id,
    AchievementID: 100,
    AchievementTitle: 'Ach',
    AchievementDesc: 'desc',
    AchievementType: null,
    Points: 25,
    BadgeName: '729577',
    AchievementAuthor: 'author',
    AchievementAuthorULID: 'ULIDA',
    GameID: 7,
    ConsoleName: 'PlayStation',
    GameTitle: 'Rally',
    GameIcon: '/Images/1.png',
    ReportedAt: '2026-09-30 02:31:25',
    ReportType: 2,
    ReportTypeDescription: 'Did not trigger',
    ReportNotes: 'Line one.\nRetroAchievements Hash: abc\n' + 'y'.repeat(300),
    ReportedBy: 'rep',
    ReportedByULID: 'ULIDR',
    ResolvedAt: null,
    ResolvedBy: null,
    ResolvedByULID: null,
    ReportState: 1,
    ReportStateDescription: 'Open',
    Hardcore: 1,
    ...over,
  });

  it('recent: c/o upstream, compact rows with short note', async () => {
    get.mockResolvedValue({ RecentTickets: [ticket(2), ticket(1)], OpenTickets: 3934, URL: 'u' });
    const { json, text } = await call('get_tickets', { mode: 'recent', limit: 2, offset: 4 });
    expect(get).toHaveBeenCalledWith('GetTicketData', { c: 25, o: 4 }, TTL.feed);
    expect(json).toMatchObject({ open_total: 3934, offset: 4, next_offset: 6 });
    expect(json.cols).toEqual([
      'id',
      'state',
      'type',
      'achievement_id',
      'achievement',
      'game_id',
      'game',
      'console',
      'reporter',
      'reported',
      'hardcore',
      'note',
    ]);
    const note = (json.rows as unknown[][])[0]!.at(-1) as string;
    expect(note.length).toBe(100);
    expect(note.startsWith('Line one. RetroAchievements Hash')).toBe(true);
    expect(text).not.toMatch(/ULID|Images|BadgeName/);
  });

  it('details adds author/resolution and longer notes', async () => {
    get.mockResolvedValue({
      RecentTickets: [ticket(1, { ResolvedAt: '2026-10-01 00:00:00', ResolvedBy: 'fixer' })],
    });
    const { json } = await call('get_tickets', { mode: 'recent', details: true });
    expect(json.cols).toEqual(expect.arrayContaining(['author', 'resolved', 'resolved_by']));
    const row = (json.rows as unknown[][])[0]!;
    expect((row[(json.cols as string[]).indexOf('note')] as string).length).toBeGreaterThan(300);
  });

  it('ticket: single object by id (i=)', async () => {
    get.mockResolvedValue({
      ...ticket(118390),
      URL: 'https://retroachievements.org/ticket/118390',
    });
    const { json } = await call('get_tickets', { mode: 'ticket', id: 118390 });
    expect(get).toHaveBeenCalledWith('GetTicketData', { i: 118390 }, TTL.feed);
    expect(json).toMatchObject({
      id: 118390,
      state: 'Open',
      achievement: { id: 100, title: 'Ach', points: 25, author: 'author' },
      game: { id: 7, title: 'Rally', console: 'PlayStation' },
      hardcore: 1,
      url: 'https://retroachievements.org/ticket/118390',
    });
  });

  it('ticket: missing → not found', async () => {
    get.mockResolvedValue({});
    const { json } = await call('get_tickets', { mode: 'ticket', id: 1 });
    expect(json).toEqual({ result: 'not found' });
  });

  it('game: g + d=1 (+f=5 unofficial), newest first, client paging, no game cols', async () => {
    get.mockResolvedValue({
      GameID: 7,
      GameTitle: 'Rally',
      ConsoleName: 'PlayStation',
      OpenTickets: 3,
      URL: 'u',
      Tickets: [ticket(1), ticket(3), ticket(2)],
    });
    const { json } = await call('get_tickets', {
      mode: 'game',
      id: 7,
      unofficial: true,
      limit: 2,
    });
    expect(get).toHaveBeenCalledWith('GetTicketData', { g: 7, f: 5, d: 1 }, TTL.feed);
    expect(json).toMatchObject({
      game: { id: 7, title: 'Rally', console: 'PlayStation' },
      open_tickets: 3,
      total: 3,
      next_offset: 2,
    });
    expect(json.cols).not.toContain('game');
    expect((json.rows as unknown[][]).map(r => r[0])).toEqual([3, 2]);
  });

  it('achievement: a=', async () => {
    get.mockResolvedValue({
      AchievementID: 9,
      AchievementTitle: 'T',
      AchievementDescription: 'D',
      AchievementType: null,
      URL: 'u',
      OpenTickets: 1,
    });
    const { json } = await call('get_tickets', { mode: 'achievement', id: 9 });
    expect(get).toHaveBeenCalledWith('GetTicketData', { a: 9 }, TTL.feed);
    expect(json).toEqual({
      achievement: { id: 9, title: 'T', description: 'D' },
      open_tickets: 1,
      url: 'u',
    });
  });

  it('developer: u= defaults to configured user, ULID dropped', async () => {
    get.mockResolvedValue({
      User: 'dev',
      ULID: 'X',
      Open: 1,
      Closed: 2,
      Resolved: 3,
      Total: 6,
      URL: 'u',
    });
    const { json } = await call('get_tickets', { mode: 'developer' }, 'dev');
    expect(get).toHaveBeenCalledWith('GetTicketData', { u: 'dev' }, TTL.feed);
    expect(json).toEqual({ user: 'dev', open: 1, closed: 2, resolved: 3, total: 6, url: 'u' });
  });

  it('most_ticketed: f=1 + c/o', async () => {
    get.mockResolvedValue({
      MostReportedGames: [
        { GameID: '1', GameTitle: 'A', GameIcon: '/i.png', Console: 'GBA', OpenTickets: '32' },
      ],
      URL: 'u',
    });
    const { json } = await call('get_tickets', { mode: 'most_ticketed', limit: 5 });
    expect(get).toHaveBeenCalledWith('GetTicketData', { f: 1, c: 25, o: undefined }, TTL.feed);
    expect(json).toEqual({
      cols: ['game_id', 'game', 'console', 'open_tickets'],
      rows: [[1, 'A', 'GBA', 32]],
    });
  });

  it('mode validation', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ mode: 'ticket' }, /requires "id"/],
      [{ mode: 'game' }, /requires "id"/],
      [{ mode: 'recent', id: 3 }, /"id" only apply to mode ticket\/game\/achievement/],
      [{ mode: 'game', id: 3, user: 'x' }, /"user" only apply to mode developer/],
      [{ mode: 'achievement', id: 3, unofficial: true }, /"unofficial" only apply/],
    ];
    for (const [args, re] of cases) {
      const r = await call('get_tickets', args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(re);
    }
    expect(get).not.toHaveBeenCalled();
  });
});

// ---------- ra_api_raw ----------

describe('ra_api_raw', () => {
  it('ENDPOINTS = the 38 documented endpoints (GetGameRating is 410 Gone)', () => {
    const file = '/tmp/ref/docs-endpoints.txt';
    const documented = exists(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.replace(/^API_/, '').replace(/\.php$/, ''))
      : [...ENDPOINTS];
    expect(documented).toHaveLength(38);
    expect([...ENDPOINTS].sort()).toEqual([...documented].sort());
    expect(ENDPOINTS).not.toContain('GetGameRating');
    expect(new Set(ENDPOINTS).size).toBe(ENDPOINTS.length);
  });

  it('passes endpoint + params with no TTL (client uses the per-endpoint default)', async () => {
    get.mockResolvedValue({ ID: 1, Empty: '', Nothing: null, List: [{ a: 1, b: null }] });
    const r = await call('ra_api_raw', { endpoint: 'GetGame', params: { i: 1, x: 'y' } });
    expect(get).toHaveBeenCalledWith('GetGame', { i: 1, x: 'y' });
    expect(r.text).toBe('{"ID":1,"List":[{"a":1}]}');
  });

  it('normalises endpoint spelling (API_ prefix, .php, case)', async () => {
    get.mockResolvedValue({});
    await call('ra_api_raw', { endpoint: 'API_getgameextended.php', params: { i: 1 } });
    expect(get).toHaveBeenCalledWith('GetGameExtended', { i: 1 });
  });

  it('advertises endpoint as a plain string (no 38-value enum)', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const raw = tools.find(t => t.name === 'ra_api_raw');
    const ep = raw?.inputSchema.properties?.endpoint as Record<string, unknown>;
    expect(ep.type).toBe('string');
    expect(ep.enum).toBeUndefined();
    await client.close();
  });

  it('rejects a y (API key) param', async () => {
    for (const k of ['y', 'Y']) {
      const r = await call('ra_api_raw', { endpoint: 'GetGame', params: { i: 1, [k]: 'k' } });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/"y"/);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects unknown endpoints server-side, listing the valid names', async () => {
    for (const endpoint of ['SetSomething', 'GetGameRating']) {
      const r = await call('ra_api_raw', { endpoint });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Unknown endpoint/);
      expect(r.text).toContain('GetGameExtended');
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('truncates at max_chars with original length', async () => {
    get.mockResolvedValue({ big: 'x'.repeat(5000) });
    const r = await call('ra_api_raw', { endpoint: 'GetConsoleIDs', max_chars: 300 });
    expect(r.text.startsWith('{"big":"xxx')).toBe(true);
    expect(r.text).toMatch(/…\[TRUNCATED: showing 300 of 5010 chars/);
    expect(r.text.length).toBeLessThan(420);
  });

  it('surfaces upstream errors as isError', async () => {
    get.mockImplementation(() => {
      throw new Error('boom');
    });
    const r = await call('ra_api_raw', { endpoint: 'GetGame', params: { i: 1 } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ra_api_raw failed: boom/);
  });
});

describe('helpers', () => {
  it('clip collapses whitespace/<br> and caps with an ellipsis', () => {
    expect(clip('a<br/>b\n\n c', 50)).toBe('a b c');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip(undefined, 4)).toBeUndefined();
  });
  it('rawText leaves short payloads untouched', () => {
    expect(rawText(null, 100)).toBe('null');
    expect(rawText([1, 2], 100)).toBe('[1,2]');
  });
});

function exists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
