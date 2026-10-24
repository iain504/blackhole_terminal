'use client'

// ServerDownBanner (Task 9-p) — the browser-side half of the self-healing
// story. When the Next dev server dies (e.g. OOM during a heavy backtest),
// an ALREADY-OPEN terminal page keeps running in the browser: the stream
// socket may even stay connected (the sidecar is an independent process),
// but every /api/* fetch fails. This banner detects that state and offers a
// one-click restart THROUGH the stream-service sidecar
// (/ops/restart-next?XTransformPort=3030).
//
// Detection: unconditional /api/health polling (every 10s; the endpoint has
// a server-side 5s cache and is built for probes). Two consecutive failures
// = the server is down; a single failure is a network blip. While visible,
// health is polled every 3s — if the auto-watchdog revives the server first,
// the banner disappears and the page reloads itself.

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

const SIDE_CAR_Q = '?XTransformPort=3030'

type Phase = 'idle' | 'down' | 'restarting' | 'sidecar-down'

async function probeOk(url: string, timeoutMs: number, init?: RequestInit): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const res = await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' })
    clearTimeout(t)
    return res.status < 500 // 4xx still means the PROCESS is alive
  } catch {
    return false
  }
}

export function ServerDownBanner() {
  const [phase, setPhase] = useState<Phase>('idle')
  const busyRef = useRef(false)

  useEffect(() => {
    let alive = true
    let failStreak = 0

    const tick = async () => {
      if (!alive || busyRef.current) return
      // NOTE: do NOT skip probing when the stream looks connected — the
      // sidecar is a separate process and stays Live while Next is dead.
      const ok = await probeOk('/api/health', 4000)
      if (!alive) return
      if (ok) {
        failStreak = 0
        setPhase((p) => (p === 'idle' ? p : 'idle'))
        return
      }
      failStreak += 1
      if (failStreak < 2) return // one failure = a blip; two = likely dead
      // is the sidecar itself reachable? (if not, only a redeploy helps)
      const sidecar = await probeOk(`/ops/status${SIDE_CAR_Q}`, 4000)
      if (!alive) return
      setPhase((p) => (p === 'restarting' ? p : sidecar ? 'down' : 'sidecar-down'))
    }

    const timer = setInterval(tick, 10000)
    const initial = setTimeout(tick, 3000)
    return () => {
      alive = false
      clearInterval(timer)
      clearTimeout(initial)
    }
  }, [])

  const restart = async () => {
    busyRef.current = true
    setPhase('restarting')
    try {
      await fetch(`/ops/restart-next${SIDE_CAR_Q}`, { method: 'POST', cache: 'no-store' })
    } catch { /* the poll loop below keeps checking regardless */ }
    const started = Date.now()
    const poll = setInterval(async () => {
      const ok = await probeOk('/api/health', 4000)
      if (ok) {
        clearInterval(poll)
        window.location.reload() // session cookie survives — straight back in
      } else if (Date.now() - started > 180_000) {
        clearInterval(poll)
        busyRef.current = false
        setPhase('down') // let the user try again
      }
    }, 3000)
  }

  if (phase === 'idle') return null

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b border-red-900/60 bg-red-950/70 px-3 py-2 text-sm text-red-100"
    >
      {phase === 'restarting' ? (
        <>
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-red-300 border-t-transparent" aria-hidden />
          <span className="font-medium">Restarting the terminal server… this takes up to ~40s. The page reloads itself when it&apos;s back.</span>
        </>
      ) : phase === 'sidecar-down' ? (
        <span className="font-medium">
          The terminal server AND the rescue sidecar are unreachable — the auto-watchdog may still revive them. If this persists, a full redeploy (Publish) is required.
        </span>
      ) : (
        <>
          <span className="font-medium">The terminal server is not responding (it likely died during a heavy backtest).</span>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 px-3"
            onClick={restart}
            title="Restarts the server through the always-on streaming sidecar"
          >
            Restart server
          </Button>
          <span className="text-xs text-red-300/80">or open <code className="rounded bg-red-900/50 px-1">/?XTransformPort=3030</code> in a new tab for the rescue page. Your data is safe on disk.</span>
        </>
      )}
    </div>
  )
}
