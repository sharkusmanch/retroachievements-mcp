import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { TTL } from '../client.js';
import { badgeUrl, flag, imageUrl, num, paginate, table, ts } from '../format.js';
import {
  awardKind,
  handler,
  imagesParam,
  lean,
  limitParam,
  pageBucket,
  offsetParam,
  READ_ONLY,
  resolveUser,
  ToolInputError,
  userParam,
  type ToolContext,
} from './common.js';

// ---------- upstream shapes (only the fields we read) ----------

interface RawProfile {
  User: string;
  ULID?: string;
  UserPic?: string;
  MemberSince?: string;
  RichPresenceMsg?: string;
  LastGameID?: number;
  ContribCount?: number;
  ContribYield?: number;
  TotalPoints?: number;
  TotalSoftcorePoints?: number;
  TotalTruePoints?: number;
  Untracked?: number | boolean;
  Motto?: string;
}

interface RawSummary extends RawProfile {
  RichPresenceMsgDate?: string;
  Rank?: number | null;
  TotalRanked?: number;
  Status?: string;
  RecentlyPlayed?: {
    GameID: number;
    ConsoleName?: string;
    Title: string;
    ImageIcon?: string;
    LastPlayed?: string;
    AchievementsTotal?: number;
  }[];
  Awarded?: Record<string, { NumAchieved?: number; NumAchievedHardcore?: number }>;
  RecentAchievements?: Record<string, Record<string, RawSummaryAch>>;
  LastGame?: { ID: number; Title: string; ConsoleName?: string } | null;
}

interface RawSummaryAch {
  ID: number;
  GameID: number;
  GameTitle: string;
  Title: string;
  Points: number;
  Type?: string | null;
  DateAwarded: string;
  HardcoreAchieved?: number | string;
}

interface RawAwards {
  TotalAwardsCount?: number;
  HiddenAwardsCount?: number;
  MasteryAwardsCount?: number;
  CompletionAwardsCount?: number;
  BeatenHardcoreAwardsCount?: number;
  BeatenSoftcoreAwardsCount?: number;
  EventAwardsCount?: number;
  SiteAwardsCount?: number;
  VisibleUserAwards?: {
    AwardedAt: string;
    AwardType: string;
    AwardData?: number;
    AwardDataExtra?: number;
    Title?: string | null;
    ConsoleName?: string | null;
    ImageIcon?: string | null;
  }[];
}

interface RawUnlock {
  Date: string;
  HardcoreMode: number | string;
  AchievementID: number;
  Title: string;
  Points: number;
  Type?: string | null;
  GameTitle: string;
  GameID: number;
  ConsoleName?: string;
  BadgeName?: string;
}

interface RawRecentGame {
  GameID: number;
  ConsoleName?: string;
  Title: string;
  ImageIcon?: string;
  LastPlayed?: string;
  NumPossibleAchievements?: number;
  PossibleScore?: number;
  NumAchieved?: number;
  ScoreAchieved?: number;
  NumAchievedHardcore?: number;
  ScoreAchievedHardcore?: number;
}

interface RawCompletion {
  GameID: number;
  Title: string;
  ImageIcon?: string;
  ConsoleID?: number;
  ConsoleName?: string;
  MaxPossible?: number;
  NumAwarded?: number;
  NumAwardedHardcore?: number;
  MostRecentAwardedDate?: string | null;
  HighestAwardKind?: string | null;
  HighestAwardDate?: string | null;
}

interface RawCompleted {
  GameID: number;
  Title: string;
  ImageIcon?: string;
  ConsoleID?: number;
  ConsoleName?: string;
  MaxPossible?: number | string;
  NumAwarded?: number | string;
  PctWon?: string | number;
  HardcoreMode?: string | number;
}

interface RawWantToPlay {
  ID: number;
  Title: string;
  ImageIcon?: string;
  ConsoleID?: number;
  ConsoleName?: string;
  PointsTotal?: number;
  AchievementsPublished?: number;
}

interface RawProgressAch {
  ID: number;
  Title: string;
  Description?: string;
  Points: number;
  Type?: string | null;
  type?: string | null;
  BadgeName?: string;
  NumAwarded?: number;
  DisplayOrder?: number;
  DateEarned?: string;
  DateEarnedHardcore?: string;
}

interface RawGameProgress {
  ID: number;
  Title: string;
  ConsoleName?: string;
  ParentGameID?: number | null;
  ImageIcon?: string;
  NumDistinctPlayers?: number;
  NumAchievements?: number;
  NumAwardedToUser?: number;
  NumAwardedToUserHardcore?: number;
  UserCompletion?: string;
  UserCompletionHardcore?: string;
  UserTotalPlaytime?: number;
  HighestAwardKind?: string | null;
  HighestAwardDate?: string | null;
  Achievements?: Record<string, RawProgressAch> | RawProgressAch[];
}

interface RawUserProgress {
  NumPossibleAchievements?: number;
  PossibleScore?: number;
  NumAchieved?: number;
  ScoreAchieved?: number;
  NumAchievedHardcore?: number;
  ScoreAchievedHardcore?: number;
}

interface RawFollow {
  User: string;
  Points?: number;
  PointsSoftcore?: number;
  IsFollowingMe?: boolean;
  AmIFollowing?: boolean;
}

interface RawClaim {
  GameID: number;
  GameTitle: string;
  ConsoleName?: string;
  ClaimType?: number;
  SetType?: number;
  Status?: number;
  Extension?: number;
  Special?: number;
  Created?: string;
  DoneTime?: string;
}

interface Paged<T> {
  Count?: number;
  Total?: number;
  Results?: T[];
}

// ---------- helpers ----------

/** Upstream page ceiling for the c/o endpoints. */
const MAX_PAGE = 500;
/** Safety cap on pages fetched when a client-side filter needs the whole list. */
const MAX_PAGES = 20;

/** Fetch every page of a `{Count,Total,Results}` endpoint (for client-side filtering). */
async function fetchAll<T>(
  ctx: ToolContext,
  endpoint: string,
  params: Record<string, string | number>,
  ttl: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await ctx.client.get<Paged<T> | null>(
      endpoint,
      { ...params, c: MAX_PAGE, o: page * MAX_PAGE },
      ttl,
    );
    const rows = r?.Results ?? [];
    out.push(...rows);
    if (rows.length < MAX_PAGE || out.length >= (r?.Total ?? 0)) break;
  }
  return out;
}

/** Page metadata for an upstream-paginated call: total when known, next_offset when more. */
function upstreamMeta(offset: number, got: number, limit: number, total?: number, raw = got) {
  const next = offset + got;
  // Without a total: more likely remain if upstream returned more than we showed, or
  // a full page.
  const more = total !== undefined ? next < total : raw > got || got >= limit;
  return {
    ...(total !== undefined ? { total } : {}),
    ...(offset > 0 ? { offset } : {}),
    ...(more ? { next_offset: next } : {}),
  };
}

const isMastery = (k: string | null | undefined) => k === 'mastered' || k === 'completed';

/** `"2.35%"` → 2.35 */
const pct = (v: unknown) => num(typeof v === 'string' ? v.replace('%', '') : v);

const rarity = (awarded: unknown, players: unknown): number | undefined => {
  const a = num(awarded);
  const p = num(players);
  return a !== undefined && p ? Math.round((a / p) * 1000) / 10 : undefined;
};

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Strict ISO date/datetime → epoch seconds. Date-only `end` means end of that day (UTC).
 * Rejects anything Date.parse would "helpfully" accept (`2026-02-30` rolls into March,
 * `Sep 5` parses in local time): a wrong range silently returns the wrong unlocks.
 */
export function epoch(v: string, field: string, end = false): number {
  const m = ISO_DATETIME.exec(v.trim());
  const bad = () => new ToolInputError(`"${field}" must be an ISO date or datetime (UTC)`);
  if (!m) throw bad();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) {
    throw bad();
  }
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const time = m[4] ? m[4].slice(1) : end ? '23:59:59' : '00:00:00';
  // Datetimes without an explicit zone are treated as UTC, like every RA timestamp.
  const zone = m[7] ?? 'Z';
  const ms = Date.parse(`${day}T${time}${zone}`);
  if (Number.isNaN(ms)) throw bad();
  return Math.floor(ms / 1000);
}

/** RA user ULIDs are Crockford base32, 26 chars. */
const isUlid = (s: string | undefined) => !!s && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s);

/** Rows → `{games: {id: title}}` so a title repeated on every row is sent once. */
function gameTitles<T>(rows: readonly T[], id: (r: T) => number, title: (r: T) => string) {
  const games: Record<number, string> = {};
  for (const r of rows) games[id(r)] ??= title(r);
  return games;
}

const CLAIM_STATUS = ['active', 'complete', 'dropped'];
const CLAIM_SPECIAL = [undefined, 'own_revision', 'free_rollout', 'scheduled_release'];

// ---------- tools ----------

export function registerUserTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_user_profile',
    {
      description:
        'User profile and points. include: summary (rank, status, recent games/unlocks), awards.',
      inputSchema: lean(
        z.object({
          user: userParam,
          include: z.array(z.enum(['summary', 'awards'])).default([]),
          limit: limitParam(25, 500).describe('Max award rows'),
          images: imagesParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(ctx, 'get_user_profile', async ({ user, include, limit, images }) => {
      const u = resolveUser(ctx, user);
      const wantSummary = include.includes('summary');
      const wantAwards = include.includes('awards');

      // GetUserSummary is a superset of GetUserProfile, so when the summary is wanted
      // it alone answers both. GetUserPoints is never called: the profile already
      // carries TotalPoints/TotalSoftcorePoints (ra_api_raw covers it if ever needed).
      const [p, awards] = await Promise.all([
        wantSummary
          ? ctx.client.get<RawSummary | null>('GetUserSummary', { u, g: 5, a: 10 }, TTL.user)
          : ctx.client.get<RawProfile | null>('GetUserProfile', { u }, TTL.user),
        wantAwards ? ctx.client.get<RawAwards | null>('GetUserAwards', { u }, TTL.social) : null,
      ]);
      if (!p?.User) return null;

      const out: Record<string, unknown> = {
        user: p.User,
        // ULIDs are noise unless the caller is working with them.
        ulid: isUlid(user) ? p.ULID : undefined,
        member_since: ts(p.MemberSince)?.slice(0, 10),
        motto: p.Motto,
        points: num(p.TotalPoints),
        softcore_points: num(p.TotalSoftcorePoints),
        true_points: num(p.TotalTruePoints),
        contrib_count: num(p.ContribCount) || undefined,
        contrib_yield: num(p.ContribYield) || undefined,
        untracked: p.Untracked === true || p.Untracked === 1 ? true : undefined,
        rich_presence: p.RichPresenceMsg,
        last_game_id: p.LastGameID || undefined,
        avatar: images ? imageUrl(p.UserPic) : undefined,
      };

      if (wantSummary) {
        const s = p as RawSummary;
        out.rank = s.Rank ?? undefined;
        out.total_ranked = s.TotalRanked;
        out.status = s.Status;
        out.rich_presence_at = ts(s.RichPresenceMsgDate);
        if (s.LastGame?.ID) {
          delete out.last_game_id;
          out.last_game = {
            id: s.LastGame.ID,
            title: s.LastGame.Title,
            console: s.LastGame.ConsoleName,
          };
        }
        const awarded = s.Awarded ?? {};
        out.recently_played = table(s.RecentlyPlayed ?? [], [
          ['id', g => g.GameID],
          ['title', g => g.Title],
          ['console', g => g.ConsoleName],
          ['last_played', g => ts(g.LastPlayed)],
          ['earned', g => num(awarded[g.GameID]?.NumAchieved)],
          ['earned_hc', g => num(awarded[g.GameID]?.NumAchievedHardcore) || undefined],
          ['total', g => num(g.AchievementsTotal)],
          ['icon', g => (images ? imageUrl(g.ImageIcon) : undefined)],
        ]);
        // Nested {gameId: {achId: ach}} → flat, newest first.
        const recent = Object.values(s.RecentAchievements ?? {})
          .flatMap(g => Object.values(g))
          .sort((a, b) => (a.DateAwarded < b.DateAwarded ? 1 : -1));
        out.recent_unlocks = {
          games: gameTitles(
            recent,
            a => a.GameID,
            a => a.GameTitle,
          ),
          ...table(recent, [
            ['date', a => ts(a.DateAwarded)],
            ['game_id', a => a.GameID],
            ['id', a => a.ID],
            ['title', a => a.Title],
            ['points', a => num(a.Points)],
            ['hc', a => flag(num(a.HardcoreAchieved) ? 1 : 0)],
            ['type', a => a.Type ?? undefined],
          ]),
        };
      }

      if (awards) {
        const list = [...(awards.VisibleUserAwards ?? [])].sort((a, b) =>
          a.AwardedAt < b.AwardedAt ? 1 : -1,
        );
        const page = paginate(list, 0, limit);
        out.awards = {
          total: num(awards.TotalAwardsCount),
          mastered: num(awards.MasteryAwardsCount),
          completed: num(awards.CompletionAwardsCount),
          beaten_hc: num(awards.BeatenHardcoreAwardsCount),
          beaten: num(awards.BeatenSoftcoreAwardsCount),
          events: num(awards.EventAwardsCount) || undefined,
          site: num(awards.SiteAwardsCount) || undefined,
          hidden: num(awards.HiddenAwardsCount) || undefined,
          ...table(page.items, [
            ['date', a => ts(a.AwardedAt)?.slice(0, 10)],
            [
              'kind',
              a =>
                a.AwardType === 'Mastery/Completion'
                  ? a.AwardDataExtra
                    ? 'mastered'
                    : 'completed'
                  : a.AwardType === 'Game Beaten'
                    ? a.AwardDataExtra
                      ? 'beaten_hc'
                      : 'beaten'
                    : a.AwardType,
            ],
            ['game_id', a => (a.Title ? a.AwardData : undefined)],
            ['title', a => a.Title ?? undefined],
            ['console', a => a.ConsoleName ?? undefined],
            ['icon', a => (images ? imageUrl(a.ImageIcon) : undefined)],
          ]),
          ...(page.meta.next_offset !== undefined ? { shown: page.items.length } : {}),
        };
      }
      return out;
    }),
  );

  server.registerTool(
    'get_user_unlocks',
    {
      description:
        "User's unlocks, newest first. One of minutes, from[/to], date; default last 24h.",
      inputSchema: lean(
        z.object({
          user: userParam,
          minutes: z.number().int().min(1).max(43200).optional(),
          from: z.string().max(40).optional().describe('ISO date/datetime, UTC'),
          to: z.string().max(40).optional().describe('Default now'),
          date: z.string().max(10).optional().describe('YYYY-MM-DD'),
          hardcore_only: z.boolean().default(false),
          limit: limitParam(50, 500),
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'get_user_unlocks',
      async ({ user, minutes, from, to, date, hardcore_only, limit }) => {
        const u = resolveUser(ctx, user);
        const modes = [
          minutes !== undefined,
          from !== undefined || to !== undefined,
          date !== undefined,
        ];
        if (modes.filter(Boolean).length > 1) {
          throw new ToolInputError('Give only one of "minutes", "from"/"to", or "date".');
        }
        if (to !== undefined && from === undefined) {
          throw new ToolInputError('"to" requires "from".');
        }

        const now = Math.floor(Date.now() / 1000);
        let rows: RawUnlock[] | null;
        if (from !== undefined) {
          const f = epoch(from, 'from');
          // Open-ended range: "now" rounded UP to the minute, so repeat calls within a
          // minute share one cache key instead of each missing on a new second.
          const t = to !== undefined ? epoch(to, 'to', true) : Math.ceil(now / 60) * 60;
          if (t < f) throw new ToolInputError('"to" is before "from".');
          // A range that closed more than a day ago can no longer change.
          const ttl = t < now - 86400 ? TTL.game : TTL.user;
          rows = await ctx.client.get<RawUnlock[] | null>(
            'GetAchievementsEarnedBetween',
            { u, f, t },
            ttl,
          );
        } else if (date !== undefined) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new ToolInputError('"date" must be YYYY-MM-DD');
          }
          const ttl = epoch(date, 'date', true) < now - 86400 ? TTL.game : TTL.user;
          rows = await ctx.client.get<RawUnlock[] | null>(
            'GetAchievementsEarnedOnDay',
            { u, d: date },
            ttl,
          );
        } else {
          rows = await ctx.client.get<RawUnlock[] | null>(
            'GetUserRecentAchievements',
            { u, m: minutes ?? 1440 },
            TTL.user,
          );
        }

        // No upstream limit on these endpoints; filter + slice client-side.
        const all = (Array.isArray(rows) ? rows : [])
          .filter(r => !hardcore_only || num(r.HardcoreMode) === 1)
          .sort((a, b) => (a.Date < b.Date ? 1 : a.Date > b.Date ? -1 : 0));
        const page = paginate(all, 0, limit);
        const truncated = page.meta.next_offset !== undefined;
        return {
          count: all.length,
          points: all.reduce((s, r) => s + (num(r.Points) ?? 0), 0),
          ...(truncated ? { game_count: new Set(all.map(r => r.GameID)).size } : {}),
          games: gameTitles(
            page.items,
            r => r.GameID,
            r => r.GameTitle,
          ),
          ...table(page.items, [
            ['date', r => ts(r.Date)],
            ['game_id', r => r.GameID],
            ['id', r => r.AchievementID],
            ['title', r => r.Title],
            ['points', r => num(r.Points)],
            ['hc', r => (hardcore_only ? undefined : flag(num(r.HardcoreMode)))],
            ['type', r => r.Type ?? undefined],
          ]),
          ...(truncated ? { truncated: true } : {}),
        };
      },
    ),
  );

  server.registerTool(
    'get_user_games',
    {
      description:
        "User's game lists: recent, progress (per-game counts + award), completed (100%), want_to_play.",
      inputSchema: lean(
        z.object({
          user: userParam,
          list: z.enum(['recent', 'progress', 'completed', 'want_to_play']),
          status: z
            .enum(['mastered', 'beaten', 'in_progress', 'unfinished'])
            .optional()
            .describe('progress only; beaten includes mastered; in_progress = no award'),
          console_id: z.number().int().positive().optional(),
          sort: z.enum(['recent', 'title', 'percent']).default('recent').describe('progress only'),
          images: imagesParam,
          limit: limitParam(25, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'get_user_games',
      async ({ user, list, status, console_id, sort, images, limit, offset }) => {
        const u = resolveUser(ctx, user);
        if (list !== 'progress' && (status !== undefined || sort !== 'recent')) {
          throw new ToolInputError('"status" and "sort" apply only to list="progress".');
        }
        const icon = (p: string | undefined) => (images ? imageUrl(p) : undefined);

        if (list === 'recent') {
          if (console_id !== undefined) {
            throw new ToolInputError('"console_id" is not supported for list="recent".');
          }
          const c = pageBucket(limit, 50); // upstream max 50; bucketed, sliced here
          const raw =
            (await ctx.client.get<RawRecentGame[] | null>(
              'GetUserRecentlyPlayedGames',
              { u, c, o: offset },
              TTL.user,
            )) ?? [];
          const rows = raw.slice(0, limit);
          const anyHc = rows.some(g => num(g.NumAchievedHardcore));
          return {
            ...table(rows, [
              ['id', g => g.GameID],
              ['title', g => g.Title],
              ['console', g => g.ConsoleName],
              ['last_played', g => ts(g.LastPlayed)],
              ['earned', g => num(g.NumAchieved)],
              ['earned_hc', g => (anyHc ? num(g.NumAchievedHardcore) : undefined)],
              ['total', g => num(g.NumPossibleAchievements)],
              ['points', g => num(g.ScoreAchieved)],
              ['points_hc', g => (anyHc ? num(g.ScoreAchievedHardcore) : undefined)],
              ['max_points', g => num(g.PossibleScore)],
              ['icon', g => icon(g.ImageIcon)],
            ]),
            ...upstreamMeta(offset, rows.length, limit, undefined, raw.length),
          };
        }

        if (list === 'progress') {
          // Upstream order is most-recent unlock first. Filters/other sorts are
          // client-side, so they need the full list; the plain case pages upstream.
          const clientSide = status !== undefined || console_id !== undefined || sort !== 'recent';
          let rows: RawCompletion[];
          let meta: Record<string, number>;
          if (clientSide) {
            let all = await fetchAll<RawCompletion>(
              ctx,
              'GetUserCompletionProgress',
              { u },
              TTL.user,
            );
            all = all.filter(g => {
              if (console_id !== undefined && g.ConsoleID !== console_id) return false;
              const k = g.HighestAwardKind;
              switch (status) {
                case 'mastered':
                  return isMastery(k);
                case 'beaten':
                  return !!k;
                case 'in_progress':
                  return !k;
                case 'unfinished':
                  return !isMastery(k);
                default:
                  return true;
              }
            });
            const frac = (g: RawCompletion) => (num(g.NumAwarded) ?? 0) / (num(g.MaxPossible) || 1);
            // fetchAll's array is our own, but its rows are shared cache values: sorting
            // the array is fine, mutating a row would not be.
            if (sort === 'title') all.sort((a, b) => a.Title.localeCompare(b.Title));
            if (sort === 'percent') all.sort((a, b) => frac(b) - frac(a));
            const page = paginate(all, offset, limit);
            rows = page.items;
            meta = page.meta;
          } else {
            const r = await ctx.client.get<Paged<RawCompletion> | null>(
              'GetUserCompletionProgress',
              { u, c: pageBucket(limit), o: offset },
              TTL.user,
            );
            rows = (r?.Results ?? []).slice(0, limit);
            meta = upstreamMeta(offset, rows.length, limit, num(r?.Total));
          }
          const anyHc = rows.some(g => num(g.NumAwardedHardcore));
          return {
            ...table(rows, [
              ['id', g => g.GameID],
              ['title', g => g.Title],
              ['console', g => (console_id !== undefined ? undefined : g.ConsoleName)],
              ['earned', g => num(g.NumAwarded)],
              ['earned_hc', g => (anyHc ? num(g.NumAwardedHardcore) : undefined)],
              ['total', g => num(g.MaxPossible)],
              ['award', g => awardKind(g.HighestAwardKind)],
              ['award_date', g => ts(g.HighestAwardDate)?.slice(0, 10)],
              ['last_unlock', g => ts(g.MostRecentAwardedDate)?.slice(0, 10)],
              ['icon', g => icon(g.ImageIcon)],
            ]),
            ...meta,
          };
        }

        if (list === 'completed') {
          // Quirk: GetUserCompletedGames returns EVERY game with progress (one row per
          // mode, PctWon < 1 included) and has no paging. Keep only 100% games and
          // merge the softcore/hardcore rows.
          const rows =
            (await ctx.client.get<RawCompleted[] | null>(
              'GetUserCompletedGames',
              { u },
              TTL.user,
            )) ?? [];
          const byGame = new Map<number, { g: RawCompleted; hc: boolean }>();
          for (const g of rows) {
            if ((num(g.PctWon) ?? 0) < 1) continue;
            if (console_id !== undefined && g.ConsoleID !== console_id) continue;
            const hc = num(g.HardcoreMode) === 1;
            const prev = byGame.get(g.GameID);
            byGame.set(g.GameID, { g: prev?.g ?? g, hc: (prev?.hc ?? false) || hc });
          }
          const page = paginate([...byGame.values()], offset, limit);
          return {
            ...table(page.items, [
              ['id', x => x.g.GameID],
              ['title', x => x.g.Title],
              ['console', x => (console_id !== undefined ? undefined : x.g.ConsoleName)],
              ['achievements', x => num(x.g.MaxPossible)],
              ['hardcore', x => flag(x.hc)],
              ['icon', x => icon(x.g.ImageIcon)],
            ]),
            ...page.meta,
          };
        }

        // want_to_play
        let rows: RawWantToPlay[];
        let meta: Record<string, number>;
        if (console_id !== undefined) {
          const all = (
            await fetchAll<RawWantToPlay>(ctx, 'GetUserWantToPlayList', { u }, TTL.social)
          ).filter(g => g.ConsoleID === console_id);
          const page = paginate(all, offset, limit);
          rows = page.items;
          meta = page.meta;
        } else {
          const r = await ctx.client.get<Paged<RawWantToPlay> | null>(
            'GetUserWantToPlayList',
            { u, c: pageBucket(limit), o: offset },
            TTL.social,
          );
          rows = (r?.Results ?? []).slice(0, limit);
          meta = upstreamMeta(offset, rows.length, limit, num(r?.Total));
        }
        return {
          ...table(rows, [
            ['id', g => g.ID],
            ['title', g => g.Title],
            ['console', g => (console_id !== undefined ? undefined : g.ConsoleName)],
            ['achievements', g => num(g.AchievementsPublished)],
            ['points', g => num(g.PointsTotal)],
            ['icon', g => icon(g.ImageIcon)],
          ]),
          ...meta,
        };
      },
    ),
  );

  server.registerTool(
    'get_user_game_progress',
    {
      description:
        "User's progress in one game (summary + achievements with rarity %), or one summary row per game_ids entry.",
      inputSchema: lean(
        z.object({
          user: userParam,
          game_id: z.number().int().positive().optional(),
          game_ids: z
            .array(z.number().int().positive())
            .min(1)
            .max(50)
            .optional()
            .describe('Summary only'),
          achievements: z.enum(['locked', 'unlocked', 'all', 'none']).default('locked'),
          sort: z
            .enum(['display', 'rarity'])
            .default('display')
            .describe('rarity: most-earned first'),
          include_rank: z.boolean().default(false),
          images: imagesParam,
          limit: limitParam(50, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'get_user_game_progress',
      async ({
        user,
        game_id,
        game_ids,
        achievements,
        sort,
        include_rank,
        images,
        limit,
        offset,
      }) => {
        const u = resolveUser(ctx, user);
        if ((game_id === undefined) === (game_ids === undefined)) {
          throw new ToolInputError('Give exactly one of "game_id" or "game_ids".');
        }

        if (game_ids) {
          if (include_rank) throw new ToolInputError('"include_rank" needs "game_id".');
          // Sorted so the same set in any order shares one cache entry.
          const ids = [...new Set(game_ids)].sort((a, b) => a - b);
          const r =
            (await ctx.client.get<Record<string, RawUserProgress> | null>(
              'GetUserProgress',
              { u, i: ids.join(',') },
              TTL.user,
            )) ?? {};
          // No titles upstream; ids are the caller's own.
          return table(ids, [
            ['id', id => id],
            ['earned', id => num(r[id]?.NumAchieved)],
            ['earned_hc', id => num(r[id]?.NumAchievedHardcore) || undefined],
            ['total', id => num(r[id]?.NumPossibleAchievements)],
            ['points', id => num(r[id]?.ScoreAchieved)],
            ['points_hc', id => num(r[id]?.ScoreAchievedHardcore) || undefined],
            ['max_points', id => num(r[id]?.PossibleScore)],
          ]);
        }

        const g = game_id as number;
        const [p, rank] = await Promise.all([
          ctx.client.get<RawGameProgress | null>(
            'GetGameInfoAndUserProgress',
            { u, g, a: 1 },
            TTL.user,
          ),
          include_rank
            ? ctx.client.get<{ UserRank?: number; TotalScore?: number }[] | null>(
                'GetUserGameRankAndScore',
                { u, g },
                TTL.user,
              )
            : null,
        ]);
        if (!p?.ID) return null;

        // Object.values/spread give a fresh array: upstream bodies are frozen cache values.
        const achs = [...Object.values(p.Achievements ?? {})].sort(
          (a, b) => (a.DisplayOrder ?? 0) - (b.DisplayOrder ?? 0) || a.ID - b.ID,
        );
        const sum = (xs: RawProgressAch[]) => xs.reduce((s, a) => s + (num(a.Points) ?? 0), 0);
        const earned = achs.filter(a => a.DateEarned || a.DateEarnedHardcore);
        const players = p.NumDistinctPlayers;

        const out: Record<string, unknown> = {
          id: p.ID,
          title: p.Title,
          console: p.ConsoleName,
          parent_game_id: p.ParentGameID ?? undefined,
          earned: num(p.NumAwardedToUser),
          total: num(p.NumAchievements),
          pct: pct(p.UserCompletion),
          points: sum(earned),
          // Hardcore figures only when there is hardcore progress (else all zeros).
          ...(num(p.NumAwardedToUserHardcore)
            ? {
                earned_hc: num(p.NumAwardedToUserHardcore),
                pct_hc: pct(p.UserCompletionHardcore),
                points_hc: sum(achs.filter(a => a.DateEarnedHardcore)),
              }
            : {}),
          max_points: sum(achs),
          award: awardKind(p.HighestAwardKind),
          award_date: ts(p.HighestAwardDate)?.slice(0, 10),
          // UserTotalPlaytime is in seconds.
          playtime_min: num(p.UserTotalPlaytime)
            ? Math.round((num(p.UserTotalPlaytime) ?? 0) / 60)
            : undefined,
          players: num(players),
          icon: images ? imageUrl(p.ImageIcon) : undefined,
        };
        if (rank) {
          // Empty array = no progress in this game.
          out.rank = rank[0]?.UserRank;
          out.rank_score = rank[0]?.TotalScore;
        }

        if (achievements !== 'none') {
          const rows = achs.filter(a => {
            const has = !!(a.DateEarned || a.DateEarnedHardcore);
            return achievements === 'all' || (achievements === 'unlocked' ? has : !has);
          });
          // Stable sort keeps display order among equals.
          if (sort === 'rarity')
            rows.sort((a, b) => (num(b.NumAwarded) ?? 0) - (num(a.NumAwarded) ?? 0));
          const page = paginate(rows, offset, limit);
          out.achievements = {
            ...table(page.items, [
              ['id', a => a.ID],
              ['title', a => a.Title],
              ['description', a => a.Description],
              ['points', a => num(a.Points)],
              ['type', a => a.Type ?? a.type ?? undefined],
              ['rarity', a => rarity(a.NumAwarded, players)],
              ['earned', a => ts(a.DateEarned ?? a.DateEarnedHardcore)],
              ['hc', a => flag(!!a.DateEarnedHardcore)],
              [
                'badge',
                a =>
                  images
                    ? badgeUrl(a.BadgeName, !(a.DateEarned || a.DateEarnedHardcore))
                    : undefined,
              ],
            ]),
            ...page.meta,
          };
        }
        return out;
      },
    ),
  );

  server.registerTool(
    'get_user_social',
    {
      description:
        "User's set requests or dev claims; or who the API-key owner follows / is followed by (ignores user).",
      inputSchema: lean(
        z.object({
          user: userParam,
          kind: z.enum(['following', 'followers', 'set_requests', 'claims']),
          all_requests: z.boolean().default(false).describe('set_requests: include fulfilled'),
          // Per-kind default (claims 20, else 50), so no schema default.
          limit: z.number().int().min(1).max(500).optional(),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(ctx, 'get_user_social', async ({ user, kind, all_requests, limit: lim, offset }) => {
      const limit = lim ?? (kind === 'claims' ? 20 : 50);
      if (kind === 'following' || kind === 'followers') {
        // These endpoints take no user: they always describe the API-key owner.
        if (user !== undefined && user !== ctx.defaultUser) {
          throw new ToolInputError(
            `"${kind}" is only available for the API-key owner; omit "user".`,
          );
        }
        const following = kind === 'following';
        const r = await ctx.client.get<Paged<RawFollow> | null>(
          following ? 'GetUsersIFollow' : 'GetUsersFollowingMe',
          { c: pageBucket(limit), o: offset },
          TTL.social,
        );
        const rows = (r?.Results ?? []).slice(0, limit);
        return {
          ...table(rows, [
            ['user', f => f.User],
            ['points', f => num(f.Points)],
            ['softcore_points', f => num(f.PointsSoftcore)],
            ['mutual', f => flag(following ? f.IsFollowingMe : f.AmIFollowing)],
          ]),
          ...upstreamMeta(offset, rows.length, limit, num(r?.Total)),
        };
      }

      const u = resolveUser(ctx, user);
      if (kind === 'set_requests') {
        const r = await ctx.client.get<{
          RequestedSets?: { GameID: number; Title: string; ConsoleName?: string }[];
          TotalRequests?: number;
          PointsForNext?: number;
        } | null>('GetUserSetRequests', { u, t: all_requests ? 1 : 0 }, TTL.feed);
        const page = paginate(r?.RequestedSets ?? [], offset, limit);
        return {
          allowed: num(r?.TotalRequests),
          points_for_next: num(r?.PointsForNext),
          ...table(page.items, [
            ['id', g => g.GameID],
            ['title', g => g.Title],
            ['console', g => g.ConsoleName],
          ]),
          ...page.meta,
        };
      }

      // claims
      const rows = [
        ...((await ctx.client.get<RawClaim[] | null>('GetUserClaims', { u }, TTL.feed)) ?? []),
      ].sort((a, b) => ((a.Created ?? '') < (b.Created ?? '') ? 1 : -1));
      const page = paginate(rows, offset, limit);
      return {
        ...table(page.items, [
          ['game_id', c => c.GameID],
          ['game', c => c.GameTitle],
          ['console', c => c.ConsoleName],
          ['status', c => CLAIM_STATUS[c.Status ?? -1] ?? c.Status],
          ['set', c => (c.SetType === 1 ? 'revision' : 'new')],
          ['collab', c => flag(c.ClaimType === 1)],
          ['special', c => CLAIM_SPECIAL[c.Special ?? 0]],
          ['created', c => ts(c.Created)?.slice(0, 10)],
          // DoneTime = expiry for active claims, completion/drop time otherwise.
          ['done', c => ts(c.DoneTime)?.slice(0, 10)],
          ['extensions', c => num(c.Extension) || undefined],
        ]),
        ...page.meta,
      };
    }),
  );
}
