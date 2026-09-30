import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ENDPOINT_TTL, TTL, type Endpoint } from '../client.js';
import { bool, clean, flag, num, paginate, table, ts, type ToolResult } from '../format.js';
import {
  awardKind,
  handler,
  lean,
  limitParam,
  pageBucket,
  offsetParam,
  READ_ONLY,
  resolveUser,
  ToolInputError,
  type ToolContext,
} from './common.js';

/**
 * Every documented Web API endpoint (38), without the `API_` prefix / `.php` suffix —
 * the keys of ENDPOINT_TTL, so the list and the per-endpoint cache policy can't drift.
 * (GetGameRating is gone upstream: 410.)
 */
export const ENDPOINTS = Object.keys(ENDPOINT_TTL) as Endpoint[];

// ---------- upstream shapes ----------

interface RawAotw {
  Achievement?: {
    ID: number;
    Title: string;
    Description?: string;
    Points?: number;
    TrueRatio?: number;
    Type?: string | null;
    Author?: string;
  };
  Console?: { ID: number; Title: string };
  Game?: { ID: number; Title: string };
  StartAt?: string;
  TotalPlayers?: number;
  Unlocks?: {
    User: string;
    RAPoints?: number;
    HardcoreMode?: number | string;
    DateAwarded: string;
  }[];
  UnlocksCount?: number;
  UnlocksHardcoreCount?: number;
}

/** GetTopTenUsers keys rows by position: 1=user, 2=hardcore points, 3=RetroPoints. */
type RawTopUser = Record<'1' | '2' | '3' | '4', string | number>;

interface RawGameAward {
  User: string;
  AwardKind: string;
  AwardDate: string;
  GameID: number;
  GameTitle: string;
  ConsoleName: string;
}

interface RawClaim {
  User: string;
  GameID: number;
  GameTitle: string;
  ConsoleID: number;
  ConsoleName: string;
  ClaimType: number;
  SetType: number;
  Extension: number;
  Created: string;
  DoneTime: string;
  Updated: string;
  UserIsJrDev: number;
  MinutesLeft: number;
}

interface RawComments {
  Count?: number;
  Total?: number;
  Results?: { User: string; Submitted: string; CommentText: string }[];
}

interface RawTicket {
  ID: number;
  AchievementID: number;
  AchievementTitle: string;
  AchievementDesc?: string;
  AchievementType?: string | null;
  Points?: number;
  AchievementAuthor?: string;
  GameID: number;
  GameTitle: string;
  ConsoleName: string;
  ReportedAt: string;
  ReportTypeDescription?: string;
  ReportStateDescription?: string;
  Hardcore?: number | string | null;
  ReportNotes?: string;
  ReportedBy: string;
  ResolvedAt?: string | null;
  ResolvedBy?: string | null;
  URL?: string;
}

// ---------- helpers ----------

/** Collapse whitespace and cap length; the ellipsis tells the model text was cut. */
export function clip(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const day = (v: unknown) => ts(v)?.slice(0, 10);

/** Reject args that don't apply to the chosen mode (silently ignoring them misleads). */
function onlyFor(
  mode: string,
  allowed: readonly string[],
  args: Record<string, unknown>,
  label = 'kind',
): void {
  if (allowed.includes(mode)) return;
  const given = Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => `"${k}"`);
  if (given.length) {
    throw new ToolInputError(`${given.join(', ')} only apply to ${label} ${allowed.join('/')}.`);
  }
}

/** Upstream-paginated page: `next_offset` only when a further page is likely. */
function upstreamPage(offset: number, got: number, limit: number, total?: number, raw = got) {
  const next = offset + got;
  const more = total !== undefined ? next < total : raw > got || got >= limit;
  return {
    ...(offset > 0 ? { offset } : {}),
    ...(more ? { next_offset: next } : {}),
  };
}

const AWARD_KIND = {
  mastered: 'mastered',
  completed: 'completed',
  beaten_hardcore: 'beaten-hardcore',
  beaten_softcore: 'beaten-softcore',
} as const;

const CLAIM_KIND = { completed: 1, dropped: 2, expired: 3 } as const;

const NOTE_SHORT = 100;
const NOTE_LONG = 2000;
const COMMENT_MAX = 500;

function ticketRows(tickets: RawTicket[], details: boolean, withGame: boolean) {
  return table(tickets, [
    ['id', t => t.ID],
    ['state', t => t.ReportStateDescription],
    ['type', t => t.ReportTypeDescription],
    ['achievement_id', t => t.AchievementID],
    ['achievement', t => t.AchievementTitle],
    ['game_id', t => (withGame ? t.GameID : undefined)],
    ['game', t => (withGame ? t.GameTitle : undefined)],
    ['console', t => (withGame ? t.ConsoleName : undefined)],
    ['reporter', t => t.ReportedBy],
    ['reported', t => ts(t.ReportedAt)],
    ['hardcore', t => flag(bool(t.Hardcore))],
    ['note', t => clip(t.ReportNotes, details ? NOTE_LONG : NOTE_SHORT)],
    ['author', t => (details ? t.AchievementAuthor : undefined)],
    ['resolved', t => (details ? ts(t.ResolvedAt) : undefined)],
    ['resolved_by', t => (details ? t.ResolvedBy : undefined)],
  ]);
}

export function registerCommunityTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_feed',
    {
      description:
        'Site feeds: aotw (Achievement of the Week), top_users, recent_awards, active_claims, claims (finished).',
      inputSchema: lean(
        z.object({
          kind: z.enum(['aotw', 'top_users', 'recent_awards', 'active_claims', 'claims']),
          // Format checked in the handler: a regex here would be advertised to the model.
          date: z.string().max(10).optional().describe('recent_awards: start day'),
          award_kind: z
            .enum(['mastered', 'completed', 'beaten_hardcore', 'beaten_softcore'])
            .optional()
            .describe('recent_awards'),
          claim_kind: z
            .enum(['completed', 'dropped', 'expired'])
            .optional()
            .describe('claims; default completed'),
          console_id: z.number().int().positive().optional().describe('claims filter'),
          game_id: z.number().int().positive().optional().describe('claims filter'),
          limit: limitParam(10, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'get_feed',
      async ({ kind, date, award_kind, claim_kind, console_id, game_id, limit, offset }) => {
        onlyFor(kind, ['recent_awards'], { date, award_kind });
        onlyFor(kind, ['claims'], { claim_kind });
        onlyFor(kind, ['active_claims', 'claims'], { console_id, game_id });
        if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new ToolInputError('"date" must be YYYY-MM-DD');
        }

        switch (kind) {
          case 'aotw': {
            const r = await ctx.client.get<RawAotw | null>('GetAchievementOfTheWeek', {}, TTL.feed);
            if (!r?.Achievement) return null;
            const a = r.Achievement;
            // Upstream returns every unlock of the week (hundreds); keep the newest few.
            const unlocks = [...(r.Unlocks ?? [])].sort((x, y) =>
              y.DateAwarded.localeCompare(x.DateAwarded),
            );
            const page = paginate(unlocks, offset, limit);
            return {
              achievement: {
                id: a.ID,
                title: a.Title,
                description: a.Description,
                points: a.Points,
                retro: a.TrueRatio,
                type: a.Type,
                author: a.Author,
              },
              game: { id: r.Game?.ID, title: r.Game?.Title, console: r.Console?.Title },
              start: day(r.StartAt),
              players: r.TotalPlayers,
              unlocks: r.UnlocksCount,
              unlocks_hc: r.UnlocksHardcoreCount,
              recent: table(page.items, [
                ['date', u => ts(u.DateAwarded)],
                ['user', u => u.User],
                ['points', u => u.RAPoints],
                // Almost every AotW unlock is hardcore: flag only the exceptions so the
                // column disappears entirely in the common case.
                ['softcore', u => flag(bool(u.HardcoreMode) === false)],
              ]),
              ...page.meta,
            };
          }

          case 'top_users': {
            const r =
              (await ctx.client.get<RawTopUser[] | null>('GetTopTenUsers', {}, TTL.feed)) ?? [];
            return table(
              r.map((u, i) => ({ u, rank: i + 1 })),
              [
                ['rank', x => x.rank],
                ['user', x => x.u['1']],
                ['points', x => num(x.u['2'])],
                ['retro', x => num(x.u['3'])],
              ],
            );
          }

          case 'recent_awards': {
            // Upstream max 100; bucketed (shared cache entries) and sliced here.
            const count = pageBucket(limit, 100);
            const r = await ctx.client.get<{ Total?: number; Results?: RawGameAward[] } | null>(
              'GetRecentGameAwards',
              {
                d: date,
                k: award_kind && AWARD_KIND[award_kind],
                c: count,
                o: offset || undefined,
              },
              TTL.feed,
            );
            const raw = r?.Results ?? [];
            const rows = raw.slice(0, limit);
            return {
              total: r?.Total,
              ...table(rows, [
                ['date', a => ts(a.AwardDate)],
                ['user', a => a.User],
                ['award', a => (award_kind ? undefined : awardKind(a.AwardKind))],
                ['game_id', a => a.GameID],
                ['game', a => a.GameTitle],
                ['console', a => a.ConsoleName],
              ]),
              ...upstreamPage(offset, rows.length, limit, r?.Total, raw.length),
            };
          }

          case 'active_claims':
          case 'claims': {
            const active = kind === 'active_claims';
            // Upstream returns everything (hundreds of rows, 200-400 KB) with no filters or
            // paging, so filter and page here; one cache entry serves every variant.
            const all =
              (await ctx.client.get<RawClaim[] | null>(
                active ? 'GetActiveClaims' : 'GetClaims',
                active ? {} : { k: CLAIM_KIND[claim_kind ?? 'completed'] },
                TTL.feed,
              )) ?? [];
            const filtered = all
              .filter(
                c =>
                  (console_id === undefined || c.ConsoleID === console_id) &&
                  (game_id === undefined || c.GameID === game_id),
              )
              .sort((x, y) =>
                (active ? y.Created : y.Updated).localeCompare(active ? x.Created : x.Updated),
              );
            const page = paginate(filtered, offset, limit);
            return {
              // GetClaims silently stops at the newest 1000 claims.
              ...(!active && all.length >= 1000
                ? { note: 'upstream lists only the latest 1000' }
                : {}),
              ...table(page.items, [
                ['user', c => c.User],
                ['game_id', c => c.GameID],
                ['game', c => c.GameTitle],
                ['console', c => (console_id === undefined ? c.ConsoleName : undefined)],
                ['set', c => (c.SetType === 1 ? 'revision' : 'new')],
                ['collab', c => flag(c.ClaimType === 1)],
                ['jr_dev', c => flag(bool(c.UserIsJrDev))],
                ['created', c => day(c.Created)],
                // DoneTime is the (planned) expiry; a dropped/completed claim ended at Updated.
                [
                  active ? 'expires' : 'ended',
                  c => day(active || claim_kind === 'expired' ? c.DoneTime : c.Updated),
                ],
                ['extensions', c => (active && c.Extension > 0 ? c.Extension : undefined)],
              ]),
              ...page.meta,
            };
          }
        }
      },
    ),
  );

  server.registerTool(
    'get_comments',
    {
      description:
        'Comment wall of a game, achievement or user (system log entries hidden unless include_system).',
      inputSchema: lean(
        z.object({
          target: z.enum(['game', 'achievement', 'user']),
          id: z
            .union([z.number().int().positive(), z.string().min(1).max(64)])
            .optional()
            .describe('ID, or username for user (default configured)'),
          sort: z.enum(['newest', 'oldest']).default('newest'),
          include_system: z.boolean().default(false),
          limit: limitParam(10, 500),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(ctx, 'get_comments', async ({ target, id, sort, include_system, limit, offset }) => {
      let ident: string | number;
      if (target === 'user') {
        ident = resolveUser(ctx, id === undefined ? undefined : String(id));
      } else {
        const n = num(id);
        if (n === undefined || !Number.isInteger(n) || n <= 0) {
          throw new ToolInputError(`"id" must be a numeric ${target} ID.`);
        }
        ident = n;
      }
      const r = await ctx.client.get<RawComments | [] | null>(
        'GetComments',
        {
          t: { game: 1, achievement: 2, user: 3 }[target],
          i: ident,
          c: pageBucket(limit),
          o: offset || undefined,
          sort: sort === 'newest' ? '-submitted' : 'submitted',
        },
        TTL.feed,
      );
      // An empty / disabled wall comes back as a bare [] rather than {Total: 0}.
      const res = Array.isArray(r) || !r ? {} : r;
      const raw = res.Results ?? [];
      const rows = raw.slice(0, limit);
      // Paging stays upstream-based, so hiding system rows can leave a short page.
      const shown = include_system ? rows : rows.filter(c => c.User !== 'Server');
      const hidden = rows.length - shown.length;
      return {
        total: res.Total ?? 0,
        ...(hidden ? { system_hidden: hidden } : {}),
        ...table(shown, [
          ['date', c => ts(c.Submitted)],
          ['user', c => c.User],
          ['text', c => clip(c.CommentText, COMMENT_MAX)],
        ]),
        ...upstreamPage(offset, rows.length, limit, res.Total ?? 0, raw.length),
      };
    }),
  );

  server.registerTool(
    'get_tickets',
    {
      description:
        'Achievement bug tickets: recent, one ticket, per game/achievement/developer summary, or most_ticketed games.',
      inputSchema: lean(
        z.object({
          mode: z.enum(['recent', 'ticket', 'game', 'achievement', 'developer', 'most_ticketed']),
          id: z.number().int().positive().optional().describe('ticket/game/achievement ID'),
          user: z.string().min(1).max(64).optional().describe('developer; default configured'),
          unofficial: z.boolean().optional().describe('game mode'),
          details: z.boolean().default(false).describe('Full notes + resolution'),
          limit: limitParam(10, 100),
          offset: offsetParam,
        }),
      ),
      annotations: READ_ONLY,
    },
    handler(ctx, 'get_tickets', async ({ mode, id, user, unofficial, details, limit, offset }) => {
      const needsId = ['ticket', 'game', 'achievement'];
      if (needsId.includes(mode) && id === undefined) {
        throw new ToolInputError(`mode "${mode}" requires "id".`);
      }
      onlyFor(mode, needsId, { id }, 'mode');
      onlyFor(mode, ['developer'], { user }, 'mode');
      onlyFor(mode, ['game'], { unofficial }, 'mode');

      const get = <T>(params: Record<string, string | number | undefined>) =>
        ctx.client.get<T | null>('GetTicketData', params, TTL.feed);

      switch (mode) {
        case 'recent': {
          const r = await get<{ RecentTickets?: RawTicket[]; OpenTickets?: number }>({
            c: pageBucket(limit, 100),
            o: offset || undefined,
          });
          const raw = r?.RecentTickets ?? [];
          const rows = raw.slice(0, limit);
          return {
            open_total: r?.OpenTickets,
            ...ticketRows(rows, details, true),
            ...upstreamPage(offset, rows.length, limit, undefined, raw.length),
          };
        }

        case 'ticket': {
          const t = await get<RawTicket>({ i: id });
          if (!t?.ID) return null;
          return {
            id: t.ID,
            state: t.ReportStateDescription,
            type: t.ReportTypeDescription,
            achievement: {
              id: t.AchievementID,
              title: t.AchievementTitle,
              description: t.AchievementDesc,
              type: t.AchievementType,
              points: t.Points,
              author: t.AchievementAuthor,
            },
            game: { id: t.GameID, title: t.GameTitle, console: t.ConsoleName },
            reporter: t.ReportedBy,
            reported: ts(t.ReportedAt),
            hardcore: flag(bool(t.Hardcore)),
            note: clip(t.ReportNotes, NOTE_LONG),
            resolved: ts(t.ResolvedAt),
            resolved_by: t.ResolvedBy,
            url: t.URL,
          };
        }

        case 'game': {
          const r = await get<{
            GameID?: number;
            GameTitle?: string;
            ConsoleName?: string;
            OpenTickets?: number;
            URL?: string;
            Tickets?: RawTicket[];
          }>({ g: id, f: unofficial ? 5 : undefined, d: 1 });
          if (!r?.GameID) return null;
          // The ticket list (d=1) is the game's whole history; page it here.
          const tickets = [...(r.Tickets ?? [])].sort((a, b) => b.ID - a.ID);
          const page = paginate(tickets, offset, limit);
          return {
            game: { id: r.GameID, title: r.GameTitle, console: r.ConsoleName },
            open_tickets: r.OpenTickets,
            url: r.URL,
            ...ticketRows(page.items, details, false),
            ...page.meta,
          };
        }

        case 'achievement': {
          const r = await get<{
            AchievementID?: number;
            AchievementTitle?: string;
            AchievementDescription?: string;
            AchievementType?: string | null;
            OpenTickets?: number;
            URL?: string;
          }>({ a: id });
          if (!r?.AchievementID) return null;
          return {
            achievement: {
              id: r.AchievementID,
              title: r.AchievementTitle,
              description: r.AchievementDescription,
              type: r.AchievementType,
            },
            open_tickets: r.OpenTickets,
            url: r.URL,
          };
        }

        case 'developer': {
          const r = await get<{
            User?: string;
            Open?: number;
            Closed?: number;
            Resolved?: number;
            Total?: number;
            URL?: string;
          }>({ u: resolveUser(ctx, user) });
          if (!r?.User) return null;
          return {
            user: r.User,
            open: r.Open,
            closed: r.Closed,
            resolved: r.Resolved,
            total: r.Total,
            url: r.URL,
          };
        }

        case 'most_ticketed': {
          const r = await get<{
            MostReportedGames?: {
              GameID: number | string;
              GameTitle: string;
              Console: string;
              OpenTickets: number | string;
            }[];
          }>({ f: 1, c: pageBucket(limit, 100), o: offset || undefined });
          const raw = r?.MostReportedGames ?? [];
          const rows = raw.slice(0, limit);
          return {
            ...table(rows, [
              ['game_id', g => num(g.GameID)],
              ['game', g => g.GameTitle],
              ['console', g => g.Console],
              ['open_tickets', g => num(g.OpenTickets)],
            ]),
            ...upstreamPage(offset, rows.length, limit, undefined, raw.length),
          };
        }
      }
    }),
  );

  server.registerTool(
    'ra_api_raw',
    {
      description:
        'Escape hatch: raw JSON from any RA Web API endpoint (e.g. GetGameExtended). Prefer the dedicated tools.',
      inputSchema: lean(
        z.object({
          // Free string (validated below) rather than a 38-value enum in every tools/list.
          endpoint: z.string().max(64).describe('Name without API_/.php'),
          params: z
            .record(z.string().min(1).max(32), z.union([z.string().max(200), z.number()]))
            .default({})
            .describe('Query params (key added)'),
          max_chars: z.number().int().min(200).max(60_000).default(8000),
        }),
      ),
      annotations: READ_ONLY,
    },
    async args => {
      let text = '';
      const r: ToolResult = await handler(
        ctx,
        'ra_api_raw',
        async ({ endpoint, params, max_chars }: typeof args) => {
          const name = endpoint.replace(/^API_/i, '').replace(/\.php$/i, '');
          const ep = ENDPOINTS.find(e => e.toLowerCase() === name.toLowerCase());
          if (!ep) {
            throw new ToolInputError(
              `Unknown endpoint "${endpoint}". Valid: ${ENDPOINTS.join(', ')}`,
            );
          }
          if (Object.keys(params).some(k => k.toLowerCase() === 'y')) {
            throw new ToolInputError('"y" (the API key) is injected by the server; remove it.');
          }
          // Per-endpoint default TTL (ENDPOINT_TTL), same freshness as the dedicated tools.
          const data = await ctx.client.get<unknown>(ep, params);
          text = rawText(data, max_chars);
          return true;
        },
      )(args);
      return r.isError ? r : { content: [{ type: 'text', text }] };
    },
  );
}

/** clean()ed compact JSON, cut at `max` characters with a marker giving the full size. */
export function rawText(data: unknown, max: number): string {
  const full = JSON.stringify(clean(data)) ?? 'null';
  if (full.length <= max) return full;
  return `${full.slice(0, max)}…[TRUNCATED: showing ${max} of ${full.length} chars; raise max_chars (≤60000) or narrow params]`;
}
