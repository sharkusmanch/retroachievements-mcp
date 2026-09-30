/**
 * Response shaping. Every tool result passes through here, and the rules exist to spend
 * as few model tokens as possible without losing information the model needs:
 *
 *  1. Compact JSON (no indentation). Pretty-printing roughly doubles the token count of
 *     a list payload for zero benefit to a model.
 *  2. Lists of records become a TABLE: `{"cols":[...],"rows":[[...],...]}`. Repeating
 *     every key on every row is the single largest source of waste in the raw API
 *     (GetGameList repeats ~11 keys × thousands of rows).
 *  3. null / undefined / "" values are dropped. The raw API is full of them.
 *  4. Image paths are omitted unless a tool is asked for them — they are opaque to a
 *     model and cost ~8 tokens each.
 *  5. Upstream redundancy is removed at the tool layer (GetGame returns the title twice,
 *     the console name twice and the icon twice).
 */

export const MEDIA_BASE = 'https://media.retroachievements.org';

/** `/Images/085573.png` → absolute media URL. */
export function imageUrl(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return MEDIA_BASE + (path.startsWith('/') ? path : `/${path}`);
}

/** Achievement badge name → badge image URL (locked variant when `locked`). */
export function badgeUrl(badge: unknown, locked = false): string | undefined {
  if (typeof badge !== 'string' && typeof badge !== 'number') return undefined;
  if (badge === '') return undefined;
  return `${MEDIA_BASE}/Badge/${badge}${locked ? '_lock' : ''}.png`;
}

/** Recursively drop null/undefined/"" values (and objects left empty by that). */
export function clean<T>(value: T): T {
  return cleanInner(value) as T;
}

function cleanInner(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanInner);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined || x === '') continue;
      out[k] = cleanInner(x);
    }
    return out;
  }
  return v;
}

/** Numeric-looking strings → numbers (RA returns many counts as strings). */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** "0"/"1"/0/1/true/false → boolean. */
export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1') return true;
  if (v === 0 || v === '0') return false;
  return undefined;
}

/**
 * Normalise RA timestamps to a short, unambiguous form: `2026-09-30 02:19` (UTC).
 * RA mixes `2026-09-30T02:19:06.000000Z`, `2026-09-29T22:24:37+00:00` and
 * `2026-09-30 01:28:41`; seconds are noise for a model and cost tokens.
 */
export function ts(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(v);
  if (!m) return v;
  // Offsets other than UTC are rare in RA output; convert when present.
  if (/[+-]\d{2}:\d{2}$/.test(v) && !/\+00:00$/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 16).replace('T', ' ');
  }
  return `${m[1]} ${m[2]}`;
}

export type Column<T> = readonly [name: string, get: (row: T) => unknown];

export interface Table {
  cols: string[];
  rows: unknown[][];
}

/**
 * Array of records → table. Columns whose value is empty on EVERY row are dropped
 * entirely (e.g. `hardcore_date` for a softcore-only player), and remaining empties are
 * emitted as `null` to keep row arity fixed.
 */
export function table<T>(items: readonly T[], cols: readonly Column<T>[]): Table {
  const raw = items.map(it =>
    cols.map(([, get]) => {
      const v = get(it);
      return v === undefined || v === '' ? null : v;
    }),
  );
  const keep = cols.map((_, i) => raw.some(r => r[i] !== null));
  return {
    cols: cols.filter((_, i) => keep[i]).map(([n]) => n),
    rows: raw.map(r => r.filter((_, i) => keep[i])),
  };
}

export interface Page<T> {
  items: T[];
  /** Pagination metadata; only present when the result is actually truncated/offset. */
  meta: { total: number; offset?: number; next_offset?: number };
}

/** Client-side slice with a `next_offset` hint only when more remain. */
export function paginate<T>(items: readonly T[], offset = 0, limit = 50): Page<T> {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    items: slice,
    meta: {
      total: items.length,
      ...(offset > 0 ? { offset } : {}),
      ...(next < items.length ? { next_offset: next } : {}),
    },
  };
}

/** Hard ceiling on any single tool result, in characters (~4 chars/token). */
export const MAX_RESULT_CHARS = 60_000;

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/**
 * Serialise a result. Deliberately text-only: returning `structuredContent` as well
 * would send the same payload to the model twice.
 */
export function ok(data: unknown): ToolResult {
  let text = JSON.stringify(clean(data));
  if (text === undefined) text = 'null';
  if (text.length > MAX_RESULT_CHARS) {
    text =
      text.slice(0, MAX_RESULT_CHARS) +
      `…[TRUNCATED at ${MAX_RESULT_CHARS} chars — narrow the query or lower "limit"]`;
  }
  return { content: [{ type: 'text', text }] };
}

export function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
