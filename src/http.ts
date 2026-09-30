import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { localhostAllowedHostnames } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { createServer } from './server.js';
import type { ToolContext } from './tools/common.js';
import { VERSION } from './version.js';

const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

/** RFC 7235: the auth scheme is case-insensitive. Token compare is timing-safe. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const m = header ? /^bearer\s+/i.exec(header) : null;
  if (!header || !m) return false;
  const a = Buffer.from(header.slice(m[0].length));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Streamable HTTP app (stateless). Exported separately from listen() for tests. */
export function createApp(
  ctx: ToolContext,
  cfg: Pick<Config, 'MCP_ALLOWED_HOSTS' | 'MCP_AUTH_TOKEN'>,
): express.Express {
  const { log } = ctx;
  const app = express();
  app.disable('x-powered-by');

  /**
   * Liveness/readiness, OUTSIDE the host guard and auth: a kubelet probe sends
   * `Host: <podIP>:<port>` and the blackbox job `Host: <svc>.<ns>.svc`, neither of which
   * an allowlist can match. Reports only that this process is up — never upstream health
   * (an RA outage must not restart the pod).
   */
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'retroachievements-mcp', version: VERSION });
  });

  // DNS-rebinding protection. An empty allowlist only reaches here on a loopback bind
  // (loadConfig refuses it otherwise), so it means "localhost only" — the SDK's list.
  // `*` is the explicit, logged opt-out.
  const hosts = cfg.MCP_ALLOWED_HOSTS;
  if (hosts.includes('*')) {
    log.warn('MCP_ALLOWED_HOSTS=* — host header validation is DISABLED for /mcp');
  } else {
    app.use('/mcp', hostHeaderValidation(hosts.length > 0 ? hosts : localhostAllowedHostnames()));
  }

  const token = cfg.MCP_AUTH_TOKEN;
  if (token) {
    app.use('/mcp', (req, res, next) => {
      if (bearerMatches(req.headers.authorization, token)) return next();
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json(rpcError(-32001, 'Unauthorized'));
    });
  }

  // Stateless: fresh McpServer + transport per request (see createServer).
  // Body parsing AFTER the Host guard and auth, so a rejected client costs no parse and
  // gets its 403/401 rather than a 400 for a malformed body.
  app.post('/mcp', express.json({ limit: '256kb' }), (req, res) => {
    void (async () => {
      const server = createServer(ctx);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      // Teardown bound to the RESPONSE lifecycle: handleRequest can resolve while the
      // body is still streaming, so a finally-block close would truncate replies.
      res.on('close', () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log.error('mcp request failed', err);
        if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal server error'));
        else res.end();
      }
    })();
  });

  /**
   * GET/DELETE → 405. The client special-cases 405 as "no standalone stream" and stops;
   * an empty SSE stream instead makes it reconnect ~1/s forever (measured on habitica-mcp).
   */
  const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
    res.set('Allow', 'POST');
    res.status(405).json(rpcError(-32000, 'Method not allowed.'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // Terminal error handler: keeps Express's HTML/stack output away from clients and logs.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) {
        log.error('unhandled request error', err);
        res.end();
        return;
      }
      const e = (err ?? {}) as { type?: unknown; status?: unknown };
      if (e.type === 'entity.too.large' || e.status === 413) {
        log.warn('request body too large');
        res.status(413).json(rpcError(-32600, 'Request body too large'));
        return;
      }
      log.error('unhandled request error', err);
      res.status(400).json(rpcError(-32700, 'Parse error'));
    },
  );
  return app;
}

export function serveHttp(ctx: ToolContext, cfg: Config): void {
  const { log } = ctx;
  const app = createApp(ctx, cfg);
  const httpServer = app.listen(cfg.MCP_PORT, cfg.MCP_HOST, () => {
    log.info('retroachievements-mcp listening (http)', {
      host: cfg.MCP_HOST,
      port: cfg.MCP_PORT,
      allowedHosts: cfg.MCP_ALLOWED_HOSTS,
      auth: cfg.MCP_AUTH_TOKEN ? 'bearer' : 'none',
    });
  });
  // Above nginx's keep-alive so the proxy decides when to recycle connections.
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  let shuttingDown = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info(`${sig} received — draining`);
      httpServer.close(() => process.exit(0));
      httpServer.closeIdleConnections();
      setTimeout(() => {
        httpServer.closeAllConnections();
        process.exit(0);
      }, 15_000).unref();
    });
  }
}
