import { describe, expect, it } from 'vitest';
import {
  MAX_RESULT_CHARS,
  MEDIA_BASE,
  badgeUrl,
  bool,
  clean,
  fail,
  imageUrl,
  num,
  ok,
  paginate,
  table,
  ts,
  type Column,
} from '../src/format.js';

describe('imageUrl / badgeUrl', () => {
  it('absolutises media paths', () => {
    expect(imageUrl('/Images/085573.png')).toBe(`${MEDIA_BASE}/Images/085573.png`);
    expect(imageUrl('Images/1.png')).toBe(`${MEDIA_BASE}/Images/1.png`);
  });
  it('passes through absolute URLs', () => {
    expect(imageUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(imageUrl('http://x.test/a.png')).toBe('http://x.test/a.png');
  });
  it('returns undefined for empty / non-string', () => {
    expect(imageUrl('')).toBeUndefined();
    expect(imageUrl(null)).toBeUndefined();
    expect(imageUrl(5)).toBeUndefined();
  });
  it('builds badge URLs, locked variant on request', () => {
    expect(badgeUrl('12345')).toBe(`${MEDIA_BASE}/Badge/12345.png`);
    expect(badgeUrl(12345, true)).toBe(`${MEDIA_BASE}/Badge/12345_lock.png`);
    expect(badgeUrl('')).toBeUndefined();
    expect(badgeUrl(null)).toBeUndefined();
    expect(badgeUrl({})).toBeUndefined();
  });
});

describe('clean', () => {
  it('drops null/undefined/"" keys recursively, keeping falsy-but-meaningful values', () => {
    expect(
      clean({ a: null, b: undefined, c: '', d: 0, e: false, f: { g: null, h: 'x' }, i: [] }),
    ).toEqual({ d: 0, e: false, f: { h: 'x' }, i: [] });
  });
  it('recurses into arrays but keeps array positions (table rows rely on arity)', () => {
    expect(clean([{ a: null, b: 1 }, null, 'x'])).toEqual([{ b: 1 }, null, 'x']);
  });
  it('passes primitives through', () => {
    expect(clean(3)).toBe(3);
    expect(clean('s')).toBe('s');
    expect(clean(null)).toBeNull();
  });
  it('does not mutate its input', () => {
    const input = { a: null, b: { c: '' } };
    clean(input);
    expect(input).toEqual({ a: null, b: { c: '' } });
  });
});

describe('num / bool', () => {
  it('num parses numeric strings and passes numbers', () => {
    expect(num(5)).toBe(5);
    expect(num('42')).toBe(42);
    expect(num('3.5')).toBe(3.5);
    expect(num(' 7 ')).toBe(7);
    expect(num('')).toBeUndefined();
    expect(num('  ')).toBeUndefined();
    expect(num('abc')).toBeUndefined();
    expect(num('Infinity')).toBeUndefined();
    expect(num(null)).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
    expect(num(true)).toBeUndefined();
  });
  it('bool maps 0/1/"0"/"1"/booleans only', () => {
    expect(bool(true)).toBe(true);
    expect(bool(false)).toBe(false);
    expect(bool(1)).toBe(true);
    expect(bool('1')).toBe(true);
    expect(bool(0)).toBe(false);
    expect(bool('0')).toBe(false);
    expect(bool('true')).toBeUndefined();
    expect(bool(2)).toBeUndefined();
    expect(bool(null)).toBeUndefined();
  });
});

describe('ts', () => {
  it('normalises the three RA formats to "YYYY-MM-DD HH:MM"', () => {
    expect(ts('2026-09-30T02:19:06.000000Z')).toBe('2026-09-30 02:19');
    expect(ts('2026-09-29T22:24:37+00:00')).toBe('2026-09-29 22:24');
    expect(ts('2026-09-30 01:28:41')).toBe('2026-09-30 01:28');
  });
  it('converts non-UTC offsets to UTC', () => {
    expect(ts('2026-09-29T22:24:37+02:00')).toBe('2026-09-29 20:24');
    expect(ts('2026-09-29T22:24:37-05:00')).toBe('2026-09-30 03:24');
    expect(ts('2026-01-01T00:30:00+05:30')).toBe('2025-12-31 19:00');
  });
  it('treats -00:00 as UTC', () => {
    expect(ts('2026-09-29T22:24:37-00:00')).toBe('2026-09-29 22:24');
  });
  it('returns undefined for empty / non-string, and unrecognised strings verbatim', () => {
    expect(ts('')).toBeUndefined();
    expect(ts(null)).toBeUndefined();
    expect(ts(1700000000)).toBeUndefined();
    expect(ts('2026-09-30')).toBe('2026-09-30');
    expect(ts('yesterday')).toBe('yesterday');
  });
});

describe('table', () => {
  type Row = { id: number; name?: string | null; hc?: string; zero?: number; flag?: boolean };
  const cols: Column<Row>[] = [
    ['id', r => r.id],
    ['name', r => r.name],
    ['hc', r => r.hc],
    ['zero', r => r.zero],
    ['flag', r => r.flag],
  ];

  it('drops columns empty on every row and fills remaining gaps with null', () => {
    const t = table<Row>(
      [
        { id: 1, name: 'a', hc: '', zero: 0 },
        { id: 2, name: null, zero: 0, flag: false },
      ],
      cols,
    );
    expect(t.cols).toEqual(['id', 'name', 'zero', 'flag']);
    expect(t.rows).toEqual([
      [1, 'a', 0, null],
      [2, null, 0, false],
    ]);
  });

  it('keeps 0 and false (not empty)', () => {
    const t = table<Row>([{ id: 0, zero: 0, flag: false }], cols);
    expect(t.cols).toEqual(['id', 'zero', 'flag']);
    expect(t.rows).toEqual([[0, 0, false]]);
  });

  it('handles no rows (every column empty → none kept)', () => {
    expect(table<Row>([], cols)).toEqual({ cols: [], rows: [] });
  });

  it('every row has the same arity as cols', () => {
    const t = table<Row>([{ id: 1 }, { id: 2, name: 'b' }, { id: 3, hc: 'x', flag: true }], cols);
    for (const r of t.rows) expect(r).toHaveLength(t.cols.length);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it('reports only total when everything fits', () => {
    expect(paginate(items, 0, 50)).toEqual({ items, meta: { total: 10 } });
    expect(paginate(items, 0, 10)).toEqual({ items, meta: { total: 10 } });
  });

  it('adds next_offset when truncated', () => {
    expect(paginate(items, 0, 3)).toEqual({
      items: [0, 1, 2],
      meta: { total: 10, next_offset: 3 },
    });
  });

  it('echoes offset and next_offset mid-list', () => {
    expect(paginate(items, 3, 3)).toEqual({
      items: [3, 4, 5],
      meta: { total: 10, offset: 3, next_offset: 6 },
    });
  });

  it('omits next_offset on the last page', () => {
    expect(paginate(items, 8, 3)).toEqual({ items: [8, 9], meta: { total: 10, offset: 8 } });
  });

  it('offset past the end → empty page, no next_offset', () => {
    expect(paginate(items, 20, 3)).toEqual({ items: [], meta: { total: 10, offset: 20 } });
  });

  it('defaults to offset 0, limit 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => i);
    const p = paginate(many);
    expect(p.items).toHaveLength(50);
    expect(p.meta).toEqual({ total: 60, next_offset: 50 });
  });
});

describe('ok / fail', () => {
  const text = (r: ReturnType<typeof ok>) => r.content[0]?.text ?? '';

  it('emits compact, cleaned JSON text only', () => {
    const r = ok({ a: 1, b: null, c: { d: '' }, e: [1, 2] });
    expect(r).toEqual({ content: [{ type: 'text', text: '{"a":1,"c":{},"e":[1,2]}' }] });
    expect(r).not.toHaveProperty('structuredContent');
    expect(r).not.toHaveProperty('isError');
  });

  it('serialises undefined as null', () => {
    expect(text(ok(undefined))).toBe('null');
  });

  it('truncates at MAX_RESULT_CHARS with a hint', () => {
    const t = text(ok({ s: 'x'.repeat(MAX_RESULT_CHARS * 2) }));
    expect(t.startsWith('{"s":"xxx')).toBe(true);
    expect(t).toContain(`[TRUNCATED at ${MAX_RESULT_CHARS} chars`);
    expect(t.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(t.slice(0, MAX_RESULT_CHARS)).toBe(
      JSON.stringify({ s: 'x'.repeat(MAX_RESULT_CHARS * 2) }).slice(0, MAX_RESULT_CHARS),
    );
  });

  it('does not truncate at exactly the limit', () => {
    const s = 'x'.repeat(MAX_RESULT_CHARS - '""'.length);
    expect(text(ok(s))).toBe(JSON.stringify(s));
  });

  it('fail marks isError', () => {
    expect(fail('boom')).toEqual({ isError: true, content: [{ type: 'text', text: 'boom' }] });
  });
});
