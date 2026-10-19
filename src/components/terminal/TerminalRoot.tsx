'use client'

// Terminal root: auth gate, tab bar, 5s layout autosave, alert engine polling.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal, SessionUser } from '@/store/terminal'
import AuthForms from '@/components/auth/AuthForms'
import SettingsDialog from '@/components/settings/SettingsDialog'
import { TabBar } from './TabBar'
import { ChartWorkspace } from './ChartWorkspace'
import CalendarTab from './tabs/CalendarTab'
import HeatmapTab from './tabs/HeatmapTab'
import PositionsTab from './tabs/PositionsTab'
import { useToast } from '@/hooks/use-toast'
import { BellRing, Clock, Home, Loader2, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { fmtPrice } from '@/lib/market-types'
import { ttLog } from '@/lib/console-log'
import { ConsoleDrawer } from './ConsoleDrawer'

export function TerminalRoot({ onExit }: { onExit?: () => void }) {
  const user = useTerminal((s) => s.user)
  const hydrated = useTerminal((s) => s.hydrated)
  const setUser = useTerminal((s) => s.setUser)
  const setHydrated = useTerminal((s) => s.setHydrated)
  const { toast } = useToast()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const meFetched = useRef(false)

  const loadUserData = useCallback(async (u: SessionUser) => {
    const store = useTerminal.getState()
    try {
      const res = await fetch('/api/layout')
      if (res.ok) {
        const json = await res.json()
        if (json.data) store.hydrateFromServer(json.data)
      }
    } catch { /* offline */ }
    if (!useTerminal.getState().activeTabId) {
      useTerminal.setState({ activeTabId: useTerminal.getState().tabs[0].id })
    }
    await Promise.all([store.loadWatchlists(), store.loadAlerts()])
  }, [])

  // Session check on mount
  useEffect(() => {
    if (meFetched.current) return
    meFetched.current = true
    ;(async () => {
      try {
        const res = await fetch('/api/auth/me')
        const json = await res.json()
        if (json.user) {
          setUser(json.user)
          await loadUserData(json.user)
        }
      } catch { /* offline */ }
      setHydrated(true)
    })()
  }, [setUser, setHydrated, loadUserData])

  // Autosave layout every 5s when dirty (Task 16 #3)
  useEffect(() => {
    if (!user) return
    const timer = setInterval(() => {
      const store = useTerminal.getState()
      if (!store.layoutDirty) return
      const data = store.layoutSnapshot()
      fetch('/api/layout', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      })
        .then((r) => {
          if (r.ok) store.markLayoutClean()
          else ttLog('layout', `Autosave failed (HTTP ${r.status}) — will retry`, 'warn')
        })
        .catch(() => ttLog('layout', 'Autosave failed (network) — will retry', 'warn'))
    }, 5000)
    return () => clearInterval(timer)
  }, [user])

  // Flush unsaved layout on tab close
  useEffect(() => {
    if (!user) return
    const handler = () => {
      const store = useTerminal.getState()
      if (!store.layoutDirty) return
      const data = JSON.stringify({ data: store.layoutSnapshot() })
      navigator.sendBeacon?.('/api/layout', new Blob([data], { type: 'application/json' }))
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [user])

  // Alert engine polling (Task 14 #2 / 16 #6) — every 30s
  useEffect(() => {
    if (!user) return
    let stopped = false
    const check = async () => {
      try {
        const res = await fetch('/api/alerts/check', { method: 'POST' })
        if (!res.ok) return
        const json = await res.json()
        if (!json.triggered?.length) {
          // still refresh list so server-side changes (e.g. multi-tab) appear
          if (!stopped) useTerminal.getState().loadAlerts()
          return
        }
        for (const t of json.triggered) {
          toast({
            title: `🔔 Alert: ${t.symbol}`,
            description: `Price is ${t.direction === 'above' ? 'above' : 'below'} ${t.target} — now ${t.price}`,
          })
          ttLog('alerts', `🔔 ${t.symbol} ${t.direction} ${t.target} — now ${t.price}`, 'warn')
        }
        if (!stopped) useTerminal.getState().loadAlerts()
      } catch { /* offline */ }
    }
    check()
    const timer = setInterval(check, 30000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [user, toast])

  // Order-fill reaction: poll recent fills, fire toast + sound (trade feature)
  useEffect(() => {
    if (!user) return
    let stopped = false
    const KEY = 'tt:lastFillAt'
    if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, new Date().toISOString())
    const beep = () => {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctor()
        const notes = [880, 1174.7, 1568]
        notes.forEach((f, i) => {
          const o = ctx.createOscillator()
          const g = ctx.createGain()
          o.type = 'sine'
          o.frequency.value = f
          const t0 = ctx.currentTime + i * 0.13
          g.gain.setValueAtTime(0.0001, t0)
          g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02)
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24)
          o.connect(g)
          g.connect(ctx.destination)
          o.start(t0)
          o.stop(t0 + 0.26)
        })
        setTimeout(() => void ctx.close().catch(() => {}), 1200)
      } catch { /* audio unavailable */ }
    }
    const tick = async () => {
      const since = localStorage.getItem(KEY) || new Date().toISOString()
      try {
        const res = await fetch(`/api/trading/fills?since=${encodeURIComponent(since)}`)
        if (!res.ok) return
        const json = await res.json()
        // advance the marker even when nothing new (or trading not configured)
        localStorage.setItem(KEY, new Date().toISOString())
        if (json.configured === false) return
        const fills = (json.fills || []) as { id: string; symbol: string; side: string; qty: number; price: number | null; type: string }[]
        if (fills.length > 0 && !stopped) {
          for (const f of fills) {
            toast({
              title: `💼 ${f.side === 'buy' ? 'Bought' : 'Sold'} ${f.qty} ${f.symbol}`,
              description: f.price ? `Filled @ ${f.price} · ${f.type}` : `Filled · ${f.type}`,
            })
            ttLog('trading', `💼 ${f.side === 'buy' ? 'Bought' : 'Sold'} ${f.qty} ${f.symbol}${f.price ? ` @ ${f.price}` : ''} · ${f.type}`, 'ok')
          }
          beep()
          window.dispatchEvent(new CustomEvent('tt:positions-changed'))
        }
      } catch { /* offline */ }
    }
    const timer = setInterval(tick, 12000)
    const t0 = setTimeout(tick, 2500)
    return () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(t0)
    }
  }, [user, toast])

  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        <div className="flex items-center gap-3 text-sm">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading TradeTerminal…
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-zinc-950">
        <AuthForms
          onAuthed={(u) => {
            setUser(u)
            loadUserData(u)
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <TabBar
        onOpenSettings={() => setSettingsOpen(true)}
        alertsOpen={alertsOpen}
        setAlertsOpen={setAlertsOpen}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <ActiveTabContent />
      </main>
      <ConsoleDrawer />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {alertsOpen && <AlertsDrawer onClose={() => setAlertsOpen(false)} />}
      {/* footer stays glued to bottom on short viewports */}
      <footer className="mt-auto flex items-center justify-between border-t border-zinc-800/80 bg-zinc-900/60 px-3 py-1 text-[11px] text-zinc-500">
        <span className="flex min-w-0 items-center">
          {onExit && (
            <button
              onClick={onExit}
              title="Back to landing page"
              aria-label="Back to landing page"
              className="mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="truncate">
            TradeTerminal · data: <span className="text-zinc-400">Alpaca</span>
            {useTerminal.getState().tabs.length > 0 && <BadgeDemoInline />}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <span className="hidden sm:inline">2FA-protected · layout auto-saves every 5s</span>
          <LiveClock />
        </span>
      </footer>
    </div>
  )
}

// Ticking local clock for the footer (updates every second).
// Renders a placeholder until mounted so SSR/CSR markup always matches.
function LiveClock() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const tz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local'
    } catch {
      return 'Local'
    }
  }, [])
  const city = tz.includes('/') ? tz.split('/').pop()!.replace(/_/g, ' ') : tz
  const time = now
    ? now.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--'
  return (
    <span
      className="flex items-center gap-1.5 tabular-nums text-zinc-300"
      title={now ? `${now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })} ${time} · ${tz}` : tz}
    >
      <Clock className="h-3 w-3 text-emerald-500" aria-hidden="true" />
      <span>{time}</span>
      <span className="hidden text-[9px] uppercase tracking-wider text-zinc-600 sm:inline">{city}</span>
    </span>
  )
}

function BadgeDemoInline() {
  const { demo, reason } = useDemoMeta()
  if (!demo) return null
  const rejected = reason === 'alpaca-http-401' || reason === 'alpaca-http-403'
  return (
    <Badge
      variant="outline"
      title={
        rejected
          ? 'Alpaca rejected the saved keys — open Settings and re-check them'
          : 'Demo data — add your Alpaca API keys in Settings'
      }
      className={
        rejected
          ? 'ml-2 border-rose-500/40 text-[10px] text-rose-400'
          : 'ml-2 border-amber-500/40 text-[10px] text-amber-400'
      }
    >
      {rejected ? 'keys rejected — check Settings' : 'demo data — add Alpaca keys in Settings'}
    </Badge>
  )
}

function useDemoMeta(): { demo: boolean; reason?: string } {
  const [meta, setMeta] = useState<{ demo: boolean; reason?: string }>({ demo: false })
  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: ['AAPL'] }),
        })
        if (!res.ok || !alive) return
        const json = await res.json()
        if (alive) setMeta({ demo: Boolean(json.meta?.demo), reason: json.meta?.reason })
      } catch { /* offline */ }
    }
    check()
    // Re-check right after keys are saved/changed and periodically, so the
    // badge never lies after Settings are updated without a page reload.
    window.addEventListener('tt:settings-changed', check)
    const timer = setInterval(check, 60000)
    return () => {
      alive = false
      window.removeEventListener('tt:settings-changed', check)
      clearInterval(timer)
    }
  }, [])
  return meta
}

function ActiveTabContent() {
  const tabs = useTerminal((s) => s.tabs)
  const activeTabId = useTerminal((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId) || tabs[0]
  if (!active) return null
  if (active.type === 'calendar') return <CalendarTab />
  if (active.type === 'heatmap') return <HeatmapTab />
  if (active.type === 'positions') return <PositionsTab />
  return <ChartWorkspace key={active.id} tab={active} />
}

function AlertsDrawer({ onClose }: { onClose: () => void }) {
  const alerts = useTerminal((s) => s.alerts)
  const patchAlertLocal = useTerminal((s) => s.patchAlertLocal)
  const removeAlertLocal = useTerminal((s) => s.removeAlertLocal)

  const toggle = async (id: string, status: string) => {
    const next = status === 'paused' ? 'active' : 'paused'
    patchAlertLocal(id, { status: next })
    await fetch(`/api/alerts/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: next }),
    })
  }
  const remove = async (id: string) => {
    removeAlertLocal(id)
    await fetch(`/api/alerts/${id}`, { method: 'DELETE' })
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Price alerts">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close alerts" />
      <div className="absolute right-3 top-12 w-[340px] max-w-[calc(100vw-24px)] rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5 text-sm font-medium">
          <span className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-400" /> Price alerts
          </span>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-xs">
            Close
          </Button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {alerts.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-zinc-500">
              No alerts yet — right-click the chart to add one.
            </p>
          )}
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-zinc-800/60">
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: a.color }} />
                <span className="font-medium text-zinc-200">{a.symbol}</span>
                <span className="text-zinc-400">
                  {a.direction === 'above' ? '≥' : '≤'} {fmtPrice(a.price)}
                </span>
                <Badge
                  variant="outline"
                  className={
                    a.status === 'triggered'
                      ? 'border-emerald-500/40 text-[10px] text-emerald-400'
                      : a.status === 'paused'
                        ? 'border-zinc-600 text-[10px] text-zinc-400'
                        : 'border-amber-500/40 text-[10px] text-amber-400'
                  }
                >
                  {a.status}
                </Badge>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={() => toggle(a.id, a.status)}>
                  {a.status === 'paused' ? 'Resume' : 'Pause'}
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-rose-400 hover:text-rose-300" onClick={() => remove(a.id)}>
                  ✕
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          Alerts are checked every 30s · Telegram notifications via Settings
          <span className="ml-1 inline-flex items-center align-middle">
            <Settings2 className="h-3 w-3" />
          </span>
        </div>
      </div>
    </div>
  )
}
