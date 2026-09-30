import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RAError, TTL } from '../client.js';
import { badgeUrl, bool, flag, imageUrl, num, paginate, table, ts } from '../format.js';
import {
  handler,
  idParam,
  imagesParam,
  lean,
  limitParam,
  offsetParam,
  pageBucket,
  READ_ONLY,
  resolveUser,
  ToolInputError,
  userParam,
  type ToolContext,
} from './common.js';

// ---------- shared upstream shapes ----------

interface RawConsole {
  ID: number;
  Name: string;
  Active?: boolean;
  IsGameSystem?: boolean;
}

/** Wall-clock budget for an all-consoles search before returning partial results. */
const SEARCH_BUDGET_MS = 20_000;

export async function getConsoles(ctx: ToolContext): Promise<readonly RawConsole[]> {
  // a=0/g=0: fetch the full list once and filter locally, so every variant of the
  // question shares one cache entry.
  return (await ctx.client.get<RawConsole[] | null>('GetConsoleIDs', {}, TTL.static)) ?? [];
}

/**
 * Consoles whose catalogs a cross-console search loads. Game systems only; when only
 * games WITH achievement sets are wanted, only Active systems (inactive ones have no
 * published sets, so their catalogs would be fetched just to come back empty).
 */
export function searchableConsoleIds(
  consoles: readonly RawConsole[],
  hasAchievements: boolean,
): number[] {
  return consoles
    .filter(c => c.IsGameSystem !== false && (!hasAchievements || c.Active !== false))
    .map(c => c.ID);
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Relevance score for a title against query tokens; -1 = no match. Every token must
 * appear. Exact > prefix > substring, then untagged titles ("~Hack~", "[Subset …]")
 * before tagged ones, then shorter titles first.
 */
export function scoreTitle(title: string, q: string, tokens: string[]): number {
  const t = normalizeTitle(title);
  if (!tokens.every(tok => t.includes(tok))) return -1;
  let s = 0;
  if (t === q) s += 1000;
  else if (t.startsWith(q)) s += 500;
  else if (t.includes(q)) s += 250;
  if (!/[~[]/.test(title)) s += 100;
  s -= Math.min(t.length, 99);
  return s;
}

export function registerGameTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_consoles',
    {
      description: 'IDs of the active RetroAchievements game systems.',
      inputSchema: lean(z.object({})),
      annotations: READ_ONLY,
    },
    handler(ctx, 'list_consoles', async () => {
      const consoles = (await getConsoles(ctx)).filter(
        c => c.IsGameSystem !== false && c.Active !== false,
      );
      return table(consoles, [
        ['id', c => c.ID],
        ['name', c => c.Name],
      ]);
    }),
  );

  server.registerTool(
    'find_games',
    {
      description: 'Find game IDs by title and/or console. First all-console search may be slow.',
      inputSchema: lean(
        z.object({
          query: z.string().min(1).max(100).optional().describe('All words must match'),
          console_id: z.number().int().positive().optional(),
          has_achievements: z.boolean().default(true),
          limit: limitParam(25, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(ctx, 'find_games', async ({ query, console_id, has_achievements, limit, offset }) => {
      if (!query && console_id === undefined) {
        throw new ToolInputError('Provide "query", "console_id", or both.');
      }
      const consoleIds =
        console_id !== undefined
          ? [console_id]
          : searchableConsoleIds(await getConsoles(ctx), has_achievements);

      // RA has no title-search endpoint, so the catalogs ARE the index (see
      // CatalogStore). ROM hashes live in get_game (include "hashes"), not here.
      const {
        games: all,
        loading,
        failed,
      } = await ctx.catalog.getMany(consoleIds, has_achievements, SEARCH_BUDGET_MS);
      let games = all;

      if (query) {
        const q = normalizeTitle(query);
        const tokens = q.split(' ').filter(Boolean);
        games = games
          .map(g => ({ g, s: scoreTitle(g.Title, q, tokens) }))
          .filter(x => x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .map(x => x.g);
      } else {
        games = [...games].sort((a, b) => a.Title.localeCompare(b.Title));
      }

      const page = paginate(games, offset, limit);
      const single = console_id !== undefined;
      const incomplete = [
        loading.length
          ? `${loading.length}/${consoleIds.length} consoles still loading in background; repeat shortly for full results`
          : '',
        failed.length
          ? `${failed.length}/${consoleIds.length} consoles failed to load (upstream error); retry later`
          : '',
      ]
        .filter(Boolean)
        .join('. ');
      return {
        ...(single ? { console: page.items[0]?.ConsoleName ?? console_id } : {}),
        ...table(page.items, [
          ['id', g => g.ID],
          ['title', g => g.Title],
          ['console', g => (single ? undefined : g.ConsoleName)],
          ['achievements', g => num(g.NumAchievements)],
          ['points', g => num(g.Points)],
          ['leaderboards', g => num(g.NumLeaderboards) || undefined],
          ['updated', g => ts(g.DateModified)?.slice(0, 10)],
        ]),
        ...page.meta,
        ...(incomplete ? { incomplete } : {}),
      };
    }),
  );

  registerGameDetailTools(server, ctx);
}

// ---------- game detail tools ----------

interface RawGame {
  Title: string;
  ConsoleID?: number;
  ConsoleName?: string;
  Publisher?: string | null;
  Developer?: string | null;
  Genre?: string | null;
  Released?: string | null;
  ReleasedAtGranularity?: string | null;
  ImageIcon?: string | null;
  ImageBoxArt?: string | null;
  // GetGameExtended only:
  ParentGameID?: number | null;
  NumDistinctPlayers?: number;
  NumAchievements?: number;
  GuideURL?: string | null;
  Updated?: string | null;
  Achievements?: Record<string, RawGameAchievement> | RawGameAchievement[];
  Claims?: RawClaim[];
}

interface RawGameAchievement {
  ID: number;
  Title: string;
  Description?: string;
  Points: number;
  TrueRatio?: number;
  NumAwarded?: number;
  NumAwardedHardcore?: number;
  BadgeName?: string;
  DisplayOrder?: number;
  /** GetGameExtended spells it `type`; GetGameProgression `Type`. */
  type?: string | null;
  Type?: string | null;
}

interface RawClaim {
  User: string;
  SetType: number;
  ClaimType: number;
  Created?: string;
  Expiration?: string;
}

interface RawHash {
  Name: string;
  MD5: string;
  Labels?: string[];
  PatchUrl?: string | null;
}

interface RawProgression {
  NumDistinctPlayers?: number;
  TimesUsedInBeatMedian?: number;
  TimesUsedInHardcoreBeatMedian?: number;
  MedianTimeToBeat?: number;
  MedianTimeToBeatHardcore?: number;
  TimesUsedInCompletionMedian?: number;
  TimesUsedInMasteryMedian?: number;
  MedianTimeToComplete?: number;
  MedianTimeToMaster?: number;
  Achievements?: (RawGameAchievement & {
    MedianTimeToUnlock?: number;
    MedianTimeToUnlockHardcore?: number;
  })[];
}

interface RawRank {
  User: string;
  NumAchievements: number;
  TotalScore: number;
  LastAward?: string;
}

interface RawPaged<T> {
  Count?: number;
  Total?: number;
  Results?: T[];
}

interface RawBoard {
  ID: number;
  RankAsc?: boolean;
  Title: string;
  Description?: string;
  State?: string;
  TopEntry?: { User?: string; FormattedScore?: string } | null;
  UserEntry?: { FormattedScore?: string; Rank?: number; DateUpdated?: string } | null;
}

interface RawEntry {
  Rank?: number;
  User: string;
  FormattedScore?: string;
  Score?: number;
  DateSubmitted?: string;
}

interface RawUnlocks {
  Achievement?: {
    ID: number;
    Title: string;
    Description?: string;
    Points?: number;
    TrueRatio?: number;
    Author?: string;
    DateCreated?: string;
    Type?: string | null;
  };
  Console?: { ID: number; Title: string };
  Game?: { ID: number; Title: string };
  UnlocksCount?: number;
  UnlocksHardcoreCount?: number;
  TotalPlayers?: number;
  Unlocks?: { User: string; DateAwarded?: string; HardcoreMode?: number | boolean }[];
}

const ACH_TYPES = ['progression', 'win_condition', 'missable', 'none'] as const;
const GAME_INCLUDES = ['achievements', 'hashes', 'progression', 'distribution', 'claims'] as const;

/** n/d as a percentage with one decimal; undefined when d is 0/unknown. */
export function pct(n: unknown, d: unknown): number | undefined {
  const a = num(n);
  const b = num(d);
  if (a === undefined || !b) return undefined;
  return Math.round((a / b) * 1000) / 10;
}

/** Seconds → hours, one decimal (RA median times are seconds). */
const hours = (s: unknown) => {
  const n = num(s);
  return n ? Math.round(n / 360) / 10 : undefined;
};
/** Seconds → minutes, one decimal. */
const minutes = (s: unknown) => {
  const n = num(s);
  return n ? Math.round(n / 6) / 10 : undefined;
};

const achType = (a: { type?: string | null; Type?: string | null }) =>
  (a.type ?? a.Type) || undefined;

function matchesType(a: RawGameAchievement, want: (typeof ACH_TYPES)[number] | undefined) {
  if (!want) return true;
  const t = achType(a);
  return want === 'none' ? !t : t === want;
}

/** The fields GetGame returns; projected identically from any superset response. */
const BASE_FIELDS = [
  'Title',
  'ConsoleID',
  'ConsoleName',
  'Publisher',
  'Developer',
  'Genre',
  'Released',
  'ReleasedAtGranularity',
  'ImageIcon',
  'ImageBoxArt',
] as const;

/**
 * Base game info. Served from an already-cached superset — GetGameExtended, or ANY
 * user's GetGameInfoAndUserProgress for this game — when one is warm, else GetGame.
 * Projected to GetGame's fields so the answer doesn't depend on what happens to be
 * cached. (Never the reverse: InfoAndUserProgress lacks Claims/GuideURL/Updated, so it
 * cannot stand in for GetGameExtended.)
 */
async function baseGame(ctx: ToolContext, id: number): Promise<RawGame | null> {
  const warm =
    ctx.client.peek<RawGame | null>('GetGameExtended', { i: id }) ??
    ctx.client.peekAny<RawGame | null>('GetGameInfoAndUserProgress', { g: id });
  if (warm && typeof warm === 'object' && !Array.isArray(warm) && warm.Title) {
    const out: Record<string, unknown> = {};
    for (const k of BASE_FIELDS) if (warm[k] !== undefined) out[k] = warm[k];
    return out as unknown as RawGame;
  }
  return ctx.client.get<RawGame | null>('GetGame', { i: id }, TTL.game);
}

/** Paging meta when upstream was asked for `c ≥ limit` rows and we show a prefix. */
function slicedMeta(offset: number, raw: number, shown: number, c: number, total?: number) {
  const next = offset + shown;
  const more = total !== undefined ? next < total : raw > shown || raw >= c;
  return {
    ...(total !== undefined ? { total } : {}),
    ...(offset > 0 ? { offset } : {}),
    ...(more && shown > 0 ? { next_offset: next } : {}),
  };
}

function registerGameDetailTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_game',
    {
      description:
        'Game details; include adds achievements (rarity, type), hashes, progression (median times), distribution, claims.',
      inputSchema: lean(
        z.object({
          game_id: idParam(),
          include: z.array(z.enum(GAME_INCLUDES)).default([]),
          achievement_type: z.enum(ACH_TYPES).optional().describe('none = untyped'),
          images: imagesParam,
          limit: limitParam(50, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'get_game',
      async ({ game_id, include, achievement_type, images, limit, offset }) => {
        const inc = new Set(include);
        if (achievement_type && !inc.has('achievements') && !inc.has('progression')) {
          throw new ToolInputError(
            '"achievement_type" needs include "achievements" or "progression".',
          );
        }
        // GetGameExtended (~16 KB) is a superset of GetGame (~0.5 KB): use it only
        // when its extras (achievements, claims) are wanted, and never call both.
        const extended = inc.has('achievements') || inc.has('claims');
        const [g, hashes, prog, dist] = await Promise.all([
          extended
            ? ctx.client.get<RawGame | null>('GetGameExtended', { i: game_id }, TTL.game)
            : baseGame(ctx, game_id),
          inc.has('hashes')
            ? ctx.client.get<{ Results?: RawHash[] } | null>(
                'GetGameHashes',
                { i: game_id },
                TTL.static,
              )
            : undefined,
          inc.has('progression')
            ? ctx.client.get<RawProgression | null>('GetGameProgression', { i: game_id }, TTL.slow)
            : undefined,
          inc.has('distribution')
            ? ctx.client.get<Record<string, number> | null>(
                'GetAchievementDistribution',
                { i: game_id },
                TTL.game,
              )
            : undefined,
        ]);
        // Unknown IDs come back as null, [] or an object without a title.
        if (!g || typeof g !== 'object' || Array.isArray(g) || !g.Title) return null;

        // Copy before sorting: upstream bodies are shared (and frozen) cache values.
        const achievements = g.Achievements
          ? [
              ...(Array.isArray(g.Achievements) ? g.Achievements : Object.values(g.Achievements)),
            ].sort((a, b) => (a.DisplayOrder ?? 0) - (b.DisplayOrder ?? 0) || a.ID - b.ID)
          : undefined;
        const players = num(g.NumDistinctPlayers) ?? num(prog?.NumDistinctPlayers);
        const released =
          g.Released && g.ReleasedAtGranularity === 'year'
            ? g.Released.slice(0, 4)
            : g.Released && g.ReleasedAtGranularity === 'month'
              ? g.Released.slice(0, 7)
              : g.Released;

        const out: Record<string, unknown> = {
          id: game_id,
          title: g.Title,
          console: g.ConsoleName,
          console_id: g.ConsoleID,
          parent_id: g.ParentGameID,
          developer: g.Developer,
          publisher: g.Publisher,
          genre: g.Genre,
          released,
          players,
          achievements: achievements?.length ?? num(g.NumAchievements),
          points: achievements?.reduce((s, a) => s + (num(a.Points) ?? 0), 0),
          retro_points: achievements?.reduce((s, a) => s + (num(a.TrueRatio) ?? 0), 0),
          updated: ts(g.Updated),
          guide: g.GuideURL,
          ...(images ? { icon: imageUrl(g.ImageIcon), box_art: imageUrl(g.ImageBoxArt) } : {}),
        };

        if (prog) {
          out.median_hours = {
            beat: hours(prog.MedianTimeToBeat),
            beat_hc: hours(prog.MedianTimeToBeatHardcore),
            complete: hours(prog.MedianTimeToComplete),
            master: hours(prog.MedianTimeToMaster),
          };
        }
        const progById = new Map((prog?.Achievements ?? []).map(a => [a.ID, a]));

        if (achievements && inc.has('achievements')) {
          const page = paginate(
            achievements.filter(a => matchesType(a, achievement_type)),
            offset,
            limit,
          );
          out.achievement_list = {
            ...table(page.items, [
              ['id', a => a.ID],
              ['title', a => a.Title],
              ['description', a => a.Description],
              ['points', a => num(a.Points)],
              ['retro', a => num(a.TrueRatio)],
              ['type', a => achType(a)],
              ['rarity', a => pct(a.NumAwarded, players)],
              ['rarity_hc', a => pct(a.NumAwardedHardcore, players)],
              ['median_min', a => minutes(progById.get(a.ID)?.MedianTimeToUnlock)],
              ['median_hc_min', a => minutes(progById.get(a.ID)?.MedianTimeToUnlockHardcore)],
              ['badge', a => (images ? badgeUrl(a.BadgeName) : undefined)],
            ]),
            ...page.meta,
          };
        } else if (prog?.Achievements) {
          // Progression alone: order by median unlock time — the typical play order.
          const rows = prog.Achievements.filter(a => matchesType(a, achievement_type)).sort(
            (a, b) =>
              (a.MedianTimeToUnlock || Infinity) - (b.MedianTimeToUnlock || Infinity) ||
              a.ID - b.ID,
          );
          const page = paginate(rows, offset, limit);
          out.achievement_progression = {
            ...table(page.items, [
              ['id', a => a.ID],
              ['title', a => a.Title],
              ['points', a => num(a.Points)],
              ['type', a => achType(a)],
              ['median_min', a => minutes(a.MedianTimeToUnlock)],
              ['median_hc_min', a => minutes(a.MedianTimeToUnlockHardcore)],
            ]),
            ...page.meta,
          };
        }

        if (dist && typeof dist === 'object' && !Array.isArray(dist)) {
          // Upstream keys are "number of achievements unlocked" (1..N), values player
          // counts. As an array (index 0 = exactly 1 unlock; gaps filled with 0) the
          // keys cost nothing; the convention is in the field name.
          const n = Math.max(0, ...Object.keys(dist).map(Number).filter(Number.isInteger));
          out.players_by_unlocks_from_1 = Array.from(
            { length: n },
            (_, i) => num(dist[i + 1]) ?? 0,
          );
        }

        if (inc.has('claims')) {
          out.claims = table(g.Claims ?? [], [
            ['user', c => c.User],
            ['set', c => (c.SetType === 1 ? 'revision' : 'new')],
            ['collab', c => flag(c.ClaimType === 1)],
            ['created', c => ts(c.Created)],
            ['expires', c => ts(c.Expiration)],
          ]);
        }

        if (hashes) {
          out.hashes = table(hashes.Results ?? [], [
            ['md5', h => h.MD5],
            ['name', h => h.Name],
            ['labels', h => (h.Labels?.length ? h.Labels.join(',') : undefined)],
            ['patch', h => h.PatchUrl],
          ]);
        }
        return out;
      },
    ),
  );

  server.registerTool(
    'get_game_rankings',
    {
      description: "A game's top 10: highest scorers, or most recent masters.",
      inputSchema: lean(
        z.object({
          game_id: idParam(),
          type: z.enum(['high_scores', 'latest_masters']).default('high_scores'),
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(ctx, 'get_game_rankings', async ({ game_id, type }) => {
      const rows =
        (await ctx.client.get<RawRank[] | null>(
          'GetGameRankAndScore',
          { g: game_id, t: type === 'latest_masters' ? 1 : 0 },
          TTL.feed,
        )) ?? [];
      return table(Array.isArray(rows) ? rows : [], [
        ['user', r => r.User],
        ['achievements', r => num(r.NumAchievements)],
        ['points', r => num(r.TotalScore)],
        ['last_award', r => ts(r.LastAward)],
      ]);
    }),
  );

  server.registerTool(
    'get_leaderboards',
    {
      description:
        "A game's leaderboards (user_entries: the user's entries), or one leaderboard's ranked entries. Give game_id or leaderboard_id.",
      inputSchema: lean(
        z.object({
          game_id: z.number().int().positive().optional(),
          leaderboard_id: z.number().int().positive().optional(),
          user_entries: z.boolean().default(false),
          user: userParam,
          limit: limitParam(25, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'get_leaderboards',
      async ({ game_id, leaderboard_id, user_entries, user, limit, offset }) => {
        if ((game_id === undefined) === (leaderboard_id === undefined)) {
          throw new ToolInputError('Provide exactly one of "game_id" or "leaderboard_id".');
        }
        // Upstream page size is bucketed (shared cache entries) and sliced here.
        const c = pageBucket(limit);
        if (leaderboard_id !== undefined) {
          if (user_entries || user !== undefined) {
            throw new ToolInputError(
              '"user_entries"/"user" apply to game_id; leaderboard entries are for all users.',
            );
          }
          const r = await ctx.client.get<RawPaged<RawEntry> | null>(
            'GetLeaderboardEntries',
            { i: leaderboard_id, c, o: offset },
            TTL.feed,
          );
          const raw = r?.Results ?? [];
          const rows = raw.slice(0, limit);
          return {
            ...table(rows, [
              ['rank', e => e.Rank],
              ['user', e => e.User],
              ['score', e => e.FormattedScore ?? e.Score],
              ['date', e => ts(e.DateSubmitted)],
            ]),
            ...slicedMeta(offset, raw.length, rows.length, c, num(r?.Total)),
          };
        }

        const gid = game_id as number;
        if (user_entries || user !== undefined) {
          const u = resolveUser(ctx, user);
          // Echo the user only when it was defaulted — the caller knows its own input.
          const who = user === undefined ? { user: u } : {};
          let r: RawPaged<RawBoard> | null;
          try {
            r = await ctx.client.get<RawPaged<RawBoard> | null>(
              'GetUserGameLeaderboards',
              { i: gid, u, c, o: offset },
              TTL.user,
            );
          } catch (e) {
            // RA answers 422 ["User has no leaderboards on this game"] for "no entries";
            // any other 422 (bad user, validation) is a real error.
            if (e instanceof RAError && e.status === 422 && /no leaderboards/i.test(e.message)) {
              return { ...who, total: 0, note: 'no leaderboard entries' };
            }
            throw e;
          }
          const raw = r?.Results ?? [];
          const rows = raw.slice(0, limit);
          return {
            ...who,
            ...table(rows, [
              ['id', b => b.ID],
              ['title', b => b.Title],
              ['score', b => b.UserEntry?.FormattedScore],
              ['rank', b => b.UserEntry?.Rank],
              ['date', b => ts(b.UserEntry?.DateUpdated)],
              ['lower_better', b => flag(b.RankAsc)],
            ]),
            ...slicedMeta(offset, raw.length, rows.length, c, num(r?.Total)),
          };
        }

        const r = await ctx.client.get<RawPaged<RawBoard> | null>(
          'GetGameLeaderboards',
          { i: gid, c, o: offset },
          TTL.game,
        );
        const raw = r?.Results ?? [];
        const rows = raw.slice(0, limit);
        return {
          ...table(rows, [
            ['id', b => b.ID],
            ['title', b => b.Title.trim()],
            ['description', b => b.Description],
            ['top_user', b => b.TopEntry?.User],
            ['top_score', b => b.TopEntry?.FormattedScore],
            ['lower_better', b => flag(b.RankAsc)],
            ['state', b => (b.State && b.State !== 'active' ? b.State : undefined)],
          ]),
          ...slicedMeta(offset, raw.length, rows.length, c, num(r?.Total)),
        };
      },
    ),
  );

  server.registerTool(
    'get_achievement_unlocks',
    {
      description: 'Who unlocked an achievement (newest first), with unlock rates.',
      inputSchema: lean(
        z.object({
          achievement_id: idParam(),
          hardcore_only: z.boolean().default(false),
          limit: limitParam(25, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'get_achievement_unlocks',
      async ({ achievement_id, hardcore_only, limit, offset }) => {
        // Upstream has no hardcore filter, so with hardcore_only we over-fetch (4× the
        // limit, capped at the upstream max of 500) and filter; next_offset then points
        // into the UPSTREAM list, just past the last row scanned. The page size is
        // bucketed (shared cache entries) and the rows sliced here.
        const fetch = pageBucket(hardcore_only ? Math.min(500, limit * 4) : limit);
        const r = await ctx.client.get<RawUnlocks | null>(
          'GetAchievementUnlocks',
          { a: achievement_id, c: fetch, o: offset },
          TTL.feed,
        );
        if (!r?.Achievement) return null;
        const all = r.Unlocks ?? [];
        let rows = all.slice(0, limit);
        let scanned = rows.length;
        if (hardcore_only) {
          rows = [];
          scanned = 0;
          for (const u of all) {
            scanned++;
            if (bool(u.HardcoreMode)) rows.push(u);
            if (rows.length >= limit) break;
          }
        }
        const a = r.Achievement;
        const total = num(r.UnlocksCount);
        const next = offset + scanned;
        return {
          achievement: {
            id: a.ID,
            title: a.Title,
            description: a.Description,
            points: num(a.Points),
            retro: num(a.TrueRatio),
            type: a.Type || undefined,
            author: a.Author,
            created: ts(a.DateCreated)?.slice(0, 10),
          },
          game: { id: r.Game?.ID, title: r.Game?.Title, console: r.Console?.Title },
          players: num(r.TotalPlayers),
          unlocks: total,
          unlocks_hc: num(r.UnlocksHardcoreCount),
          rarity: pct(r.UnlocksCount, r.TotalPlayers),
          rarity_hc: pct(r.UnlocksHardcoreCount, r.TotalPlayers),
          ...table(rows, [
            ['user', u => u.User],
            ['date', u => ts(u.DateAwarded)],
            ['hc', u => (hardcore_only ? undefined : flag(bool(u.HardcoreMode)))],
          ]),
          ...(offset > 0 ? { offset } : {}),
          ...(total !== undefined && next < total && scanned > 0 ? { next_offset: next } : {}),
        };
      },
    ),
  );
}
