#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { applyArgs, loadConfig } from './config.js';
import { createLogger, registerSecret } from './logger.js';
import { RAClient } from './client.js';
import { CatalogStore, defaultCacheDir } from './catalog.js';
import { getConsoles, searchableConsoleIds } from './tools/game.js';
import { createServer } from './server.js';
import { serveHttp } from './http.js';
import type { ToolContext } from './tools/common.js';
import { VERSION } from './version.js';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    `retroachievements-mcp ${VERSION}\n\n` +
      'Usage: retroachievements-mcp [--stdio | --http] [--host H] [--port N]\n\n' +
      'Env: RA_API_KEY (required), RA_USERNAME, MCP_TRANSPORT, MCP_ALLOWED_HOSTS, MCP_AUTH_TOKEN\n' +
      'See https://github.com/sharkusmanch/retroachievements-mcp#configuration\n',
  );
  process.exit(0);
}

let cfg;
try {
  cfg = loadConfig(applyArgs(process.env, argv));
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

// Register BEFORE the first log line so the key can never escape, even via a startup
// error path. The key rides in the query string, so any logged URL would contain it.
registerSecret(cfg.RA_API_KEY);
registerSecret(cfg.MCP_AUTH_TOKEN);

const log = createLogger(cfg.LOG_LEVEL);
const client = new RAClient(cfg, log);
const cacheDir =
  cfg.RA_CACHE_DIR === undefined
    ? defaultCacheDir()
    : ['', 'none'].includes(cfg.RA_CACHE_DIR)
      ? undefined
      : cfg.RA_CACHE_DIR;
const ctx: ToolContext = {
  client,
  catalog: new CatalogStore(client, log, cacheDir),
  log,
  defaultUser: cfg.RA_USERNAME,
};

// Last-resort guards: route async slips through the redacting logger.
process.on('unhandledRejection', reason => log.error('unhandled rejection', reason));
process.on('uncaughtException', err => {
  log.error('uncaught exception', err);
  process.exit(1);
});

if (cfg.MCP_TRANSPORT === 'http') {
  serveHttp(ctx, cfg);
  if (cfg.RA_PREWARM_CATALOG) void prewarm();
} else {
  // As PID 1 in `docker run -i`, node ignores SIGTERM unless a handler exists, so
  // `docker stop` would wait out its grace period. Nothing to drain in stdio mode.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  log.info('retroachievements-mcp ready (stdio)', { version: VERSION });
}

/**
 * Background warm of every active console's catalog (the set find_games searches by
 * default) so the first cross-console search is fast. Rate-limited by the client like
 * any other traffic; failures are logged and ignored.
 */
async function prewarm(): Promise<void> {
  try {
    const ids = searchableConsoleIds(await getConsoles(ctx), true);
    const r = await ctx.catalog.getMany(ids, true, 10 * 60_000);
    log.info('catalog prewarm complete', {
      consoles: ids.length,
      failed: r.failed.length,
      loading: r.loading.length,
    });
  } catch (e) {
    log.warn('catalog prewarm failed', e);
  }
}
