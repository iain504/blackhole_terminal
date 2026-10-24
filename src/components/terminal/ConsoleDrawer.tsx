'use client'

// Foldable bottom console (Task: "create a bottom console small tab. foldable").
// Collapsed: one slim bar above the footer. Expanded: scrollable event log
// (alerts, fills, feed status, layout saves). Fold state persists via
// localStorage; the log itself persists via the console-log bus (last ~100
// entries → sessionStorage, debounced on append, hydrated at module load).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronUp, Terminal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LogEntry, clearLogs, getLogs, subscribeLogs } from '@/lib/console-log'

// folded/expanded state persists in localStorage via an external store so the
// component stays lint-clean (no setState-in-effect) and hydration-safe.
const foldListeners = new Set<() => void>()
function foldGet(): boolean {
  try {
    return localStorage.getItem('tt:consoleOpen') === '1'
  } catch {
    return false
  }
}
function foldSet(v: boolean): void {
  try {
    localStorage.setItem('tt:consoleOpen', v ? '1' : '0')
  } catch { /* private mode */ }
  foldListeners.forEach((l) => l())
}
function foldSubscribe(fn: () => void): () => void {
  foldListeners.add(fn)
  return () => foldListeners.delete(fn)
}

const LEVEL_CLS: Record<LogEntry['level'], string> = {
  info: 'text-zinc-400',
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-rose-400',
}

const LEVEL_TAG: Record<LogEntry['level'], string> = {
  info: 'info',
  ok: ' ok  ',
  warn: 'warn ',
  error: 'ERROR',
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function ConsoleDrawer() {
  const open = useSyncExternalStore(foldSubscribe, foldGet, () => false)
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) =>
    foldSet(typeof v === 'function' ? v(foldGet()) : v)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  useEffect(() => subscribeLogs((entries) => setLogs(entries)), [])

  // autoscroll while the user is at the bottom
  useEffect(() => {
    if (open && stickBottom.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [logs, open])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const last = logs[logs.length - 1]

  return (
    <div className="shrink-0 border-t border-zinc-800/80 bg-zinc-950">
      {/* collapsed bar */}
      <div className="flex h-7 items-center gap-2 px-2">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Fold console' : 'Unfold console'}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
        >
          <Terminal className="h-3.5 w-3.5" />
          Console
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
        </button>
        <span className="rounded border border-zinc-800 px-1 text-[10px] tabular-nums text-zinc-500">
          {logs.length}
        </span>
        {!open && last && (
          <span className={cn('min-w-0 flex-1 truncate font-mono text-[10px]', LEVEL_CLS[last.level])}>
            <span className="text-zinc-600">[{last.source}]</span> {last.message}
          </span>
        )}
        {open && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-5 gap-1 px-1.5 text-[10px] text-zinc-500 hover:text-zinc-200"
            onClick={() => clearLogs()}
            aria-label="Clear console"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </Button>
        )}
      </div>

      {/* expanded log */}
      {open && (
        <div
          ref={listRef}
          onScroll={onScroll}
          className="h-52 overflow-y-auto border-t border-zinc-800/60 bg-zinc-950 px-2 py-1 font-mono text-[10.5px] leading-[1.55] terminal-scroll"
          role="log"
          aria-label="Terminal console"
        >
          {logs.length === 0 && (
            <p className="py-6 text-center text-zinc-600">
              Console — events (alerts, fills, feed status, layout saves) appear here.
            </p>
          )}
          {logs.map((e) => (
            <div key={e.id} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 text-zinc-600">{fmtTime(e.ts)}</span>
              <span className={cn('shrink-0', LEVEL_CLS[e.level])}>{LEVEL_TAG[e.level]}</span>
              <span className="shrink-0 text-zinc-500">[{e.source}]</span>
              <span className={cn('min-w-0', e.level === 'error' || e.level === 'warn' ? LEVEL_CLS[e.level] : 'text-zinc-300')}>
                {e.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
