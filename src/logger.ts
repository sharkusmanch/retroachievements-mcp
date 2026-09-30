/**
 * Minimal structured logger with mandatory secret redaction.
 *
 * The RetroAchievements Web API key travels as a QUERY PARAMETER (`y=`), so any logged
 * URL would carry it. Every value registered here is scrubbed from any message or
 * serialized payload before it is written, including values nested inside Error causes.
 *
 * Output goes to STDERR, always: in stdio mode stdout IS the JSON-RPC channel, and a
 * single stray log line there corrupts the protocol stream.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const secrets = new Set<string>();

/** Register a value that must never appear in output. No-op for short/empty values. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

export function redact(input: unknown): unknown {
  if (typeof input === 'string') {
    let out = input;
    for (const s of secrets) out = out.split(s).join('[REDACTED]');
    return out;
  }
  if (input instanceof Error) {
    // Carry own enumerable props (e.g. RAError's status/endpoint) or the operator
    // would see strictly less than the model does.
    const extra: Record<string, unknown> = {};
    for (const k of Object.keys(input) as (keyof typeof input)[]) {
      if (k !== 'name' && k !== 'message' && k !== 'stack' && k !== 'cause') {
        extra[k as string] = redact((input as unknown as Record<string, unknown>)[k as string]);
      }
    }
    return {
      name: input.name,
      message: redact(input.message),
      ...extra,
      ...(input.cause === undefined ? {} : { cause: redact(input.cause) }),
    };
  }
  if (Array.isArray(input)) return input.map(redact);
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, redact(v)]));
  }
  return input;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(
  level: LogLevel = 'info',
  sink: (line: string) => void = line => process.stderr.write(line + '\n'),
): Logger {
  const min = LEVELS[level];
  const emit = (lvl: LogLevel, msg: string, meta?: unknown): void => {
    if (LEVELS[lvl] < min) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact(msg),
    };
    if (meta !== undefined) record.meta = redact(meta);
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}
