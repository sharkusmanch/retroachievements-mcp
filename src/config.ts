import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform(s =>
    s
      .split(',')
      .map(h => h.trim())
      .filter(Boolean),
  );

/**
 * Normalise a Host-allowlist entry to the form the SDK's validator compares against
 * (`new URL('http://' + host).hostname`): lowercase, no port, IPv6 in brackets.
 * `*` is passed through (explicit opt-out of host validation).
 */
export function normalizeAllowedHost(entry: string): string {
  const h = entry.trim().toLowerCase();
  if (h === '*' || h === '') return h;
  // [v6] or [v6]:port
  const br = /^(\[[^\]]+\])(?::\d+)?$/.exec(h);
  if (br) return br[1] as string;
  // Bare IPv6 (two or more colons) — no port can be expressed without brackets.
  if ((h.match(/:/g) ?? []).length >= 2) return `[${h}]`;
  return h.replace(/:\d+$/, '');
}

const API_KEY_REQUIRED = 'RA_API_KEY (or RETROACHIEVEMENTS_API_KEY) is required';

/**
 * Environment contract.
 *
 * RA_API_KEY is the only required value. RETROACHIEVEMENTS_API_KEY is accepted as an alias
 * because that is the name the official SDK docs (and many existing secrets) use.
 */
const EnvSchema = z.object({
  // `error` covers the missing case: blank values are normalised to undefined below, so
  // `.min(1)`'s message alone would never be shown.
  RA_API_KEY: z.string({ error: API_KEY_REQUIRED }).min(1, API_KEY_REQUIRED),
  /**
   * Default user for every user-scoped tool, so the common "my stats" case needs no
   * username argument (and spends no tokens on one). Optional: without it, user-scoped
   * tools require an explicit `user`.
   */
  RA_USERNAME: z.string().optional(),
  RA_BASE_URL: z.url().default('https://retroachievements.org'),
  RA_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /**
   * Upper bound on concurrent upstream requests. RetroAchievements publishes no rate-limit
   * headers; staying at a handful of in-flight calls keeps a burst of tool calls polite.
   */
  RA_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  /**
   * Client-side pacing (defaults: 72/min, burst 10). Measured: ~80/min sustained is fine;
   * bursts of ~20 draw 429s. A 429 drains the bucket and pauses it for the retry wait.
   */
  RA_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(72),
  RA_RATE_BURST: z.coerce.number().int().min(1).max(60).default(10),
  /**
   * Directory for the persistent game-catalog cache (per-console game lists — the only
   * large, slow-changing data). Default: $XDG_CACHE_HOME or ~/.cache. Empty string or
   * "none" disables persistence (memory only).
   */
  RA_CACHE_DIR: z.string().optional(),
  /** Warm every console catalog in the background at startup (HTTP mode). */
  RA_PREWARM_CATALOG: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform(v => v === 'true' || v === '1'),
  /** Cache entry ceiling. Entries are TTL'd per endpoint; this caps memory. */
  RA_CACHE_MAX_ENTRIES: z.coerce.number().int().min(0).default(500),
  /**
   * Cache size ceiling in bytes (estimated from response text length; default 64 MB).
   * Single responses over ~1 MB are never cached.
   */
  RA_CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .default(64 * 1024 * 1024),
  /** Multiplies every per-endpoint TTL. 0 disables caching entirely. */
  RA_CACHE_TTL_SCALE: z.coerce.number().min(0).default(1),

  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HOST: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /**
   * Host-header allowlist for DNS-rebinding protection, applied ONLY to /mcp. Entries are
   * normalised (lowercase, port stripped, IPv6 bracketed). Empty on a loopback bind =
   * the SDK's localhost allowlist; `*` disables the check (logged as a warning).
   */
  MCP_ALLOWED_HOSTS: csv.transform(hs => [...new Set(hs.map(normalizeAllowedHost))]),
  /**
   * Optional bearer token for /mcp. When set, requests must send
   * `Authorization: Bearer <token>`. Leave unset behind a trusted network boundary.
   */
  MCP_AUTH_TOKEN: z.string().min(16, 'MCP_AUTH_TOKEN must be at least 16 chars').optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

/** CLI flags override env: `--http`, `--stdio`, `--port <n>`, `--host <h>`. */
export function applyArgs(env: NodeJS.ProcessEnv, argv: string[]): NodeJS.ProcessEnv {
  const out = { ...env };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') out.MCP_TRANSPORT = 'http';
    else if (a === '--stdio') out.MCP_TRANSPORT = 'stdio';
    else if (a === '--port' && argv[i + 1]) out.MCP_PORT = argv[++i];
    else if (a === '--host' && argv[i + 1]) out.MCP_HOST = argv[++i];
  }
  return out;
}

const blankToUndefined = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === '' ? undefined : v;

/**
 * Fail fast on malformed config only. Deliberately does NOT probe RetroAchievements: a
 * connectivity gate would turn an upstream outage into a CrashLoopBackOff.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse({
    ...env,
    RA_API_KEY: blankToUndefined(env.RA_API_KEY) ?? blankToUndefined(env.RETROACHIEVEMENTS_API_KEY),
    RA_USERNAME:
      blankToUndefined(env.RA_USERNAME) ?? blankToUndefined(env.RETROACHIEVEMENTS_USERNAME),
    MCP_AUTH_TOKEN: blankToUndefined(env.MCP_AUTH_TOKEN),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  // FAIL CLOSED for HTTP on a non-loopback bind: with no bearer token, the Host allowlist
  // is the only guard in front of an endpoint that spends the operator's API key.
  const loopback = ['127.0.0.1', 'localhost', '::1'];
  if (
    cfg.MCP_TRANSPORT === 'http' &&
    cfg.MCP_ALLOWED_HOSTS.length === 0 &&
    !loopback.includes(cfg.MCP_HOST)
  ) {
    throw new Error(
      `MCP_ALLOWED_HOSTS is required when serving HTTP on a non-loopback host (got "${cfg.MCP_HOST}"). ` +
        'Set it to the hostnames clients will use, or bind to 127.0.0.1.',
    );
  }
  return cfg;
}
