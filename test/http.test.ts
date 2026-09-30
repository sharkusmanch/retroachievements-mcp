import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/http.js';
import { RAClient } from '../src/client.js';
import { CatalogStore } from '../src/catalog.js';
import { createLogger } from '../src/logger.js';
import type { ToolContext } from '../src/tools/common.js';
import type { Config } from '../src/config.js';
import { VERSION } from '../src/version.js';

const TOKEN = 'test-bearer-token-0123456789';

function makeCtx(): { ctx: ToolContext; lines: string[] } {
  const lines: string[] = [];
  const log = createLogger('debug', l => lines.push(l));
  const client = new RAClient(
    {
      RA_API_KEY: 'dummy-key-for-tests',
      RA_BASE_URL: 'https://ra.invalid',
      RA_TIMEOUT_MS: 1000,
      RA_MAX_CONCURRENCY: 1,
      RA_CACHE_MAX_ENTRIES: 10,
      RA_CACHE_TTL_SCALE: 1,
      RA_RATE_PER_MINUTE: 600,
      RA_RATE_BURST: 10,
    },
    log,
    () => Promise.reject(new Error('network disabled in tests')),
  );
  const catalog = new CatalogStore(client, log, undefined);
  return { ctx: { client, catalog, log, defaultUser: 'tester' }, lines };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      s =>
        new Promise<void>(r => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

async function start(
  cfg: Partial<Pick<Config, 'MCP_ALLOWED_HOSTS' | 'MCP_AUTH_TOKEN'>> = {},
): Promise<{ base: string; lines: string[] }> {
  const { ctx, lines } = makeCtx();
  const app = createApp(ctx, { MCP_ALLOWED_HOSTS: [], ...cfg });
  const server = await new Promise<Server>(r => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, lines };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** fetch() forbids overriding Host; use node:http for Host-header tests. */
async function rawRequest(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const { request } = await import('node:http');
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers ?? {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('/healthz', () => {
  it('returns 200 with version', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      service: 'retroachievements-mcp',
      version: VERSION,
    });
  });

  it('bypasses the Host allowlist and bearer auth (kubelet/blackbox probes)', async () => {
    const { base } = await start({ MCP_ALLOWED_HOSTS: ['ra.example.com'], MCP_AUTH_TOKEN: TOKEN });
    for (const host of ['10.42.0.7:8080', 'retroachievements-mcp.mcp.svc', 'evil.test']) {
      const res = await rawRequest(base, '/healthz', { headers: { host } });
      expect(res.status).toBe(200);
    }
  });
});

describe('/mcp guards', () => {
  it('403s a Host not in the allowlist', async () => {
    const { base } = await start({ MCP_ALLOWED_HOSTS: ['ra.example.com'] });
    const res = await rawRequest(base, '/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, host: 'evil.test' },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
  });

  it('accepts an allowed Host regardless of port', async () => {
    const { base } = await start({ MCP_ALLOWED_HOSTS: ['ra.example.com'] });
    const res = await rawRequest(base, '/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, host: 'ra.example.com:443' },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(200);
  });

  it('empty allowlist = localhost only (DNS-rebinding protection on loopback)', async () => {
    const { base, lines } = await start();
    expect(lines.some(l => l.includes('DISABLED'))).toBe(false);
    const post = (host: string) =>
      rawRequest(base, '/mcp', {
        method: 'POST',
        headers: { ...mcpHeaders, host },
        body: JSON.stringify(INIT),
      });
    expect((await post('evil.test')).status).toBe(403);
    expect((await post('attacker.example:8080')).status).toBe(403);
    for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
      expect((await post(host)).status).toBe(200);
    }
  });

  it('MCP_ALLOWED_HOSTS=* disables the check, with a warning', async () => {
    const { base, lines } = await start({ MCP_ALLOWED_HOSTS: ['*'] });
    expect(lines.some(l => l.includes('host header validation is DISABLED'))).toBe(true);
    const res = await rawRequest(base, '/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, host: 'evil.test' },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(200);
  });

  it('oversized body → 413 JSON-RPC error, not a parse error', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({ ...INIT, pad: 'x'.repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
  });

  it.each(['bearer', 'BEARER', 'Bearer  '])('accepts the %j scheme case-insensitively', async s => {
    const { base } = await start({ MCP_AUTH_TOKEN: TOKEN });
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: `${s.trim()} ${TOKEN}` },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ['no header', undefined],
    ['wrong token', `Bearer ${'x'.repeat(TOKEN.length)}`],
    ['wrong length', 'Bearer short'],
    ['wrong scheme', `Basic ${TOKEN}`],
    ['bare token', TOKEN],
  ])('401s with %s', async (_label, auth) => {
    const { base } = await start({ MCP_AUTH_TOKEN: TOKEN });
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toMatchObject({ error: { code: -32001, message: 'Unauthorized' } });
  });

  it('passes with the correct bearer token', async () => {
    const { base } = await start({ MCP_AUTH_TOKEN: TOKEN });
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(200);
  });

  it.each(['GET', 'DELETE'])('%s /mcp → 405 with Allow: POST', async method => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, { method, headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
  });

  it('malformed JSON → 400 JSON-RPC parse error (no HTML/stack)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: '{"jsonrpc": "2.0", ',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
  });

  it('guards run before body parsing (bad Host / no token + malformed body → 403 / 401)', async () => {
    const hosts = await start({ MCP_ALLOWED_HOSTS: ['ra.example.com'] });
    const r1 = await rawRequest(hosts.base, '/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders, host: 'evil.test' },
      body: '{broken',
    });
    expect(r1.status).toBe(403);

    const auth = await start({ MCP_AUTH_TOKEN: TOKEN });
    const r2 = await fetch(`${auth.base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: '{broken',
    });
    expect(r2.status).toBe(401);
  });

  it('does not advertise Express', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('MCP round trip over Streamable HTTP', () => {
  it('initialize + tools/list via the SDK client (with host allowlist + bearer)', async () => {
    const { base } = await start({ MCP_ALLOWED_HOSTS: ['127.0.0.1'], MCP_AUTH_TOKEN: TOKEN });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({
        name: 'retroachievements-mcp',
        version: VERSION,
      });
      expect(client.getInstructions()).toMatch(/RetroAchievements/);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        expect(t.name).toMatch(/^[a-z_]+$/);
        expect(t.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it('fails to connect without the bearer token', async () => {
    const { base } = await start({ MCP_AUTH_TOKEN: TOKEN });
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))),
    ).rejects.toThrow();
    await client.close().catch(() => undefined);
  });
});
