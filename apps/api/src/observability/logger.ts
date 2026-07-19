export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Returns a logger with `fields` merged into every future line — how request-scoped loggers get their requestId. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  /** Fields bound to this logger and merged into every line it (or a child) emits. */
  context?: LogFields
  /** Minimum level to emit. Defaults to the LOG_LEVEL env var, then 'info'. */
  level?: LogLevel
  /**
   * Injectable output, decoupled from a clock for deterministic tests. Defaults
   * to console.log/console.error, which are "real stdout/stderr" on Node and
   * also the only output Cloudflare Workers captures — this API is headed
   * there per docs/decisions/0002-hosting.md, so process.stdout.write would be
   * a trap.
   */
  sink?: (line: string, level: LogLevel) => void
  /** Injectable clock so tests get deterministic timestamps. */
  clock?: () => Date
}

// Avoids Record<LogLevel, number> index access, which noUncheckedIndexedAccess
// would widen to `number | undefined` even though LogLevel is exhaustive.
function levelWeight(level: LogLevel): number {
  switch (level) {
    case 'debug':
      return 0
    case 'info':
      return 1
    case 'warn':
      return 2
    case 'error':
      return 3
  }
}

function parseLevel(value: string | undefined): LogLevel | undefined {
  const lower = value?.toLowerCase()
  if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error') {
    return lower
  }
  return undefined
}

function resolveLevel(level: LogLevel | undefined): LogLevel {
  return level ?? parseLevel(process.env.LOG_LEVEL) ?? 'info'
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === 'warn' || level === 'error') {
    console.error(line)
  } else {
    console.log(line)
  }
}

const REDACT_KEYS = new Set(['authorization', 'cookie', 'password', 'token', 'secret'])
const REDACTED = '[redacted]'

function serializeValue(key: string, value: unknown): unknown {
  if (REDACT_KEYS.has(key.toLowerCase())) return REDACTED
  // Error has no enumerable own properties, so JSON.stringify(error) is '{}'.
  // Pull out the fields that actually explain what broke.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

function serializeFields(fields: LogFields): LogFields {
  const result: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    result[key] = serializeValue(key, value)
  }
  return result
}

/**
 * Tiny structured JSON logger. No dependency: both this API's runtimes (Node
 * now, Cloudflare Workers later) can write a JSON string to console.log, and
 * that's the entire feature set a log line needs.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const context = options.context ?? {}
  const level = resolveLevel(options.level)
  const sink = options.sink ?? defaultSink
  const clock = options.clock ?? (() => new Date())

  function log(logLevel: LogLevel, msg: string, fields?: LogFields): void {
    if (levelWeight(logLevel) < levelWeight(level)) return

    // Reserved keys spread last so a caller-supplied field can never clobber
    // the line's own level/time/msg.
    const line = JSON.stringify({
      ...serializeFields(context),
      ...(fields ? serializeFields(fields) : {}),
      level: logLevel,
      time: clock().toISOString(),
      msg,
    })
    sink(line, logLevel)
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (fields) => createLogger({ context: { ...context, ...fields }, level, sink, clock }),
  }
}
