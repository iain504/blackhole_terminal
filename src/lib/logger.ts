// Task 11-c — structured JSON logging for the server side.
//
// The 2026 deep review asked for structured logs: single-line JSON events on
// stdout parse cleanly in journalctl / `docker logs` / any log shipper, vs.
// prose like `[health] probe failed: ...`. This is NOT a replacement for the
// rich per-engine journaling (AlgoLog / GridFill rows, console-log.ts UI bus)
// — it covers cross-cutting OPS events: auth failures, rate-limit fallbacks,
// health degradation, engine lifecycle.
//
// Output shape (one line, always):
//   {"t":"2026-10-25T12:00:00.000Z","lvl":"warn","evt":"auth_login_failed","ip":"1.2.3.4","user":"trader"}
//
// Level filter via LOG_LEVEL env (debug|info|warn|error; default info).
// NEVER log secrets, tokens, TOTP codes or passwords — ids, usernames, IPs,
// counts and durations only.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel = LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? LEVELS.info

/** Values safe for logs — primitives only, no nested objects to leak. */
export type LogFields = Record<string, string | number | boolean | null | undefined>

function emit(level: LogLevel, evt: string, fields?: LogFields): void {
  if (LEVELS[level] < minLevel) return
  const line: Record<string, unknown> = { t: new Date().toISOString(), lvl: level, evt }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) line[k] = v
    }
  }
  const serialized = JSON.stringify(line)
  if (level === 'error') console.error(serialized)
  else if (level === 'warn') console.warn(serialized)
  else console.log(serialized)
}

export const log = {
  debug: (evt: string, fields?: LogFields) => emit('debug', evt, fields),
  info: (evt: string, fields?: LogFields) => emit('info', evt, fields),
  warn: (evt: string, fields?: LogFields) => emit('warn', evt, fields),
  error: (evt: string, fields?: LogFields) => emit('error', evt, fields),
}
