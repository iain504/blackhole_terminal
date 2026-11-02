'use client'

// FSD fleet presence for global chrome (desktop footer / mobile bottom nav,
// v2.8.3) — "the running rainbow on the bottom bar". Two update paths:
//   (a) INSTANT — AgentTab broadcasts `tt:fleet-state` on every one of its 3s
//       polls, so the bar reacts the moment the fleet engages/disengages while
//       that tab is open;
//   (b) BACKSTOP — a slow 15s poll of the lightweight /api/agent/fleet-status
//       endpoint keeps the indicator correct on every OTHER tab (and after a
//       reload) without ever fetching the heavy full agent state.
// Starts false so SSR/first paint always matches (no hydration risk).
import { useEffect, useState } from 'react'

export function useFleetPresence(): boolean {
  const [engaged, setEngaged] = useState(false)

  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const res = await fetch('/api/agent/fleet-status', { cache: 'no-store' })
        if (!res.ok) return
        const j = (await res.json()) as { engaged?: boolean }
        if (alive) setEngaged(Boolean(j.engaged))
      } catch {
        /* the chrome indicator is advisory — ignore transient failures */
      }
    }
    const onFleetState = (e: Event) => {
      const d = (e as CustomEvent<{ engaged?: boolean }>).detail
      if (d && typeof d.engaged === 'boolean') setEngaged(d.engaged)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pull()
    }
    void pull()
    const t = setInterval(() => void pull(), 15_000)
    window.addEventListener('tt:fleet-state', onFleetState)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('tt:fleet-state', onFleetState)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return engaged
}
