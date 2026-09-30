import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/**
 * End-to-end over a real child process. Needs a build (`npm run build`), so it is skipped
 * when dist/ is absent rather than making the unit suite depend on tsc.
 *
 * If ANY non-protocol byte reached stdout (a stray log line, a banner), the client's
 * JSON-RPC reader would choke and initialize/tools/list would fail — so success here is
 * the assertion that stdout carries protocol only.
 */
describe.skipIf(!existsSync(entry))('stdio transport (dist/index.js)', () => {
  it('initialize + tools/list succeed with protocol-only stdout', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'ra-stdio-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env.PATH ?? '',
        RA_API_KEY: 'dummy-key-for-stdio-test',
        RA_CACHE_DIR: 'none',
        XDG_CACHE_HOME: cacheDir,
        LOG_LEVEL: 'debug', // maximise log output: it must all go to stderr
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('retroachievements-mcp');
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      rmSync(cacheDir, { recursive: true, force: true });
    }
    expect(stderr).toContain('ready (stdio)');
    expect(stderr).not.toContain('dummy-key-for-stdio-test');
  }, 20_000);
});
