// Tiny in-memory log bus for the bottom Console drawer.
// Any component can ttLog(source, message, level); the ConsoleDrawer subscribes.
// Ring buffer, client-side only. Task 4-c: the last ~100 entries are persisted
// to sessionStorage (debounced on append, flushed on clear) and re-hydrated at
// module load, so the console survives a page reload instead of starting empty.

export type LogLevel = 'info' | 'ok' | 'warn' | 'error'

export interface LogEntry {
  id: number
  ts: number
  source: string
  message: string
  level: LogLevel
}

const MAX_ENTRIES = 300
const PERSIST_KEY = 'tt:consoleLogs'
const PERSIST_MAX = 100
const PERSIST_DEBOUNCE_MS = 400

let seq = 0
let entries: LogEntry[] = []
const listeners = new Set<(entries: LogEntry[]) => void>()

// ---- sessionStorage persistence (client only) ----------------------------
let persistTimer: ReturnType<typeof setTimeout> | null = null
let hydrated = false

function persistLogs(): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify(entries.slice(-PERSIST_MAX)))
  } catch { /* private mode / quota */ }
}

function schedulePersist(): void {
  if (typeof window === 'undefined') return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistLogs()
  }, PERSIST_DEBOUNCE_MS)
}

function hydratePersisted(): void {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return
    const clean = (parsed as LogEntry[])
      .filter((e) => e != null && typeof e.id === 'number' && typeof e.ts === 'number' && typeof e.source === 'string' && typeof e.message === 'string' && typeof e.level === 'string')
      .slice(-PERSIST_MAX)
    if (clean.length === 0) return
    seq = Math.max(seq, ...clean.map((e) => e.id))
    entries = clean
  } catch { /* corrupt or unavailable — start empty */ }
}
hydratePersisted()

export function ttLog(source: string, message: string, level: LogLevel = 'info'): void {
  seq += 1
  const entry: LogEntry = { id: seq, ts: Date.now(), source, message, level }
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry] : [...entries, entry]
  listeners.forEach((fn) => fn(entries))
  schedulePersist()
}

export function getLogs(): LogEntry[] {
  return entries
}

export function clearLogs(): void {
  entries = []
  listeners.forEach((fn) => fn(entries))
  // flush immediately so a reload right after "Clear" stays empty
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persistLogs()
}

export function subscribeLogs(fn: (entries: LogEntry[]) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
