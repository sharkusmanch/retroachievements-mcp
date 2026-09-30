import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { TTL } from '../client.js';
import { num, paginate, table, ts } from '../format.js';
import {
  handler,
  limitParam,
  offsetParam,
  READ_ONLY,
  ToolInputError,
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

export async function getConsoles(ctx: ToolContext): Promise<RawConsole[]> {
  // a=0/g=0: fetch the full list once and filter locally, so every variant of the
  // question shares one cache entry.
  return (await ctx.client.get<RawConsole[] | null>('GetConsoleIDs', {}, TTL.static)) ?? [];
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
      description: 'List RetroAchievements consoles/systems and their IDs.',
      inputSchema: z.object({
        active_only: z.boolean().default(false).describe('Only systems with active development'),
        include_non_game: z
          .boolean()
          .default(false)
          .describe('Include non-game "systems" (hubs, events)'),
      }),
      annotations: READ_ONLY,
    },
    handler(ctx, 'list_consoles', async ({ active_only, include_non_game }) => {
      const consoles = (await getConsoles(ctx)).filter(
        c => (include_non_game || c.IsGameSystem !== false) && (!active_only || c.Active !== false),
      );
      return table(consoles, [
        ['id', c => c.ID],
        ['name', c => c.Name],
        ['active', c => (active_only ? undefined : c.Active)],
      ]);
    }),
  );

  server.registerTool(
    'find_games',
    {
      description:
        "Search games by title and/or list a console's games. Returns IDs for the other game tools. Searching all consoles is slow on first use (catalogs are then cached).",
      inputSchema: z.object({
        query: z.string().min(1).max(100).optional().describe('Title words (all must match)'),
        console_id: z.number().int().positive().optional().describe('Restrict to one console'),
        has_achievements: z.boolean().default(true).describe('Only games with achievement sets'),
        include_hashes: z.boolean().default(false).describe('Include ROM hashes'),
        limit: limitParam(25, 500),
        offset: offsetParam,
      }),
      annotations: READ_ONLY,
    },
    handler(
      ctx,
      'find_games',
      async ({ query, console_id, has_achievements, include_hashes, limit, offset }) => {
        if (!query && console_id === undefined) {
          throw new ToolInputError('Provide "query", "console_id", or both.');
        }
        const consoleIds =
          console_id !== undefined
            ? [console_id]
            : (await getConsoles(ctx)).filter(c => c.IsGameSystem !== false).map(c => c.ID);

        // RA has no title-search endpoint, so the catalogs ARE the index (see
        // CatalogStore). Hashes roughly triple the payload, so they are a separate
        // catalog variant fetched only when asked for.
        const { games: all, missing } = await ctx.catalog.getMany(
          consoleIds,
          has_achievements,
          include_hashes,
          SEARCH_BUDGET_MS,
        );
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
          games.sort((a, b) => a.Title.localeCompare(b.Title));
        }

        const page = paginate(games, offset, limit);
        const single = console_id !== undefined;
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
            ['hashes', g => (include_hashes ? g.Hashes : undefined)],
          ]),
          ...page.meta,
          ...(missing.length
            ? {
                incomplete: `${missing.length}/${consoleIds.length} consoles not yet indexed (still loading in background); repeat the call shortly for full results`,
              }
            : {}),
        };
      },
    ),
  );

  // Remaining game tools (get_game, get_game_rankings, get_leaderboards,
  // get_achievement_unlocks) are registered below.
}
