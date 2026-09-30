import { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './tools/common.js';
import { registerUserTools } from './tools/user.js';
import { registerGameTools } from './tools/game.js';
import { registerCommunityTools } from './tools/community.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'Read-only RetroAchievements (RA) Web API; "user" defaults to the configured user.',
  'Results are compact JSON. Lists are tables {"cols":[...],"rows":[[...]]}; rows may omit trailing empty cells.',
  'Empty fields are omitted; flags (hc, collab, ...) are 1 or omitted; *_hc = hardcore.',
  'Get game IDs from find_games. Prefer narrow calls (limit, filters).',
].join(' ');

/**
 * Builds a fully-registered MCP server. A FACTORY, not a singleton: the stateless HTTP
 * transport creates a server per request (a shared instance risks cross-request message
 * ID collisions). The expensive state — cache, semaphore — lives in the shared RAClient.
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'retroachievements-mcp', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerUserTools(server, ctx);
  registerGameTools(server, ctx);
  registerCommunityTools(server, ctx);
  return server;
}
