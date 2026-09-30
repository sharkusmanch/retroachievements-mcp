import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { RAClient } from '../src/client.js';
import type { CatalogStore } from '../src/catalog.js';
import { createServer } from '../src/server.js';
import type { ToolContext } from '../src/tools/common.js';

/**
 * Model-facing size of the tool list: what a client turns into the model's tool
 * definitions (name + description + input schema), re-sent on every turn. Budgeted so
 * a verbose description or an un-lean()ed schema fails CI instead of silently costing
 * tokens forever.
 */
const BUDGET_CHARS = 8_500;

async function connect() {
  const get = vi.fn(() => Promise.resolve(null));
  const ctx: ToolContext = {
    client: { get, peek: vi.fn(), peekAny: vi.fn() } as unknown as RAClient,
    catalog: {} as CatalogStore,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    defaultUser: 'me',
  };
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'budget', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, get };
}

describe('tools/list budget', () => {
  it(`model-facing size ≤ ${BUDGET_CHARS} chars`, async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const size = tools.reduce(
      (n, t) =>
        n +
        JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema })
          .length,
      0,
    );
    expect(tools.length).toBe(15);
    expect(size).toBeLessThanOrEqual(BUDGET_CHARS);
    await client.close();
  });

  it('advertised schemas are lean: no $schema, no MAX_SAFE_INTEGER, no falsy defaults', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const text = JSON.stringify(tools.map(t => t.inputSchema));
    expect(text).not.toContain('$schema');
    expect(text).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(text).not.toContain('"exclusiveMinimum":0');
    expect(text).not.toContain('"default":false');
    expect(text).not.toContain('"default":[]');
    expect(text).not.toContain('propertyNames');
    await client.close();
  });

  it.each([
    ['get_game', { game_id: -1 }],
    ['get_game', { game_id: 1.5 }],
    ['get_game', { game_id: 1, limit: 9999 }],
    ['get_game', { game_id: 1, offset: -1 }],
    ['find_games', { query: '', console_id: 1 }],
    ['get_user_profile', { user: 'x'.repeat(65) }],
    ['get_user_unlocks', { minutes: 0 }],
  ])('zod still validates what the lean schema no longer advertises: %s %j', async (name, args) => {
    const { client, get } = await connect();
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
    await client.close();
  });
});
