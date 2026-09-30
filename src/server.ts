import { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './tools/common.js';
import { registerUserTools } from './tools/user.js';
import { registerGameTools } from './tools/game.js';
import { registerCommunityTools } from './tools/community.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'Read-only access to the RetroAchievements (RA) Web API.',
  'User tools default to the configured user when "user" is omitted.',
  'Results are compact JSON; lists are tables {"cols":[...],"rows":[[...]]}; empty fields are omitted.',
  'Find a game ID with find_games before calling game tools. Prefer narrow calls (limit, filters) over broad ones.',
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
