import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, redact, registerSecret } from '../src/logger.js';

const SECRET = 'logger-secret-value-XYZ';
registerSecret(SECRET);

const capture = (level?: Parameters<typeof createLogger>[0]) => {
  const lines: string[] = [];
  const log = createLogger(level, l => lines.push(l));
  const records = () => lines.map(l => JSON.parse(l) as Record<string, unknown>);
  return { log, lines, records };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('redact', () => {
  it('scrubs every occurrence in strings', () => {
    expect(redact(`a ${SECRET} b ${SECRET}`)).toBe('a [REDACTED] b [REDACTED]');
  });

  it('recurses into arrays and plain objects', () => {
    expect(redact({ url: `https://x/?y=${SECRET}`, list: [SECRET, 1, null], n: 2 })).toEqual({
      url: 'https://x/?y=[REDACTED]',
      list: ['[REDACTED]', 1, null],
      n: 2,
    });
  });

  it('serialises Errors with own props and nested causes, all redacted', () => {
    const cause = Object.assign(new Error(`inner ${SECRET}`), { url: `u?y=${SECRET}` });
    const err = Object.assign(new Error(`outer ${SECRET}`, { cause }), { status: 503 });
    const out = redact(err) as Record<string, unknown>;
    expect(out).toMatchObject({ name: 'Error', message: 'outer [REDACTED]', status: 503 });
    expect(out.cause).toMatchObject({ message: 'inner [REDACTED]', url: 'u?y=[REDACTED]' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).not.toHaveProperty('stack');
  });

  it('ignores short/empty secrets (would shred ordinary text)', () => {
    registerSecret('abc');
    registerSecret('');
    registerSecret(undefined);
    expect(redact('abc def')).toBe('abc def');
  });

  it('passes primitives through', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(true)).toBe(true);
  });

  it('survives circular structures instead of overflowing the stack', () => {
    const a: Record<string, unknown> = { s: SECRET };
    a.self = a;
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
    expect(JSON.stringify(redact(a))).not.toContain(SECRET);
    expect(() => JSON.stringify(redact(e))).not.toThrow();
    expect(redact(a)).toEqual({ s: '[REDACTED]', self: '[Circular]' });
  });

  it('prints a shared (non-cyclic) reference in full each time', () => {
    const shared = { v: 1 };
    expect(redact({ a: shared, b: [shared] })).toEqual({ a: { v: 1 }, b: [{ v: 1 }] });
  });
});

describe('createLogger', () => {
  it('emits one JSON line per record with ts/level/msg/meta', () => {
    const { log, records } = capture('debug');
    log.info('hello', { a: 1 });
    const [r] = records();
    expect(r).toMatchObject({ level: 'info', msg: 'hello', meta: { a: 1 } });
    expect(typeof r?.ts).toBe('string');
    expect(Number.isNaN(Date.parse(r?.ts as string))).toBe(false);
  });

  it('omits meta when not given', () => {
    const { log, records } = capture();
    log.warn('x');
    expect(records()[0]).not.toHaveProperty('meta');
  });

  it('filters below the configured level', () => {
    const { log, records } = capture('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(records().map(r => r.level)).toEqual(['warn', 'error']);
  });

  it('defaults to info', () => {
    const { log, records } = capture();
    log.debug('d');
    log.info('i');
    expect(records().map(r => r.msg)).toEqual(['i']);
  });

  it('redacts both msg and meta', () => {
    const { log, lines } = capture();
    log.error(`failed ${SECRET}`, new Error(`GET https://ra/?y=${SECRET}`));
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('writes to stderr by default and never to stdout (stdout is the stdio protocol)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = createLogger('debug');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e', { k: SECRET });
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(4);
    const written = err.mock.calls.map(c => String(c[0]));
    expect(written.every(l => l.endsWith('\n'))).toBe(true);
    expect(written.join('')).not.toContain(SECRET);
  });
});
