import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { RAError, TTL, type RAClient } from '../src/client.js';
import type { CatalogGame, CatalogStore } from '../src/catalog.js';
import type { Logger } from '../src/logger.js';
import { pct, registerGameTools, scoreTitle, normalizeTitle } from '../src/tools/game.js';

type Responder = (endpoint: string, params: Record<string, unknown>) => unknown;

const log: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function setup(respond: Responder, catalogGames: CatalogGame[] = []) {
  const get = vi.fn((endpoint: string, params: Record<string, unknown>, _ttl: number) =>
    Promise.resolve().then(() => respond(endpoint, params)),
  );
  const getMany = vi.fn(() => Promise.resolve({ games: [...catalogGames], missing: [] }));
  const server = new McpServer({ name: 't', version: '0' });
  registerGameTools(server, {
    client: { get } as unknown as RAClient,
    catalog: { getMany } as unknown as CatalogStore,
    log,
    defaultUser: 'me',
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map(c => c.text).join('');
    return {
      isError: r.isError === true,
      text,
      json: () => JSON.parse(text) as Record<string, unknown>,
    };
  };
  return { get, getMany, call, client };
}

// ---------- fixtures (trimmed real responses) ----------

const GAME = {
  Title: 'Sonic the Hedgehog',
  GameTitle: 'Sonic the Hedgehog',
  ConsoleID: 1,
  ConsoleName: 'Genesis/Mega Drive',
  Console: 'Genesis/Mega Drive',
  ForumTopicID: 112,
  Flags: 0,
  GameIcon: '/Images/085573.png',
  ImageIcon: '/Images/085573.png',
  ImageBoxArt: '/Images/112941.png',
  Publisher: 'Sega',
  Developer: 'Sonic Team',
  Genre: '2D Platforming',
  Released: '1991-06-11',
  ReleasedAtGranularity: 'day',
};

const EXTENDED = {
  ...GAME,
  ID: 1,
  RichPresencePatch: 'c7818cb64b9cd9c551f1692246261927',
  Updated: '2026-09-30T02:22:12.000000Z',
  ParentGameID: null,
  NumDistinctPlayers: 1000,
  NumAchievements: 3,
  NumDistinctPlayersCasual: 1000,
  NumDistinctPlayersHardcore: 1000,
  Claims: [
    {
      User: 'Scott',
      ULID: 'X',
      SetType: 0,
      GameID: 1,
      ClaimType: 0,
      Created: '2012-11-02 00:00:00',
      Expiration: '2012-11-02 00:00:00',
    },
  ],
  Achievements: {
    '11': {
      ID: 11,
      NumAwarded: 100,
      NumAwardedHardcore: 50,
      Title: 'Last',
      Description: 'd3',
      Points: 25,
      TrueRatio: 80,
      BadgeName: '333',
      DisplayOrder: 3,
      MemAddr: 'abc',
      type: 'win_condition',
    },
    '9': {
      ID: 9,
      NumAwarded: 900,
      NumAwardedHardcore: 456,
      Title: 'First',
      Description: 'd1',
      Points: 3,
      TrueRatio: 3,
      BadgeName: '111',
      DisplayOrder: 1,
      MemAddr: 'abc',
      type: 'progression',
    },
    '10': {
      ID: 10,
      NumAwarded: 300,
      NumAwardedHardcore: 0,
      Title: 'Middle',
      Description: 'd2',
      Points: 10,
      TrueRatio: 12,
      BadgeName: '222',
      DisplayOrder: 2,
      MemAddr: 'abc',
      type: null,
    },
  },
};

const PROGRESSION = {
  ID: 1,
  NumDistinctPlayers: 1000,
  TimesUsedInBeatMedian: 3608,
  TimesUsedInHardcoreBeatMedian: 4329,
  MedianTimeToBeat: 8083,
  MedianTimeToBeatHardcore: 8656,
  TimesUsedInCompletionMedian: 589,
  TimesUsedInMasteryMedian: 1342,
  MedianTimeToComplete: 16719,
  MedianTimeToMaster: 29542,
  Achievements: [
    { ID: 11, Title: 'Last', Points: 25, Type: 'win_condition', MedianTimeToUnlock: 6000 },
    { ID: 9, Title: 'First', Points: 3, Type: 'progression', MedianTimeToUnlock: 70 },
    { ID: 10, Title: 'Middle', Points: 10, Type: null, MedianTimeToUnlock: 600 },
  ],
};

const HASHES = {
  Results: [
    {
      Name: 'Sonic (USA, Europe).md',
      MD5: '1bc674be034e43c96b86487ac69d9293',
      Labels: ['nointro'],
      PatchUrl: null,
    },
  ],
};

function gameResponder(endpoint: string): unknown {
  switch (endpoint) {
    case 'GetGame':
      return GAME;
    case 'GetGameExtended':
      return EXTENDED;
    case 'GetGameProgression':
      return PROGRESSION;
    case 'GetGameHashes':
      return HASHES;
    case 'GetAchievementDistribution':
      return { '1': 50, '2': 20, '3': 5 };
    default:
      throw new Error(`unexpected ${endpoint}`);
  }
}

// ---------- helpers ----------

describe('helpers', () => {
  it('pct rounds to one decimal and guards zero', () => {
    expect(pct(1, 3)).toBe(33.3);
    expect(pct('456', 1000)).toBe(45.6);
    expect(pct(5, 0)).toBeUndefined();
    expect(pct(undefined, 10)).toBeUndefined();
  });

  it('scoreTitle ranks exact > prefix > substring and rejects partial token matches', () => {
    const q = normalizeTitle('sonic');
    const toks = [q];
    const exact = scoreTitle('Sonic', q, toks);
    const prefix = scoreTitle('Sonic the Hedgehog', q, toks);
    const sub = scoreTitle('Ultimate Sonic Collection', q, toks);
    const hack = scoreTitle('~Hack~ Sonic the Hedgehog', q, toks);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(prefix).toBeGreaterThan(hack);
    expect(scoreTitle('Mario', q, toks)).toBe(-1);
  });
});

// ---------- list_consoles / find_games ----------

describe('list_consoles', () => {
  it('filters non-game systems and uses the static TTL', async () => {
    const { get, call } = await setup(() => [
      { ID: 1, Name: 'Genesis', Active: true, IsGameSystem: true },
      { ID: 100, Name: 'Hubs', Active: true, IsGameSystem: false },
      { ID: 2, Name: 'N64', Active: false, IsGameSystem: true },
    ]);
    const r = (await call('list_consoles', { active_only: true })).json();
    expect(r).toEqual({ cols: ['id', 'name'], rows: [[1, 'Genesis']] });
    expect(get).toHaveBeenCalledWith('GetConsoleIDs', {}, TTL.static);
  });
});

describe('find_games', () => {
  const games: CatalogGame[] = [
    { ID: 1, Title: 'Sonic the Hedgehog', ConsoleID: 1, ConsoleName: 'Genesis', Points: 400 },
    { ID: 2, Title: 'Sonic the Hedgehog 2', ConsoleID: 1, ConsoleName: 'Genesis', Points: 500 },
    { ID: 3, Title: 'Streets of Rage', ConsoleID: 1, ConsoleName: 'Genesis', Points: 300 },
  ];

  it('requires query or console_id', async () => {
    const { call } = await setup(() => []);
    const r = await call('find_games', {});
    expect(r.isError).toBe(true);
  });

  it('ranks matches and paginates', async () => {
    const { call, getMany } = await setup(() => [], games);
    const r = (await call('find_games', { query: 'sonic', console_id: 1, limit: 1 })).json();
    expect(getMany).toHaveBeenCalledWith([1], true, false, expect.any(Number));
    expect(r.console).toBe('Genesis');
    expect(r.rows).toEqual([[1, 'Sonic the Hedgehog', 400]]);
    expect(r.total).toBe(2);
    expect(r.next_offset).toBe(1);
  });
});

// ---------- get_game ----------

describe('get_game', () => {
  it('base info uses cheap GetGame only and drops duplicates/internal fields', async () => {
    const { get, call } = await setup(gameResponder);
    const res = await call('get_game', { game_id: 1 });
    const r = res.json();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('GetGame', { i: 1 }, TTL.game);
    expect(r).toEqual({
      id: 1,
      title: 'Sonic the Hedgehog',
      console: 'Genesis/Mega Drive',
      console_id: 1,
      developer: 'Sonic Team',
      publisher: 'Sega',
      genre: '2D Platforming',
      released: '1991-06-11',
    });
    expect(res.text).not.toMatch(/Images|ForumTopic|GameTitle/);
  });

  it('achievements: GetGameExtended only (no GetGame), sorted, rarity, no MemAddr', async () => {
    const { get, call } = await setup(gameResponder);
    const res = await call('get_game', { game_id: 1, include: ['achievements'] });
    const r = res.json();
    expect(get.mock.calls.map(c => c[0])).toEqual(['GetGameExtended']);
    expect(get).toHaveBeenCalledWith('GetGameExtended', { i: 1 }, TTL.game);
    expect(r).toMatchObject({ players: 1000, achievements: 3, points: 38, retro_points: 95 });
    const list = r.achievement_list as { cols: string[]; rows: unknown[][]; total: number };
    expect(list.cols).toEqual([
      'id',
      'title',
      'description',
      'points',
      'retro',
      'type',
      'rarity',
      'rarity_hc',
    ]);
    expect(list.rows.map(x => x[0])).toEqual([9, 10, 11]);
    expect(list.rows[0]).toEqual([9, 'First', 'd1', 3, 3, 'progression', 90, 45.6]);
    expect(list.rows[1]![5]).toBeNull(); // untyped
    expect(list.rows[1]![7]).toBe(0);
    expect(list.total).toBe(3);
    expect(res.text).not.toMatch(/MemAddr|RichPresence|abc|NumDistinctPlayersCasual/);
  });

  it('filters by type, paginates and adds image URLs on request', async () => {
    const { call } = await setup(gameResponder);
    const r = (
      await call('get_game', {
        game_id: 1,
        include: ['achievements'],
        achievement_type: 'none',
        images: true,
      })
    ).json();
    const list = r.achievement_list as { cols: string[]; rows: unknown[][] };
    expect(list.rows.map(x => x[0])).toEqual([10]);
    expect(list.rows[0]!.at(-1)).toBe('https://media.retroachievements.org/Badge/222.png');
    expect(r.icon).toBe('https://media.retroachievements.org/Images/085573.png');

    const p = (
      await call('get_game', { game_id: 1, include: ['achievements'], limit: 1, offset: 1 })
    ).json().achievement_list as Record<string, unknown>;
    expect(p).toMatchObject({ total: 3, offset: 1, next_offset: 2 });
    expect((p.rows as unknown[][]).map(x => x[0])).toEqual([10]);
  });

  it('claims come from GetGameExtended without another call', async () => {
    const { get, call } = await setup(gameResponder);
    const r = (await call('get_game', { game_id: 1, include: ['claims'] })).json();
    expect(get.mock.calls.map(c => c[0])).toEqual(['GetGameExtended']);
    expect(r.claims).toEqual({
      cols: ['user', 'set', 'kind', 'created', 'expires'],
      rows: [['Scott', 'new', 'primary', '2012-11-02 00:00', '2012-11-02 00:00']],
    });
    expect(r.achievement_list).toBeUndefined();
  });

  it('hashes, progression and distribution use their endpoints and TTLs', async () => {
    const { get, call } = await setup(gameResponder);
    const r = (
      await call('get_game', { game_id: 1, include: ['hashes', 'progression', 'distribution'] })
    ).json();
    expect(get).toHaveBeenCalledWith('GetGame', { i: 1 }, TTL.game);
    expect(get).toHaveBeenCalledWith('GetGameHashes', { i: 1 }, TTL.static);
    expect(get).toHaveBeenCalledWith('GetGameProgression', { i: 1 }, TTL.game);
    expect(get).toHaveBeenCalledWith('GetAchievementDistribution', { i: 1 }, TTL.game);
    expect(get).toHaveBeenCalledTimes(4);
    expect(r.hashes).toEqual({
      cols: ['md5', 'name', 'labels'],
      rows: [['1bc674be034e43c96b86487ac69d9293', 'Sonic (USA, Europe).md', 'nointro']],
    });
    expect(r.median_hours).toEqual({ beat: 2.2, beat_hc: 2.4, complete: 4.6, master: 8.2 });
    expect(r.players_by_unlock_count).toEqual({ '1': 50, '2': 20, '3': 5 });
    // Without achievements, progression rows are ordered by median unlock time.
    const prog = r.achievement_progression as { cols: string[]; rows: unknown[][] };
    expect(prog.rows.map(x => x[0])).toEqual([9, 10, 11]);
    expect(prog.rows[0]).toEqual([9, 'First', 3, 'progression', 1.2]);
  });

  it('progression + achievements merges medians into one table', async () => {
    const { call } = await setup(gameResponder);
    const r = (
      await call('get_game', { game_id: 1, include: ['achievements', 'progression'] })
    ).json();
    const list = r.achievement_list as { cols: string[]; rows: unknown[][] };
    expect(list.cols).toContain('median_min');
    expect(list.rows[2]!.at(-1)).toBe(100);
    expect(r.achievement_progression).toBeUndefined();
  });

  it('rejects achievement_type without a section that uses it', async () => {
    const { get, call } = await setup(gameResponder);
    const r = await call('get_game', { game_id: 1, achievement_type: 'missable' });
    expect(r.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('unknown game → not found', async () => {
    const { call } = await setup(() => []);
    expect((await call('get_game', { game_id: 999999 })).json()).toEqual({ result: 'not found' });
  });
});

// ---------- get_game_rankings ----------

describe('get_game_rankings', () => {
  it('maps type to upstream t and emits a table', async () => {
    const { get, call } = await setup(() => [
      {
        User: 'henrit',
        ULID: '01FQ',
        NumAchievements: 35,
        TotalScore: 300,
        LastAward: '2026-09-29 22:54:52',
      },
    ]);
    const r = (await call('get_game_rankings', { game_id: 1, type: 'latest_masters' })).json();
    expect(get).toHaveBeenCalledWith('GetGameRankAndScore', { g: 1, t: 1 }, TTL.feed);
    expect(r).toEqual({
      game_id: 1,
      type: 'latest_masters',
      cols: ['user', 'achievements', 'points', 'last_award'],
      rows: [['henrit', 35, 300, '2026-09-29 22:54']],
    });
    await call('get_game_rankings', { game_id: 1 });
    expect(get).toHaveBeenLastCalledWith('GetGameRankAndScore', { g: 1, t: 0 }, TTL.feed);
  });
});

// ---------- get_leaderboards ----------

describe('get_leaderboards', () => {
  const boards = {
    Count: 2,
    Total: 5,
    Results: [
      {
        ID: 188,
        RankAsc: false,
        Title: ' Jetbike Racing',
        Description: 'Try for 2,371 WP!',
        Format: 'SCORE',
        TopEntry: { User: 'Xymjak', ULID: 'U', Score: 2371, FormattedScore: '002371' },
        Author: null,
        State: 'active',
      },
      {
        ID: 260,
        RankAsc: true,
        Title: 'Speedrun',
        Description: 'Fastest',
        Format: 'MILLISECS',
        TopEntry: { User: 'Warlock44', ULID: 'U', Score: 13600, FormattedScore: '2:16.00' },
        State: 'disabled',
      },
    ],
  };

  it('validates exactly one id', async () => {
    const { call, get } = await setup(() => boards);
    expect((await call('get_leaderboards', {})).isError).toBe(true);
    expect((await call('get_leaderboards', { game_id: 1, leaderboard_id: 2 })).isError).toBe(true);
    expect(
      (await call('get_leaderboards', { leaderboard_id: 2, user_entries: true })).isError,
    ).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('lists game boards with upstream pagination', async () => {
    const { call, get } = await setup(() => boards);
    const r = (await call('get_leaderboards', { game_id: 319, limit: 2 })).json();
    expect(get).toHaveBeenCalledWith('GetGameLeaderboards', { i: 319, c: 2, o: 0 }, TTL.game);
    expect(r).toEqual({
      game_id: 319,
      cols: ['id', 'title', 'description', 'lower_better', 'state', 'top_user', 'top_score'],
      rows: [
        [188, 'Jetbike Racing', 'Try for 2,371 WP!', null, null, 'Xymjak', '002371'],
        [260, 'Speedrun', 'Fastest', true, 'disabled', 'Warlock44', '2:16.00'],
      ],
      total: 5,
      next_offset: 2,
    });
  });

  it('leaderboard entries', async () => {
    const { call, get } = await setup(() => ({
      Count: 1,
      Total: 1,
      Results: [
        {
          User: 'Warlock44',
          ULID: 'U',
          DateSubmitted: '2019-12-04T14:13:59+00:00',
          Score: 13600,
          FormattedScore: '2:16.00',
          Rank: 1,
        },
      ],
    }));
    const r = (await call('get_leaderboards', { leaderboard_id: 260, offset: 0 })).json();
    expect(get).toHaveBeenCalledWith('GetLeaderboardEntries', { i: 260, c: 25, o: 0 }, TTL.feed);
    expect(r).toEqual({
      leaderboard_id: 260,
      cols: ['rank', 'user', 'score', 'date'],
      rows: [[1, 'Warlock44', '2:16.00', '2019-12-04 14:13']],
      total: 1,
    });
  });

  it("user entries default to the configured user; 422 'no leaderboards' is not an error", async () => {
    let fail = false;
    const { call, get } = await setup(() => {
      if (fail) throw new RAError('HTTP 422', 422, 'GetUserGameLeaderboards');
      return {
        Count: 1,
        Total: 1,
        Results: [
          {
            ID: 260,
            RankAsc: true,
            Title: 'Speedrun',
            Format: 'MILLISECS',
            UserEntry: {
              User: 'me',
              Score: 13600,
              FormattedScore: '2:16.00',
              Rank: 1,
              DateUpdated: '2019-12-04T14:13:59+00:00',
            },
          },
        ],
      };
    });
    const r = (await call('get_leaderboards', { game_id: 319, user_entries: true })).json();
    expect(get).toHaveBeenCalledWith(
      'GetUserGameLeaderboards',
      { i: 319, u: 'me', c: 25, o: 0 },
      TTL.user,
    );
    expect(r.rows).toEqual([[260, 'Speedrun', true, '2:16.00', 1, '2019-12-04 14:13']]);

    fail = true;
    const none = await call('get_leaderboards', { game_id: 319, user: 'other' });
    expect(none.isError).toBe(false);
    expect(none.json()).toMatchObject({ user: 'other', total: 0 });
  });
});

// ---------- get_achievement_unlocks ----------

describe('get_achievement_unlocks', () => {
  const unlocks = {
    Achievement: {
      ID: 9,
      Title: 'That Was Easy',
      Description: 'Complete act 1.',
      Points: 3,
      TrueRatio: 3,
      Author: 'Scott',
      AuthorULID: 'U',
      DateCreated: '2012-11-02 00:03:12',
      DateModified: '2026-01-06 00:58:04',
      Type: 'progression',
    },
    Console: { ID: 1, Title: 'Genesis/Mega Drive' },
    Game: { ID: 1, Title: 'Sonic the Hedgehog' },
    UnlocksCount: 600,
    UnlocksHardcoreCount: 300,
    TotalPlayers: 1000,
    Unlocks: [
      {
        User: 'a',
        ULID: 'U',
        RAPoints: 1,
        DateAwarded: '2026-09-30T02:19:14.000000Z',
        HardcoreMode: 1,
      },
      {
        User: 'b',
        ULID: 'U',
        RAPoints: 1,
        DateAwarded: '2026-09-30T02:07:28.000000Z',
        HardcoreMode: 0,
      },
      {
        User: 'c',
        ULID: 'U',
        RAPoints: 1,
        DateAwarded: '2026-09-30T01:48:36.000000Z',
        HardcoreMode: 1,
      },
      {
        User: 'd',
        ULID: 'U',
        RAPoints: 1,
        DateAwarded: '2026-09-30T00:45:56.000000Z',
        HardcoreMode: 1,
      },
    ],
  };

  it('header once + table, limit/offset upstream', async () => {
    const { call, get } = await setup(() => ({ ...unlocks, Unlocks: unlocks.Unlocks.slice(0, 2) }));
    const res = await call('get_achievement_unlocks', { achievement_id: 9, limit: 2, offset: 4 });
    const r = res.json();
    expect(get).toHaveBeenCalledWith('GetAchievementUnlocks', { a: 9, c: 2, o: 4 }, TTL.feed);
    expect(r).toEqual({
      achievement: {
        id: 9,
        title: 'That Was Easy',
        description: 'Complete act 1.',
        points: 3,
        retro: 3,
        type: 'progression',
        author: 'Scott',
        created: '2012-11-02',
      },
      game: { id: 1, title: 'Sonic the Hedgehog', console: 'Genesis/Mega Drive' },
      players: 1000,
      unlocks: 600,
      unlocks_hc: 300,
      rarity: 60,
      rarity_hc: 30,
      cols: ['user', 'date', 'hc'],
      rows: [
        ['a', '2026-09-30 02:19', true],
        ['b', '2026-09-30 02:07', false],
      ],
      offset: 4,
      next_offset: 6,
    });
    expect(res.text).not.toMatch(/ULID|RAPoints/);
  });

  it('hardcore_only over-fetches, filters, and points next_offset past the last scanned row', async () => {
    const { call, get } = await setup(() => unlocks);
    const r = (
      await call('get_achievement_unlocks', { achievement_id: 9, hardcore_only: true, limit: 2 })
    ).json();
    expect(get).toHaveBeenCalledWith('GetAchievementUnlocks', { a: 9, c: 8, o: 0 }, TTL.feed);
    expect(r.cols).toEqual(['user', 'date']);
    expect(r.rows).toEqual([
      ['a', '2026-09-30 02:19'],
      ['c', '2026-09-30 01:48'],
    ]);
    expect(r.next_offset).toBe(3);
  });

  it('unknown achievement → not found', async () => {
    const { call } = await setup(() => null);
    expect((await call('get_achievement_unlocks', { achievement_id: 1 })).json()).toEqual({
      result: 'not found',
    });
  });
});
