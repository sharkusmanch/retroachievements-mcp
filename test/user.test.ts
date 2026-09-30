/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- JSON results are asserted structurally */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTL, type Params, type RAClient } from '../src/client.js';
import type { CatalogStore } from '../src/catalog.js';
import type { ToolContext } from '../src/tools/common.js';
import { registerUserTools } from '../src/tools/user.js';

// ---------- fixtures (trimmed from real responses, 2026-09) ----------

const PROFILE = {
  User: 'marcus1255',
  ULID: '01B8KEV961X1RR8V29D0627GY4',
  UserPic: '/UserPic/marcus1255.png',
  MemberSince: '2017-02-10 07:29:52',
  RichPresenceMsg: 'Playing Final Fantasy VI: Advance',
  LastGameID: 765,
  ContribCount: 0,
  ContribYield: 0,
  TotalPoints: 27,
  TotalSoftcorePoints: 206,
  TotalTruePoints: 33,
  Permissions: 1,
  Untracked: 0,
  ID: 35235,
  UserWallActive: 0,
  Motto: '',
};

const SUMMARY = {
  ...PROFILE,
  RichPresenceMsgDate: '2026-09-30 01:28:41',
  Rank: null,
  TotalRanked: 166278,
  Status: 'Offline',
  RecentlyPlayed: [
    {
      GameID: 765,
      ConsoleID: 5,
      ConsoleName: 'Game Boy Advance',
      Title: 'Final Fantasy VI: Advance',
      ImageIcon: '/Images/070797.png',
      LastPlayed: '2026-09-30 01:28:41',
      AchievementsTotal: 85,
    },
  ],
  Awarded: {
    '765': { NumPossibleAchievements: 85, NumAchieved: 2, NumAchievedHardcore: 0 },
  },
  RecentAchievements: {
    '765': {
      '179023': {
        ID: 179023,
        GameID: 765,
        GameTitle: 'Final Fantasy VI: Advance',
        Title: 'Shell Shocker',
        Points: 5,
        Type: 'progression',
        DateAwarded: '2026-09-29 21:27:17',
        HardcoreAchieved: 0,
      },
      '179024': {
        ID: 179024,
        GameID: 765,
        GameTitle: 'Final Fantasy VI: Advance',
        Title: 'Where You Going!?',
        Points: 5,
        Type: 'missable',
        DateAwarded: '2026-09-29 22:24:37',
        HardcoreAchieved: 0,
      },
    },
  },
  LastGame: {
    ID: 765,
    Title: 'Final Fantasy VI: Advance',
    ConsoleName: 'Game Boy Advance',
    ForumTopicID: 14901,
  },
};

const AWARDS = {
  TotalAwardsCount: 2,
  HiddenAwardsCount: 0,
  MasteryAwardsCount: 0,
  CompletionAwardsCount: 0,
  BeatenHardcoreAwardsCount: 0,
  BeatenSoftcoreAwardsCount: 1,
  EventAwardsCount: 0,
  SiteAwardsCount: 1,
  VisibleUserAwards: [
    {
      AwardedAt: '2020-04-28T15:09:37+00:00',
      Title: null,
      ConsoleName: null,
      ImageIcon: null,
      AwardType: 'Patreon Supporter',
      AwardData: 0,
      AwardDataExtra: 1,
      DisplayOrder: 0,
    },
    {
      AwardedAt: '2023-12-29T07:24:19+00:00',
      Title: 'Pokémon Platinum Version',
      ConsoleID: 18,
      ConsoleName: 'Nintendo DS',
      ImageIcon: '/Images/104787.png',
      AwardType: 'Game Beaten',
      AwardData: 11732,
      AwardDataExtra: 0,
      DisplayOrder: 1,
    },
  ],
};

const unlock = (date: string, id: number, hc: number, title: string) => ({
  Date: date,
  HardcoreMode: hc,
  AchievementID: id,
  Title: title,
  Description: 'desc',
  BadgeName: '199375',
  Points: 5,
  TrueRatio: 5,
  Type: 'progression',
  Author: 'SnowPin',
  AuthorULID: '019TVEANZS2MMVS809D58X76W6',
  GameTitle: 'Final Fantasy VI: Advance',
  GameIcon: '/Images/070797.png',
  GameID: 765,
  ConsoleName: 'Game Boy Advance',
  BadgeURL: '/Badge/199375.png',
  GameURL: '/game/765',
});
// Upstream order for the range endpoints is oldest first.
const UNLOCKS = [
  unlock('2026-09-29 21:27:17', 179023, 0, 'Shell Shocker'),
  unlock('2026-09-29 22:24:37', 179024, 1, 'Where You Going!?'),
];

const RECENT_GAMES = [
  {
    GameID: 765,
    ConsoleID: 5,
    ConsoleName: 'Game Boy Advance',
    Title: 'Final Fantasy VI: Advance',
    ImageIcon: '/Images/070797.png',
    ImageBoxArt: '/Images/005284.png',
    LastPlayed: '2026-09-30 01:28:41',
    AchievementsTotal: 85,
    NumPossibleAchievements: 85,
    PossibleScore: 576,
    NumAchieved: 2,
    ScoreAchieved: 10,
    NumAchievedHardcore: 0,
    ScoreAchievedHardcore: 0,
  },
];

const completion = (
  id: number,
  title: string,
  consoleId: number,
  max: number,
  got: number,
  kind: string | null,
  recent: string,
) => ({
  GameID: id,
  Title: title,
  ImageIcon: '/Images/x.png',
  ConsoleID: consoleId,
  ConsoleName: consoleId === 5 ? 'Game Boy Advance' : 'Nintendo DS',
  MaxPossible: max,
  NumAwarded: got,
  NumAwardedHardcore: 0,
  MostRecentAwardedDate: recent,
  HighestAwardKind: kind,
  HighestAwardDate: kind ? recent : null,
});
const COMPLETION = {
  Count: 3,
  Total: 3,
  Results: [
    completion(765, 'Final Fantasy VI: Advance', 5, 85, 2, null, '2026-09-29T22:24:37+00:00'),
    completion(
      668,
      'Pokémon Emerald Version',
      5,
      197,
      197,
      'mastered',
      '2024-07-29T20:58:05+00:00',
    ),
    completion(
      11732,
      'Pokémon Platinum Version',
      18,
      101,
      23,
      'beaten-softcore',
      '2023-12-30T18:51:28+00:00',
    ),
  ],
};

const COMPLETED = [
  {
    GameID: 11732,
    Title: 'Pokémon Platinum Version',
    ConsoleID: 18,
    ConsoleName: 'Nintendo DS',
    MaxPossible: 101,
    NumAwarded: 23,
    PctWon: '0.2277',
    HardcoreMode: '0',
  },
  {
    GameID: 1,
    Title: 'Sonic the Hedgehog',
    ConsoleID: 1,
    ConsoleName: 'Genesis/Mega Drive',
    MaxPossible: 35,
    NumAwarded: 35,
    PctWon: '1.0000',
    HardcoreMode: '0',
  },
  {
    GameID: 1,
    Title: 'Sonic the Hedgehog',
    ConsoleID: 1,
    ConsoleName: 'Genesis/Mega Drive',
    MaxPossible: 35,
    NumAwarded: 35,
    PctWon: '1.0000',
    HardcoreMode: '1',
  },
];

const ach = (id: number, order: number, awarded: number, earned?: string, earnedHc?: string) => ({
  ID: id,
  Title: `Ach ${id}`,
  Description: `Do thing ${id}`,
  Points: 5,
  TrueRatio: 6,
  Type: 'progression',
  BadgeName: String(200000 + id),
  NumAwarded: awarded,
  NumAwardedHardcore: 1,
  DisplayOrder: order,
  Author: 'SnowPin',
  AuthorULID: '019TVEANZS2MMVS809D58X76W6',
  DateCreated: '2021-10-18 12:48:16',
  DateModified: '2021-10-18 17:42:45',
  MemAddr: '4f80490f81ba1b10b6d0b2eacc97a32d',
  ...(earned ? { DateEarned: earned } : {}),
  ...(earnedHc ? { DateEarnedHardcore: earnedHc } : {}),
});
const GAME_PROGRESS = {
  ID: 765,
  Title: 'Final Fantasy VI: Advance',
  ConsoleID: 5,
  ConsoleName: 'Game Boy Advance',
  ParentGameID: null,
  NumDistinctPlayers: 2000,
  NumAchievements: 3,
  NumAwardedToUser: 2,
  NumAwardedToUserHardcore: 1,
  UserCompletion: '66.67%',
  UserCompletionHardcore: '33.33%',
  UserTotalPlaytime: 2309,
  ForumTopicID: 14901,
  RichPresencePatch: 'f0b4376697ef98d61959cea0d87a1352',
  ImageIcon: '/Images/070797.png',
  HighestAwardKind: null,
  HighestAwardDate: null,
  Achievements: {
    // Keyed out of display order on purpose.
    '3': ach(3, 3, 500),
    '1': ach(1, 1, 1000, '2026-09-29 21:27:17', '2026-09-29 21:27:17'),
    '2': ach(2, 2, 123, '2026-09-29 22:24:37'),
  },
};

const USER_PROGRESS = {
  '765': {
    NumPossibleAchievements: 85,
    PossibleScore: 576,
    NumAchieved: 2,
    ScoreAchieved: 10,
    NumAchievedHardcore: 0,
    ScoreAchievedHardcore: 0,
  },
};

const CLAIMS = [
  {
    ID: 1,
    ULID: '01BJY8JSBTA7NVT0NYSVDCK5TY',
    User: 'Jamiras',
    GameID: 100,
    GameTitle: 'Old',
    GameIcon: '/Images/1.png',
    ConsoleID: 1,
    ConsoleName: 'NES',
    ClaimType: 0,
    SetType: 1,
    Status: 1,
    Extension: 0,
    Special: 0,
    Created: '2024-01-01 00:00:00',
    DoneTime: '2024-02-01 00:00:00',
    Updated: '2024-02-01 00:00:00',
    UserIsJrDev: 0,
    MinutesLeft: -1000,
  },
  {
    ID: 2,
    ULID: '01BJY8JSBTA7NVT0NYSVDCK5TY',
    User: 'Jamiras',
    GameID: 38995,
    GameTitle: 'Lutter',
    GameIcon: '/Images/156056.png',
    ConsoleID: 81,
    ConsoleName: 'Famicom Disk System',
    ClaimType: 1,
    SetType: 0,
    Status: 0,
    Extension: 2,
    Special: 2,
    Created: '2026-09-12 03:11:34',
    DoneTime: '2026-12-12 03:11:34',
    Updated: '2026-09-12 09:56:54',
    UserIsJrDev: 0,
    MinutesLeft: 105152,
  },
];

// ---------- harness ----------

type Handler = (params: Params) => unknown;

let routes: Record<string, Handler>;
let get: ReturnType<typeof vi.fn>;
let client: Client;

async function setup(defaultUser: string | null = 'marcus1255') {
  get = vi.fn((endpoint: string, params: Params) => {
    const h = routes[endpoint];
    if (!h) throw new Error(`unexpected endpoint ${endpoint}`);
    return Promise.resolve(h(params));
  });
  const ctx: ToolContext = {
    client: { get } as unknown as RAClient,
    catalog: {} as CatalogStore,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    defaultUser: defaultUser ?? undefined,
  };
  const server = new McpServer({ name: 'test', version: '0' });
  registerUserTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
}

async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  const text = content.map(c => c.text).join('');
  return { isError: r.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
}

/** Rows of a table as keyed objects, for readable assertions. */
function rowsOf(value: unknown) {
  const t = value as { cols: string[]; rows: unknown[][] };
  return t.rows.map(r => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
}

beforeEach(async () => {
  routes = {};
  await setup();
});
afterEach(async () => {
  await client.close();
});

// ---------- tests ----------

describe('tool registration', () => {
  it('registers exactly the five user tools, read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'get_user_game_progress',
      'get_user_games',
      'get_user_profile',
      'get_user_social',
      'get_user_unlocks',
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.outputSchema).toBeUndefined();
    }
  });
});

describe('get_user_profile', () => {
  it('projects the cheap profile by default with the configured user', async () => {
    routes.GetUserProfile = () => PROFILE;
    const r = await call('get_user_profile', {});
    expect(get).toHaveBeenCalledWith('GetUserProfile', { u: 'marcus1255' }, TTL.user);
    expect(get).toHaveBeenCalledTimes(1);
    expect(r.json()).toEqual({
      user: 'marcus1255',
      ulid: '01B8KEV961X1RR8V29D0627GY4',
      member_since: '2017-02-10',
      points: 27,
      softcore_points: 206,
      true_points: 33,
      rich_presence: 'Playing Final Fantasy VI: Advance',
      last_game_id: 765,
    });
    expect(r.text).not.toContain('UserPic');
  });

  it('uses GetUserSummary alone for summary and flattens recent unlocks newest first', async () => {
    routes.GetUserSummary = () => SUMMARY;
    const r = await call('get_user_profile', { user: 'someone', include: ['summary'] });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('GetUserSummary', { u: 'someone', g: 5, a: 10 }, TTL.user);
    const j = r.json();
    expect(j.status).toBe('Offline');
    expect(j.total_ranked).toBe(166278);
    expect(j.rank).toBeUndefined();
    expect(j.last_game).toEqual({
      id: 765,
      title: 'Final Fantasy VI: Advance',
      console: 'Game Boy Advance',
    });
    expect(j.last_game_id).toBeUndefined();
    expect(rowsOf(j.recently_played)).toEqual([
      {
        id: 765,
        title: 'Final Fantasy VI: Advance',
        console: 'Game Boy Advance',
        last_played: '2026-09-30 01:28',
        earned: 2,
        total: 85,
      },
    ]);
    const unlocks = rowsOf(j.recent_unlocks);
    expect(unlocks.map(u => u.id)).toEqual([179024, 179023]);
    expect(j.recent_unlocks.cols).not.toContain('hc');
    expect(r.text).not.toContain('ForumTopicID');
  });

  it('adds awards with counts and kind mapping', async () => {
    routes.GetUserProfile = () => PROFILE;
    routes.GetUserAwards = () => AWARDS;
    const j = (await call('get_user_profile', { include: ['awards'] })).json();
    expect(get).toHaveBeenCalledWith('GetUserAwards', { u: 'marcus1255' }, TTL.user);
    expect(j.awards.total).toBe(2);
    expect(j.awards.beaten).toBe(1);
    expect(j.awards.site).toBe(1);
    expect(j.awards.events).toBeUndefined();
    expect(rowsOf(j.awards)).toEqual([
      {
        date: '2023-12-29',
        kind: 'beaten',
        game_id: 11732,
        title: 'Pokémon Platinum Version',
        console: 'Nintendo DS',
      },
      { date: '2020-04-28', kind: 'Patreon Supporter', game_id: null, title: null, console: null },
    ]);
  });

  it('emits image URLs only when asked', async () => {
    routes.GetUserProfile = () => PROFILE;
    const j = (await call('get_user_profile', { images: true })).json();
    expect(j.avatar).toBe('https://media.retroachievements.org/UserPic/marcus1255.png');
  });

  it('reports "not found" for an empty body', async () => {
    routes.GetUserProfile = () => null;
    expect((await call('get_user_profile', {})).json()).toEqual({ result: 'not found' });
  });

  it('errors when no user and no default', async () => {
    await client.close();
    await setup(null);
    const r = await call('get_user_profile', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"user" is required/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('get_user_unlocks', () => {
  it('defaults to the last 24h via GetUserRecentAchievements', async () => {
    routes.GetUserRecentAchievements = () => UNLOCKS;
    const j = (await call('get_user_unlocks', {})).json();
    expect(get).toHaveBeenCalledWith(
      'GetUserRecentAchievements',
      { u: 'marcus1255', m: 1440 },
      TTL.user,
    );
    expect(j.count).toBe(2);
    expect(j.points).toBe(10);
    expect(j.games).toBe(1);
    expect(j.cols).toEqual(['date', 'game_id', 'game', 'id', 'title', 'points', 'hc', 'type']);
    expect(rowsOf(j)[0]).toMatchObject({ date: '2026-09-29 22:24', id: 179024, hc: true });
    expect(rowsOf(j)[1]).toMatchObject({ id: 179023, hc: false });
  });

  it('passes minutes through', async () => {
    routes.GetUserRecentAchievements = () => [];
    await call('get_user_unlocks', { minutes: 90 });
    expect(get).toHaveBeenCalledWith(
      'GetUserRecentAchievements',
      { u: 'marcus1255', m: 90 },
      TTL.user,
    );
  });

  it('converts from/to to epoch seconds (date-only "to" = end of day) and caches closed ranges longer', async () => {
    routes.GetAchievementsEarnedBetween = () => UNLOCKS;
    await call('get_user_unlocks', { from: '2026-09-01', to: '2026-09-02' });
    expect(get).toHaveBeenCalledWith(
      'GetAchievementsEarnedBetween',
      {
        u: 'marcus1255',
        f: Date.UTC(2026, 8, 1) / 1000,
        t: Date.UTC(2026, 8, 2, 23, 59, 59) / 1000,
      },
      TTL.game,
    );
  });

  it('uses GetAchievementsEarnedOnDay for date and filters hardcore', async () => {
    routes.GetAchievementsEarnedOnDay = () => UNLOCKS;
    const j = (await call('get_user_unlocks', { date: '2026-09-29', hardcore_only: true })).json();
    expect(get.mock.calls[0]?.[0]).toBe('GetAchievementsEarnedOnDay');
    expect(get.mock.calls[0]?.[1]).toEqual({ u: 'marcus1255', d: '2026-09-29' });
    expect(j.count).toBe(1);
    expect(j.cols).not.toContain('hc');
  });

  it('truncates to limit but reports the full count', async () => {
    routes.GetUserRecentAchievements = () => UNLOCKS;
    const j = (await call('get_user_unlocks', { limit: 1 })).json();
    expect(j.count).toBe(2);
    expect(j.rows).toHaveLength(1);
    expect(j.truncated).toBe(true);
  });

  it.each([
    [{ minutes: 5, date: '2026-09-29' }, /only one/],
    [{ from: '2026-09-01', minutes: 5 }, /only one/],
    [{ to: '2026-09-01' }, /requires "from"/],
    [{ from: 'yesterday' }, /ISO date/],
    [{ from: '2026-09-02', to: '2026-09-01' }, /before/],
    [{ minutes: 50000 }, /./],
    [{ date: '29/09/2026' }, /./],
  ])('rejects %j', async (args, msg) => {
    const r = await call('get_user_unlocks', args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(msg);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('get_user_games', () => {
  it('recent: passes c/o upstream (capped at 50) and drops all-zero hardcore columns', async () => {
    routes.GetUserRecentlyPlayedGames = () => RECENT_GAMES;
    const j = (await call('get_user_games', { list: 'recent', limit: 100, offset: 5 })).json();
    expect(get).toHaveBeenCalledWith(
      'GetUserRecentlyPlayedGames',
      { u: 'marcus1255', c: 50, o: 5 },
      TTL.user,
    );
    expect(j.cols).toEqual([
      'id',
      'title',
      'console',
      'last_played',
      'earned',
      'total',
      'points',
      'max_points',
    ]);
    expect(j.offset).toBe(5);
    expect(j.next_offset).toBeUndefined();
  });

  it('progress: plain call pages upstream and reports total', async () => {
    routes.GetUserCompletionProgress = () => ({ ...COMPLETION, Total: 40 });
    const j = (await call('get_user_games', { list: 'progress', limit: 3 })).json();
    expect(get).toHaveBeenCalledWith(
      'GetUserCompletionProgress',
      { u: 'marcus1255', c: 3, o: 0 },
      TTL.user,
    );
    expect(j.total).toBe(40);
    expect(j.next_offset).toBe(3);
    expect(rowsOf(j)[1]).toMatchObject({ id: 668, award: 'mastered', award_date: '2024-07-29' });
    expect(rowsOf(j)[2]).toMatchObject({ award: 'beaten' });
    expect(j.cols).not.toContain('earned_hc');
  });

  it.each([
    ['mastered', [668]],
    ['beaten', [668, 11732]],
    ['in_progress', [765]],
    ['unfinished', [765, 11732]],
  ])('progress: status=%s filters client-side over the full list', async (status, ids) => {
    routes.GetUserCompletionProgress = () => COMPLETION;
    const j = (await call('get_user_games', { list: 'progress', status })).json();
    expect(get).toHaveBeenCalledWith(
      'GetUserCompletionProgress',
      { u: 'marcus1255', c: 500, o: 0 },
      TTL.user,
    );
    expect(rowsOf(j).map(r => r.id)).toEqual(ids);
  });

  it('progress: console filter + percent sort, paging through upstream pages', async () => {
    // Page 1 full (500 rows) forces a second request.
    const filler = Array.from({ length: 500 }, (_, i) =>
      completion(100000 + i, `Filler ${i}`, 18, 10, 1, null, '2020-01-01T00:00:00+00:00'),
    );
    routes.GetUserCompletionProgress = p =>
      p.o === 0
        ? { Count: 500, Total: 503, Results: filler }
        : { Count: 3, Total: 503, Results: COMPLETION.Results };
    const j = (
      await call('get_user_games', { list: 'progress', console_id: 5, sort: 'percent' })
    ).json();
    expect(get).toHaveBeenCalledTimes(2);
    expect(rowsOf(j).map(r => r.id)).toEqual([668, 765]);
    expect(j.cols).not.toContain('console');
  });

  it('completed: keeps only 100% games and merges hardcore/softcore rows', async () => {
    routes.GetUserCompletedGames = () => COMPLETED;
    const j = (await call('get_user_games', { list: 'completed' })).json();
    expect(rowsOf(j)).toEqual([
      {
        id: 1,
        title: 'Sonic the Hedgehog',
        console: 'Genesis/Mega Drive',
        achievements: 35,
        hardcore: true,
      },
    ]);
  });

  it('want_to_play: pages upstream', async () => {
    routes.GetUserWantToPlayList = () => ({
      Count: 1,
      Total: 1,
      Results: [
        {
          ID: 5853,
          Title: 'Pokémon Black Version 2',
          ImageIcon: '/Images/105979.png',
          ConsoleID: 18,
          ConsoleName: 'Nintendo DS',
          PointsTotal: 1000,
          AchievementsPublished: 90,
        },
      ],
    });
    const j = (await call('get_user_games', { list: 'want_to_play', images: true })).json();
    expect(get).toHaveBeenCalledWith(
      'GetUserWantToPlayList',
      { u: 'marcus1255', c: 25, o: 0 },
      TTL.user,
    );
    expect(rowsOf(j)[0]).toMatchObject({
      id: 5853,
      achievements: 90,
      points: 1000,
      icon: 'https://media.retroachievements.org/Images/105979.png',
    });
    expect(j.total).toBe(1);
  });

  it.each([
    [{ list: 'recent', status: 'mastered' }, /only to list="progress"/],
    [{ list: 'completed', sort: 'title' }, /only to list="progress"/],
    [{ list: 'recent', console_id: 5 }, /not supported/],
  ])('rejects %j', async (args, msg) => {
    const r = await call('get_user_games', args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(msg);
  });
});

describe('get_user_game_progress', () => {
  it('summarises and lists locked achievements by default, with rarity', async () => {
    routes.GetGameInfoAndUserProgress = () => GAME_PROGRESS;
    const r = await call('get_user_game_progress', { game_id: 765 });
    expect(get).toHaveBeenCalledWith(
      'GetGameInfoAndUserProgress',
      { u: 'marcus1255', g: 765, a: 1 },
      TTL.user,
    );
    const j = r.json();
    expect(j).toMatchObject({
      id: 765,
      title: 'Final Fantasy VI: Advance',
      console: 'Game Boy Advance',
      earned: 2,
      earned_hc: 1,
      total: 3,
      pct: 66.67,
      pct_hc: 33.33,
      points: 10,
      points_hc: 5,
      max_points: 15,
      playtime_min: 38,
      players: 2000,
    });
    expect(rowsOf(j.achievements)).toEqual([
      {
        id: 3,
        title: 'Ach 3',
        description: 'Do thing 3',
        points: 5,
        type: 'progression',
        rarity: 25,
      },
    ]);
    expect(r.text).not.toMatch(/MemAddr|RichPresencePatch|ForumTopicID|DisplayOrder|AuthorULID/);
  });

  it('unlocked: sorted by display order with earned date + hardcore flag', async () => {
    routes.GetGameInfoAndUserProgress = () => GAME_PROGRESS;
    const j = (
      await call('get_user_game_progress', { game_id: 765, achievements: 'unlocked' })
    ).json();
    expect(rowsOf(j.achievements)).toEqual([
      expect.objectContaining({ id: 1, rarity: 50, earned: '2026-09-29 21:27', hc: true }),
      expect.objectContaining({ id: 2, rarity: 6.2, earned: '2026-09-29 22:24', hc: null }),
    ]);
  });

  it('all + limit paginates; none omits the table', async () => {
    routes.GetGameInfoAndUserProgress = () => GAME_PROGRESS;
    const all = (
      await call('get_user_game_progress', { game_id: 765, achievements: 'all', limit: 2 })
    ).json();
    expect(all.achievements.rows).toHaveLength(2);
    expect(all.achievements.total).toBe(3);
    expect(all.achievements.next_offset).toBe(2);
    const none = (
      await call('get_user_game_progress', { game_id: 765, achievements: 'none' })
    ).json();
    expect(none.achievements).toBeUndefined();
  });

  it('include_rank adds GetUserGameRankAndScore', async () => {
    routes.GetGameInfoAndUserProgress = () => GAME_PROGRESS;
    routes.GetUserGameRankAndScore = () => [
      { User: 'marcus1255', ULID: 'x', UserRank: 1324, TotalScore: 184, LastAward: null },
    ];
    const j = (
      await call('get_user_game_progress', {
        game_id: 765,
        include_rank: true,
        achievements: 'none',
      })
    ).json();
    expect(get).toHaveBeenCalledWith(
      'GetUserGameRankAndScore',
      { u: 'marcus1255', g: 765 },
      TTL.user,
    );
    expect(j.rank).toBe(1324);
    expect(j.rank_score).toBe(184);
  });

  it('game_ids: one summary row per game via GetUserProgress', async () => {
    routes.GetUserProgress = () => USER_PROGRESS;
    const j = (await call('get_user_game_progress', { game_ids: [765, 765, 1] })).json();
    expect(get).toHaveBeenCalledWith('GetUserProgress', { u: 'marcus1255', i: '765,1' }, TTL.user);
    expect(rowsOf(j)[0]).toEqual({
      id: 765,
      earned: 2,
      earned_hc: 0,
      total: 85,
      points: 10,
      points_hc: 0,
      max_points: 576,
    });
    expect(rowsOf(j)[1]).toMatchObject({ id: 1, earned: null });
  });

  it.each([
    [{}, /exactly one/],
    [{ game_id: 1, game_ids: [2] }, /exactly one/],
    [{ game_ids: [1], include_rank: true }, /needs "game_id"/],
  ])('rejects %j', async (args, msg) => {
    const r = await call('get_user_game_progress', args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(msg);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('get_user_social', () => {
  it('following: no user param upstream, c/o passed through', async () => {
    routes.GetUsersIFollow = () => ({
      Count: 1,
      Total: 3,
      Results: [
        { User: 'zuliman92', ULID: 'x', Points: 1882, PointsSoftcore: 258, IsFollowingMe: true },
      ],
    });
    const j = (await call('get_user_social', { kind: 'following', limit: 1 })).json();
    expect(get).toHaveBeenCalledWith('GetUsersIFollow', { c: 1, o: 0 }, TTL.user);
    expect(rowsOf(j)).toEqual([
      { user: 'zuliman92', points: 1882, softcore_points: 258, mutual: true },
    ]);
    expect(j.total).toBe(3);
    expect(j.next_offset).toBe(1);
  });

  it('followers: rejects another user', async () => {
    const r = await call('get_user_social', { kind: 'followers', user: 'someoneelse' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/API-key owner/);
  });

  it('set_requests: t=1 when all_requests', async () => {
    routes.GetUserSetRequests = () => ({
      RequestedSets: [
        {
          GameID: 5853,
          Title: 'Pokémon Black Version 2',
          ImageIcon: '/i.png',
          ConsoleID: 18,
          ConsoleName: 'Nintendo DS',
        },
      ],
      TotalRequests: 9,
      PointsForNext: 1017,
    });
    const j = (await call('get_user_social', { kind: 'set_requests', all_requests: true })).json();
    expect(get).toHaveBeenCalledWith('GetUserSetRequests', { u: 'marcus1255', t: 1 }, TTL.feed);
    expect(j).toMatchObject({ allowed: 9, points_for_next: 1017 });
    expect(rowsOf(j)).toEqual([
      { id: 5853, title: 'Pokémon Black Version 2', console: 'Nintendo DS' },
    ]);
  });

  it('claims: newest first with decoded enums', async () => {
    routes.GetUserClaims = () => CLAIMS;
    const j = (await call('get_user_social', { kind: 'claims', user: 'Jamiras' })).json();
    expect(get).toHaveBeenCalledWith('GetUserClaims', { u: 'Jamiras' }, TTL.feed);
    expect(rowsOf(j)).toEqual([
      {
        game_id: 38995,
        game: 'Lutter',
        console: 'Famicom Disk System',
        status: 'active',
        set: 'new',
        collab: true,
        special: 'free_rollout',
        created: '2026-09-12',
        done: '2026-12-12',
        extensions: 2,
      },
      {
        game_id: 100,
        game: 'Old',
        console: 'NES',
        status: 'complete',
        set: 'revision',
        collab: null,
        special: null,
        created: '2024-01-01',
        done: '2024-02-01',
        extensions: null,
      },
    ]);
  });
});
