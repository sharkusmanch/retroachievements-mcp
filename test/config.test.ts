import { describe, expect, it } from 'vitest';
import { applyArgs, loadConfig } from '../src/config.js';

const KEY = { RA_API_KEY: 'k'.repeat(32) };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(KEY);
    expect(c).toMatchObject({
      RA_API_KEY: KEY.RA_API_KEY,
      RA_BASE_URL: 'https://retroachievements.org',
      RA_TIMEOUT_MS: 20_000,
      RA_MAX_CONCURRENCY: 4,
      RA_RATE_PER_MINUTE: 60,
      RA_RATE_BURST: 8,
      RA_PREWARM_CATALOG: false,
      RA_CACHE_MAX_ENTRIES: 500,
      RA_CACHE_TTL_SCALE: 1,
      MCP_TRANSPORT: 'stdio',
      MCP_HOST: '127.0.0.1',
      MCP_PORT: 8080,
      MCP_ALLOWED_HOSTS: [],
      LOG_LEVEL: 'info',
    });
    expect(c.RA_USERNAME).toBeUndefined();
    expect(c.MCP_AUTH_TOKEN).toBeUndefined();
    expect(c.RA_CACHE_DIR).toBeUndefined();
  });

  it('requires an API key, with a helpful message', () => {
    expect(() => loadConfig({})).toThrow(/RA_API_KEY \(or RETROACHIEVEMENTS_API_KEY\) is required/);
  });

  it('accepts RETROACHIEVEMENTS_API_KEY / _USERNAME as aliases', () => {
    const c = loadConfig({ RETROACHIEVEMENTS_API_KEY: 'alias', RETROACHIEVEMENTS_USERNAME: 'bob' });
    expect(c.RA_API_KEY).toBe('alias');
    expect(c.RA_USERNAME).toBe('bob');
  });

  it('prefers RA_* over the aliases', () => {
    const c = loadConfig({
      RA_API_KEY: 'primary',
      RETROACHIEVEMENTS_API_KEY: 'alias',
      RA_USERNAME: 'alice',
      RETROACHIEVEMENTS_USERNAME: 'bob',
    });
    expect(c.RA_API_KEY).toBe('primary');
    expect(c.RA_USERNAME).toBe('alice');
  });

  it('treats blank RA_API_KEY as unset (falls back to alias, else errors)', () => {
    expect(loadConfig({ RA_API_KEY: '  ', RETROACHIEVEMENTS_API_KEY: 'alias' }).RA_API_KEY).toBe(
      'alias',
    );
    expect(() => loadConfig({ RA_API_KEY: '', RETROACHIEVEMENTS_API_KEY: ' ' })).toThrow(
      /RA_API_KEY/,
    );
  });

  it('treats blank RA_USERNAME / MCP_AUTH_TOKEN as unset', () => {
    const c = loadConfig({ ...KEY, RA_USERNAME: '', MCP_AUTH_TOKEN: '   ' });
    expect(c.RA_USERNAME).toBeUndefined();
    expect(c.MCP_AUTH_TOKEN).toBeUndefined();
  });

  it('enforces MCP_AUTH_TOKEN min length 16', () => {
    expect(() => loadConfig({ ...KEY, MCP_AUTH_TOKEN: 'short' })).toThrow(
      /MCP_AUTH_TOKEN must be at least 16 chars/,
    );
    expect(loadConfig({ ...KEY, MCP_AUTH_TOKEN: 'x'.repeat(16) }).MCP_AUTH_TOKEN).toBe(
      'x'.repeat(16),
    );
  });

  it('never echoes the API key in validation errors', () => {
    const secret = 'my-secret-api-key-value';
    try {
      loadConfig({ RA_API_KEY: secret, RA_TIMEOUT_MS: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/RA_TIMEOUT_MS/);
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('parses MCP_ALLOWED_HOSTS as a trimmed CSV', () => {
    expect(
      loadConfig({ ...KEY, MCP_ALLOWED_HOSTS: ' a.test, b.test ,,' }).MCP_ALLOWED_HOSTS,
    ).toEqual(['a.test', 'b.test']);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('RA_PREWARM_CATALOG=%s → %s', (v, want) => {
    expect(loadConfig({ ...KEY, RA_PREWARM_CATALOG: v }).RA_PREWARM_CATALOG).toBe(want);
  });

  it('rejects unknown RA_PREWARM_CATALOG values', () => {
    expect(() => loadConfig({ ...KEY, RA_PREWARM_CATALOG: 'yes' })).toThrow(/RA_PREWARM_CATALOG/);
  });

  it('coerces numbers and enforces bounds', () => {
    const c = loadConfig({
      ...KEY,
      MCP_PORT: '9000',
      RA_MAX_CONCURRENCY: '2',
      RA_CACHE_TTL_SCALE: '0',
    });
    expect(c.MCP_PORT).toBe(9000);
    expect(c.RA_MAX_CONCURRENCY).toBe(2);
    expect(c.RA_CACHE_TTL_SCALE).toBe(0);
    expect(() => loadConfig({ ...KEY, RA_MAX_CONCURRENCY: '0' })).toThrow(/RA_MAX_CONCURRENCY/);
    expect(() => loadConfig({ ...KEY, MCP_PORT: '70000' })).toThrow(/MCP_PORT/);
    expect(() => loadConfig({ ...KEY, RA_BASE_URL: 'not a url' })).toThrow(/RA_BASE_URL/);
    expect(() => loadConfig({ ...KEY, LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
  });

  it('keeps RA_CACHE_DIR verbatim (""/"none" are interpreted by the entrypoint)', () => {
    expect(loadConfig({ ...KEY, RA_CACHE_DIR: '' }).RA_CACHE_DIR).toBe('');
    expect(loadConfig({ ...KEY, RA_CACHE_DIR: 'none' }).RA_CACHE_DIR).toBe('none');
    expect(loadConfig({ ...KEY, RA_CACHE_DIR: '/tmp/x' }).RA_CACHE_DIR).toBe('/tmp/x');
  });

  describe('fail-closed Host allowlist', () => {
    it('refuses HTTP on a non-loopback host without MCP_ALLOWED_HOSTS', () => {
      expect(() => loadConfig({ ...KEY, MCP_TRANSPORT: 'http', MCP_HOST: '0.0.0.0' })).toThrow(
        /MCP_ALLOWED_HOSTS is required/,
      );
    });

    it('even with a bearer token set (rule is unconditional)', () => {
      expect(() =>
        loadConfig({
          ...KEY,
          MCP_TRANSPORT: 'http',
          MCP_HOST: '0.0.0.0',
          MCP_AUTH_TOKEN: 'x'.repeat(20),
        }),
      ).toThrow(/MCP_ALLOWED_HOSTS/);
    });

    it('allows it once hosts are configured', () => {
      const c = loadConfig({
        ...KEY,
        MCP_TRANSPORT: 'http',
        MCP_HOST: '0.0.0.0',
        MCP_ALLOWED_HOSTS: 'ra.example.com',
      });
      expect(c.MCP_ALLOWED_HOSTS).toEqual(['ra.example.com']);
    });

    it.each(['127.0.0.1', 'localhost', '::1'])('allows loopback %s without hosts', host => {
      expect(loadConfig({ ...KEY, MCP_TRANSPORT: 'http', MCP_HOST: host }).MCP_HOST).toBe(host);
    });

    it('does not apply to stdio', () => {
      expect(
        loadConfig({ ...KEY, MCP_TRANSPORT: 'stdio', MCP_HOST: '0.0.0.0' }).MCP_TRANSPORT,
      ).toBe('stdio');
    });

    it('applies when --http comes from argv', () => {
      expect(() => loadConfig(applyArgs({ ...KEY }, ['--http', '--host', '0.0.0.0']))).toThrow(
        /MCP_ALLOWED_HOSTS/,
      );
    });
  });
});

describe('applyArgs', () => {
  it('maps flags onto env without mutating the input', () => {
    const env = { MCP_TRANSPORT: 'stdio', MCP_PORT: '1' };
    const out = applyArgs(env, ['--http', '--port', '9999', '--host', '0.0.0.0']);
    expect(out).toMatchObject({ MCP_TRANSPORT: 'http', MCP_PORT: '9999', MCP_HOST: '0.0.0.0' });
    expect(env).toEqual({ MCP_TRANSPORT: 'stdio', MCP_PORT: '1' });
  });

  it('last transport flag wins', () => {
    expect(applyArgs({}, ['--http', '--stdio']).MCP_TRANSPORT).toBe('stdio');
    expect(applyArgs({ MCP_TRANSPORT: 'stdio' }, ['--http']).MCP_TRANSPORT).toBe('http');
  });

  it('ignores a trailing value-less --port/--host and unknown flags', () => {
    expect(applyArgs({ MCP_PORT: '1' }, ['--port'])).toEqual({ MCP_PORT: '1' });
    expect(applyArgs({}, ['--host'])).toEqual({});
    expect(applyArgs({}, ['--bogus', 'x'])).toEqual({});
  });

  it('consumes the value so it is not re-read as a flag', () => {
    expect(applyArgs({}, ['--host', '--http'])).toEqual({ MCP_HOST: '--http' });
  });

  it('round-trips through loadConfig', () => {
    const c = loadConfig(applyArgs({ ...KEY }, ['--http', '--port', '3001']));
    expect(c.MCP_TRANSPORT).toBe('http');
    expect(c.MCP_PORT).toBe(3001);
  });
});
