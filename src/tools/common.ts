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
 * Shared parameter schemas. Descriptions are intentionally terse (or absent where the
 * name says it all): every word here is re-sent to the model in the tools list on every
 * conversation turn.
 */
export const userParam = z.string().min(1).max(64).optional().describe('Default: configured user');

export const limitParam = (def: number, max: number) =>
  z.number().int().min(1).max(max).default(def);

export const offsetParam = z.number().int().min(0).default(0);

export const imagesParam = z.boolean().default(false);

export const idParam = () => z.number().int().positive();

// ---------- advertised-schema slimming ----------

type Json = Record<string, unknown>;

interface JsonSchemaConverter {
  input: (options: { target: string }) => Json;
  output: (options: { target: string }) => Json;
}

/**
 * Drop JSON-Schema noise a model gains nothing from: `$schema`, `propertyNames`,
 * `maximum: MAX_SAFE_INTEGER` (from `.int()`), `exclusiveMinimum: 0` (`.positive()`),
 * limit/offset lower bounds, free-string length bounds, and falsy defaults
 * (`false`/`0`/`[]`/`{}` — the obvious default).
 */
const isEmpty = (v: unknown) =>
  Array.isArray(v) ? v.length === 0 : !!v && typeof v === 'object' && Object.keys(v).length === 0;

function prune(node: unknown, key?: string): unknown {
  if (Array.isArray(node)) return node.map(x => prune(x, key));
  if (!node || typeof node !== 'object') return node;
  const s = node as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === '$schema' || k === 'propertyNames') continue;
    if (k === 'maximum' && v === Number.MAX_SAFE_INTEGER) continue;
    if (k === 'exclusiveMinimum' && v === 0) continue;
    if (k === 'minimum' && (key === 'offset' || key === 'limit')) continue;
    if ((k === 'minLength' || k === 'maxLength') && s.type === 'string' && !s.enum) continue;
    if (k === 'default' && (v === false || v === 0 || isEmpty(v))) {
      continue;
    }
    out[k] =
      k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, prune(pv, pk)]))
        : prune(v, k === 'items' ? key : k);
  }
  return out;
}

/**
 * Wrap a tool's input schema so the JSON Schema ADVERTISED in tools/list is pruned
 * (see prune()). Only `~standard.jsonSchema.input` is replaced; zod validation
 * (`~standard.validate`) is untouched, so every bound still applies server-side.
 */
export function lean<S extends z.ZodType>(schema: S): S {
  const std = schema['~standard'] as unknown as { jsonSchema: JsonSchemaConverter };
  const jsonSchema: JsonSchemaConverter = {
    input: o => prune(std.jsonSchema.input(o)) as Json,
    output: o => std.jsonSchema.output(o),
  };
  Object.defineProperty(schema, '~standard', {
    value: { ...std, jsonSchema },
    configurable: true,
  });
  return schema;
}

/**
 * Upstream page size for a caller's `limit`: rounded UP to a shared bucket (25/100/500,
 * capped at `max`) so nearby limits hit one cache entry. Callers slice to `limit`.
 */
export function pageBucket(limit: number, max = 500): number {
  for (const b of [25, 100, 500]) if (limit <= b) return Math.min(b, max);
  return max;
}

/** RA award kind (`beaten-hardcore`, …) → the short label every tool emits. */
export function awardKind(k: string | null | undefined): string | undefined {
  switch (k) {
    case 'beaten-hardcore':
      return 'beaten_hc';
    case 'beaten-softcore':
      return 'beaten';
    default:
      return k ?? undefined;
  }
}

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
