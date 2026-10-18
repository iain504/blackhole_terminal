// Tiny in-memory log bus for the bottom Console drawer.
// Any component can ttLog(source, message, level); the ConsoleDrawer subscribes.
// Ring buffer (client-side only, not persisted across reloads).

export type LogLevel = 'info' | 'ok' | 'warn' | 'error'

export interface LogEntry {
  id: number
  ts: number
  source: string
  message: string
  level: LogLevel
}

const MAX_ENTRIES = 300

let seq = 0
let entries: LogEntry[] = []
const listeners = new Set<(entries: LogEntry[]) => void>()

export function ttLog(source: string, message: string, level: LogLevel = 'info'): void {
  seq += 1
  const entry: LogEntry = { id: seq, ts: Date.now(), source, message, level }
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry] : [...entries, entry]
  listeners.forEach((fn) => fn(entries))
}

export function getLogs(): LogEntry[] {
  return entries
}

export function clearLogs(): void {
  entries = []
  listeners.forEach((fn) => fn(entries))
}

export function subscribeLogs(fn: (entries: LogEntry[]) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
