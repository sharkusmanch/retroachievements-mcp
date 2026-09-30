import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RAError, type RAClient } from '../client.js';
import type { Logger } from '../logger.js';
import type { CatalogStore } from '../catalog.js';
import { fail, ok, type ToolResult } from '../format.js';

export interface ToolContext {
  client: RAClient;
  /** Persistent per-console game lists (use for any whole-catalog need). */
  catalog: CatalogStore;
  log: Logger;
  /** Configured default username (RA_USERNAME), if any. */
  defaultUser: string | undefined;
}

export type Register = (server: McpServer, ctx: ToolContext) => void;

/**
 * Shared parameter schemas. Descriptions are intentionally terse: every word here is
 * re-sent to the model in the tools list on every conversation turn.
 */
export const userParam = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('Username or ULID; defaults to the configured user');

export const limitParam = (def: number, max: number) =>
  z.number().int().min(1).max(max).default(def).describe(`Max rows (default ${def})`);

export const offsetParam = z.number().int().min(0).default(0).describe('Rows to skip');

export const idParam = (what: string) => z.number().int().positive().describe(`${what} ID`);

/** Readonly + open-world: every tool here only reads a third-party API. */
export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Resolve the `user` argument, falling back to RA_USERNAME. */
export function resolveUser(ctx: ToolContext, user: string | undefined): string {
  const u = user ?? ctx.defaultUser;
  if (!u) throw new ToolInputError('"user" is required (no default RA_USERNAME configured)');
  return u;
}

/** A caller mistake, reported verbatim to the model. */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

/**
 * Wrap a tool body: returns `ok(result)` or a model-readable error. Never throws —
 * an exception would surface as a protocol error the model cannot reason about.
 */
export function handler<A>(
  ctx: ToolContext,
  name: string,
  fn: (args: A) => Promise<unknown>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      const r = await fn(args);
      return r === null || r === undefined ? ok({ result: 'not found' }) : ok(r);
    } catch (e) {
      if (e instanceof ToolInputError) return fail(e.message);
      if (e instanceof RAError) {
        ctx.log.warn(`${name} upstream error`, e);
        return fail(
          `RetroAchievements ${e.status || ''} on ${e.endpoint}: ${e.message}`.replace('  ', ' '),
        );
      }
      ctx.log.error(`${name} failed`, e);
      return fail(`${name} failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };
}
