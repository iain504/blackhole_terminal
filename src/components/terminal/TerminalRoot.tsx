'use client'

// Terminal root: auth gate, tab bar, 5s layout autosave, alert engine polling.
// v2.11.3 — the 8 non-chart tabs are code-split via next/dynamic: only the
// chart workspace + shell ship in the initial bundle (before this, ALL tab
// code — recharts via ReportTab, the 1.5k-line PositionsTab, etc. — loaded
// up front even for a user who never opens them). ChartWorkspace stays
// static: it IS the default view, a skeleton flash there would hurt UX.
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal, SessionUser, Alert } from '@/store/terminal'
import { resumeAiAutoIfNeeded } from '@/store/ai-auto-trade'
import { resumeAiStewardIfNeeded } from '@/store/ai-steward'
import { startAiOpsSync, stopAiOpsSync } from '@/lib/ai-ops-sync'
import AuthForms from '@/components/auth/AuthForms'
import SettingsDialog from '@/components/settings/SettingsDialog'
import { TabBar } from './TabBar'
import { ChartWorkspace } from './ChartWorkspace'
import { MobileShell } from './mobile/MobileShell'
import { SessionSplash } from './SessionSplash'
import { useIsMobile } from '@/hooks/use-mobile'
import { TaijiSpinner, TaoistBootLoader } from '@/components/theme/TaoistLoader'

// v2.12.16 — tab code-split fallback: an ink 太極 instead of the lucide whirr.
const TabFallback = () => (
  <div className="flex h-[60vh] items-center justify-center text-zinc-500" role="status" aria-live="polite">
    <TaijiSpinner className="h-5 w-5" aria-hidden />
    <span className="sr-only">Loading tab…</span>
  </div>
)

const CalendarTab = dynamic(() => import('./tabs/CalendarTab'), { ssr: false, loading: TabFallback })
const HeatmapTab = dynamic(() => import('./tabs/HeatmapTab'), { ssr: false, loading: TabFallback })
const PositionsTab = dynamic(() => import('./tabs/PositionsTab'), { ssr: false, loading: TabFallback })
const StrategyTab = dynamic(() => import('./tabs/StrategyTab'), { ssr: false, loading: TabFallback })
const ReportTab = dynamic(() => import('./tabs/ReportTab'), { ssr: false, loading: TabFallback })
const AlgoTab = dynamic(() => import('./tabs/AlgoTab'), { ssr: false, loading: TabFallback })
const GridTab = dynamic(() => import('./tabs/GridTab'), { ssr: false, loading: TabFallback })
const AgentTab = dynamic(() => import('./tabs/AgentTab'), { ssr: false, loading: TabFallback })
const AiTradeTab = dynamic(() => import('./tabs/AiTradeTab'), { ssr: false, loading: TabFallback })
import { StrategyDrawer } from './StrategyDrawer'
import { ServerDownBanner } from './ServerDownBanner'
import { useToast } from '@/hooks/use-toast'
import { BellRing, Clock, Home, Keyboard, Settings2 } from 'lucide-react'
import { useFleetPresence } from '@/hooks/use-fleet-presence'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { fmtPrice } from '@/lib/market-types'
import { ttLog } from '@/lib/console-log'
import { onConnectChange, type StreamStatus } from '@/lib/stream-client'
import { applyUiTheme, fetchServerUiTheme, getUiTheme, useUiTheme } from '@/lib/ui-theme'
import { useDeviceHeartbeat } from '@/lib/device'
import { installUnauthorizedWatcher, setUnauthorizedHandler } from '@/lib/client-auth'
import { cn } from '@/lib/utils'
import { ConsoleDrawer } from './ConsoleDrawer'
import { APP_VERSION } from '@/generated/version'

// ---- layout autosave conflict tracking (Task 4-c) -------------------------
// The server (once baseUpdatedAt checking lands) answers a concurrent save
// with 409 + the latest stored layout in the body. We remember the last
// updatedAt the server told us about (load/save responses and the 409 body)
// and send it with every save. Opaque value — ISO string or epoch — whatever
// the route returns; nothing changes while the server omits it.
let layoutBaseUpdatedAt: string | number | null = null
let lastConflictToastAt = 0 // one conflict toast per episode, not per retry

export function TerminalRoot({ onExit }: { onExit?: () => void }) {
  const user = useTerminal((s) => s.user)
  const hydrated = useTerminal((s) => s.hydrated)
  const setUser = useTerminal((s) => s.setUser)
  const setHydrated = useTerminal((s) => s.setHydrated)
  const isMobile = useIsMobile()
  const { toast } = useToast()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [strategiesOpen, setStrategiesOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const meFetched = useRef(false)
  // Task 28 — small festive flourish in the terminal footer while Christmas is on
  const footerChristmas = useUiTheme() === 'christmas'
  // v2.9.3 — device awareness: this browser registers under the account and
  // keeps /api/devices posted with the live tab state (no-op while logged out).
  useDeviceHeartbeat()

  const loadUserData = useCallback(async (u: SessionUser) => {
    const store = useTerminal.getState()
    try {
      const res = await fetch('/api/layout')
      if (res.ok) {
        const json = await res.json()
        if (json.data) store.hydrateFromServer(json.data)
        // Task 4-c: remember the server's layout timestamp so the autosave can
        // send baseUpdatedAt (conflict detection across tabs). The route does
        // not return updatedAt yet — this stays null until it does.
        if (json.updatedAt != null) layoutBaseUpdatedAt = json.updatedAt
      }
    } catch { /* offline */ }
    if (!useTerminal.getState().activeTabId) {
      useTerminal.setState({ activeTabId: useTerminal.getState().tabs[0].id })
    }
    await Promise.all([store.loadWatchlists(), store.loadAlerts(), store.loadStrategies()])
  }, [])

  // v2.7.5 — deep link from tabs: AgentTab's broker banner (and future
  // surfaces) can pop the settings dialog without prop drilling through the
  // tab shell. Lightweight DOM event — dialog state stays local here.
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener('tt:open-settings', open)
    return () => window.removeEventListener('tt:open-settings', open)
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
          // Task 28 — the account's saved theme wins once we know who this is
          // (localStorage keeps the landing page instant pre-login). Absent
          // server preference leaves the local choice untouched.
          const serverTheme = await fetchServerUiTheme()
          if (serverTheme && serverTheme !== getUiTheme()) {
            applyUiTheme(serverTheme)
          }
          await loadUserData(json.user)
        }
      } catch { /* offline */ }
      setHydrated(true)
    })()
  }, [setUser, setHydrated, loadUserData])

  // v2.12.18 — AI 自動交易：若上次啟用過掃描器，登入後自動恢復週期掃描
  // （module-scope engine，切走 AI Trade 分頁也不停；冪等，重複呼叫無副作用）。
  // v2.12.22 — AI 護倉同樣冪等恢復巡檢。
  // v2.12.24 — 跨裝置同步：resume 只作 localStorage 後備；隨後啟動
  // ai-ops 同步迴圈（20s heartbeat），以帳號級 AiOpsState 為準 — 每台登入
  // 的電腦都看到同一開關，且只有當選 runner 的那台真正執行引擎。登出停止迴圈。
  useEffect(() => {
    if (!user) {
      stopAiOpsSync()
      return
    }
    resumeAiAutoIfNeeded()
    resumeAiStewardIfNeeded()
    startAiOpsSync()
  }, [user])

  // v2.7.3 — global 401 watcher: if the server-side session dies under an
  // OPEN terminal (platform DB wipe / secret rotation on restart / expiry),
  // flip back to the login screen with a toast instead of leaving a ghost tab
  // where every action (LAUNCH FULL SCAN included) just toasts "Unauthorized".
  // v2.12.2 — the toast + console name the ENDPOINT that 401'd (hosted
  // deployments were undiagnosable: "logged out after 2 seconds" with no clue
  // which request killed the session).
  useEffect(() => {
    installUnauthorizedWatcher()
    setUnauthorizedHandler((url) => {
      console.error('[tt] session-expired: 401 from', url)
      if (!useTerminal.getState().user) return // auth screen already shown
      setUser(null)
      toast({
        title: 'Session expired',
        description: `Server rejected the session (401 from ${url.replace(location.origin, '')}) — sign in again.`,
        variant: 'destructive',
      })
    })
    return () => setUnauthorizedHandler(undefined)
  }, [setUser, toast])

  // Autosave layout every 5s when dirty (Task 16 #3); Task 4-c adds
  // baseUpdatedAt + 409 convergence when another tab saved first.
  useEffect(() => {
    if (!user) return
    const timer = setInterval(() => {
      const store = useTerminal.getState()
      if (!store.layoutDirty) return
      const data = store.layoutSnapshot()
      fetch('/api/layout', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data, baseUpdatedAt: layoutBaseUpdatedAt }),
      })
        .then(async (r) => {
          if (r.ok) {
            store.markLayoutClean()
            // the route may report the new updatedAt once conflict checking lands
            try {
              const j = await r.json()
              if (j && j.updatedAt != null) layoutBaseUpdatedAt = j.updatedAt
            } catch { /* body optional */ }
            return
          }
          if (r.status === 409) {
            // Another tab saved first. Adopt the server's newer layout (the
            // store's hydrateFromServer sanitizes + clears layoutDirty), then
            // rearm baseUpdatedAt so subsequent saves succeed.
            const json = (await r.json().catch(() => null)) as { server?: { updatedAt?: string | number; data?: unknown } } | null
            const server = json?.server
            const adopt = useTerminal.getState()
            if (server && server.data != null) {
              adopt.hydrateFromServer(server.data)
              if (server.updatedAt != null) layoutBaseUpdatedAt = server.updatedAt
              adopt.markLayoutClean()
            } else {
              // defensive: a 409 without a payload — pull the latest explicitly
              try {
                const g = await fetch('/api/layout')
                if (g.ok) {
                  const gj = await g.json()
                  if (gj.data) useTerminal.getState().hydrateFromServer(gj.data)
                  if (gj.updatedAt != null) layoutBaseUpdatedAt = gj.updatedAt
                  useTerminal.getState().markLayoutClean()
                }
              } catch { /* offline — stay dirty, next tick retries */ }
            }
            ttLog('layout', 'Layout conflict (409) — adopted the latest server layout', 'warn')
            const now = Date.now()
            if (now - lastConflictToastAt > 15000) {
              lastConflictToastAt = now
              toast({ title: 'Layout changed in another tab — loaded the latest' })
            }
            return
          }
          ttLog('layout', `Autosave failed (HTTP ${r.status}) — will retry`, 'warn')
        })
        .catch(() => ttLog('layout', 'Autosave failed (network) — will retry', 'warn'))
    }, 5000)
    return () => clearInterval(timer)
  }, [user, toast])

  // Flush unsaved layout on tab close
  useEffect(() => {
    if (!user) return
    const handler = () => {
      const store = useTerminal.getState()
      if (!store.layoutDirty) return
      const data = JSON.stringify({ data: store.layoutSnapshot(), baseUpdatedAt: layoutBaseUpdatedAt })
      navigator.sendBeacon?.('/api/layout', new Blob([data], { type: 'application/json' }))
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [user])

  // Extended trading hours toggle — TradingView's Alt+Shift+E shortcut
  // (Task 59). Registered ONCE at the terminal root: N chart panes would
  // otherwise each flip the shared store and cancel each other out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || (e.key !== 'E' && e.key !== 'e')) return
      if (e.target instanceof Element && (e.target.closest('input, textarea, select, [contenteditable]'))) return
      e.preventDefault()
      const st = useTerminal.getState()
      st.setShowExtendedHours(!st.showExtendedHours)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keyboard shortcuts cheatsheet (Task 4-c): "?" (shift+/) opens it whenever
  // no input/textarea/select/contentEditable is focused; the header's Keyboard
  // icon button opens it via the tt:open-shortcuts event. Esc/overlay click
  // close for free with the Dialog primitive (focus trap included).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      e.preventDefault()
      setShortcutsOpen(true)
    }
    const open = () => setShortcutsOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('tt:open-shortcuts', open)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('tt:open-shortcuts', open)
    }
  }, [])

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
            description: t.message || `Price is ${t.direction === 'above' ? 'above' : 'below'} ${t.target} — now ${t.price}`,
          })
          ttLog('alerts', `🔔 ${t.symbol} ${t.message || `${t.direction} ${t.target} — now ${t.price}`}`, 'warn')
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

  // Strategy-bot polling (Task 44) — every 20s; server also self-evaluates
  useEffect(() => {
    if (!user) return
    // the Strategy Orders tab (and empty state) can request the drawer
    const open = () => setStrategiesOpen(true)
    window.addEventListener('tt:open-strategies', open)
    return () => window.removeEventListener('tt:open-strategies', open)
  }, [user])

  // Grid Trading (Task 9-q) — the chart's Grid tool opens the config dialog
  // and a successful start dispatches tt:open-grid: focus the Grid tab if it
  // already exists, otherwise add one.
  useEffect(() => {
    if (!user) return
    const open = () => {
      const s = useTerminal.getState()
      const existing = s.tabs.find((t) => t.type === 'grid')
      if (existing) s.setActiveTab(existing.id)
      else s.addTab('grid')
    }
    window.addEventListener('tt:open-grid', open)
    return () => window.removeEventListener('tt:open-grid', open)
  }, [user])

  useEffect(() => {
    if (!user) return
    let stopped = false
    const check = async () => {
      try {
        const res = await fetch('/api/strategies/check', { method: 'POST' })
        if (!res.ok) return
        const json = await res.json()
        const fired = (json.fired || []) as { id: string; symbol: string; action: string; ok: boolean; message: string; mode?: string }[]
        if (fired.length > 0 && !stopped) {
          for (const f of fired) {
            toast({
              // Task 94 — live fires must be unmistakable in toasts too
              title: f.ok
                ? `🤖 Strategy fired: ${f.symbol}${f.mode === 'live' ? ' ⚠️ LIVE' : ''}`
                : `🤖 Strategy FAILED: ${f.symbol}${f.mode === 'live' ? ' ⚠️ LIVE' : ''}`,
              description: f.message,
              variant: f.ok ? undefined : 'destructive',
            })
            ttLog('strategy', `🤖 ${f.symbol} ${f.message}`, f.ok ? 'ok' : 'warn')
          }
          window.dispatchEvent(new CustomEvent('tt:positions-changed'))
        }
        // always refresh — rules also change server-side (failures, supervisor fires)
        if (!stopped) useTerminal.getState().loadStrategies()
      } catch { /* offline */ }
    }
    check()
    const timer = setInterval(check, 20000)
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

  // v2.12.16 — the boot 畫面 is now a Taoist loading scene: the 八卦 wheel
  // around a turning 太極, a 道德經 line in the brush face, the whole frame
  // inked in (lp-ink-in) over the faint mountain painting (bg /85 lets the
  // InkBackdrop through — the splash is no longer an opaque wall).
  if (!hydrated) {
    return (
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-8 bg-zinc-950/85 px-6 text-center">
        <div className="lp-ink-in flex flex-col items-center gap-7">
          <TaoistBootLoader className="h-28 w-28 text-zinc-300 sm:h-32 sm:w-32" />
          <div className="flex items-center gap-3">
            <p className="lp-brush text-[1.7rem] leading-snug tracking-[0.12em] text-zinc-100 sm:text-3xl">
              執古之道，以御今之有
            </p>
            <span className="lp-seal h-6 w-6 shrink-0 text-[11px]" aria-hidden>
              道
            </span>
          </div>
          <p className="text-[11px] tracking-[0.42em] text-zinc-500">道德經 ‧ 十四章</p>
          <p className="flex items-center gap-1.5 text-xs tracking-[0.32em] text-zinc-500">
            終端啟動中
            <span className="tt-dot" aria-hidden>·</span>
            <span className="tt-dot" style={{ animationDelay: '200ms' }} aria-hidden>·</span>
            <span className="tt-dot" style={{ animationDelay: '400ms' }} aria-hidden>·</span>
          </p>
        </div>
        <span className="sr-only">Loading TradeTerminal…</span>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="relative z-10 min-h-screen bg-zinc-950/70">
        <AuthForms
          onAuthed={(u) => {
            setUser(u)
            loadUserData(u)
          }}
        />
      </div>
    )
  }

  // MOBILE (Task 56): below 768px the terminal renders the TradingView-app-
  // style shell — full-screen views (watchlist / chart / trades / report /
  // menu) driven by a fixed bottom tab bar. Same store, same autosave; the
  // dialogs stay mounted here so menu rows can open them.
  if (isMobile) {
    return (
      <>
        <MobileShell
          onExit={onExit}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAlerts={() => setAlertsOpen((v) => !v)}
          onOpenStrategies={() => setStrategiesOpen((v) => !v)}
        />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        {alertsOpen && <AlertsDrawer onClose={() => setAlertsOpen(false)} />}
        {strategiesOpen && <StrategyDrawer onClose={() => setStrategiesOpen(false)} />}
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        {/* regular-session open/close splash (v1.87.0) — above every dialog */}
        <SessionSplash />
      </>
    )
  }

  return (
    <div className="relative z-10 flex h-screen flex-col overflow-hidden bg-zinc-950/95 text-zinc-200">
      <TabBar
        onOpenSettings={() => setSettingsOpen(true)}
        alertsOpen={alertsOpen}
        setAlertsOpen={setAlertsOpen}
        strategiesOpen={strategiesOpen}
        setStrategiesOpen={setStrategiesOpen}
      />
      <ServerDownBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        <ActiveTabContent />
      </main>
      <ConsoleDrawer />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {alertsOpen && <AlertsDrawer onClose={() => setAlertsOpen(false)} />}
      {strategiesOpen && <StrategyDrawer onClose={() => setStrategiesOpen(false)} />}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {/* regular-session open/close splash (v1.87.0) — above every dialog */}
      <SessionSplash />
      {/* footer stays glued to bottom on short viewports */}
      <footer className="relative mt-auto flex items-center justify-between border-t border-zinc-800/80 bg-zinc-900/60 px-3 py-1 text-[11px] text-zinc-500">
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
            <StreamStatusChip />
          </span>
        </span>
        <span className="flex items-center gap-3">
          {/* v2.8.3 — running rainbow + FSD chip while the fleet is ENGAGED:
              visible from every tab, click opens the autopilot tab */}
          <FleetRunChip />
          <span className="hidden sm:inline">2FA-protected · layout auto-saves every 5s</span>
          {footerChristmas && <span title="Christmas theme" aria-hidden>🎄</span>}
          <AppVersion />
          <LiveClock />
        </span>
      </footer>
    </div>
  )
}

// v2.8.3 — bottom-bar FSD notification. While the fleet is ENGAGED the footer
// grows a running-rainbow strip along its top edge and a pulsing "● FSD" chip;
// clicking the chip jumps to the autopilot tab (adds one if none exists).
// The rainbow is visible from EVERY tab — the user should never have to wonder
// whether the autopilot is still trading. Powered by useFleetPresence
// (instant tt:fleet-state broadcasts from AgentTab + a 15s lightweight poll).
function FleetRunChip() {
  const engaged = useFleetPresence()
  const tabs = useTerminal((s) => s.tabs)
  const setActiveTab = useTerminal((s) => s.setActiveTab)
  const addTab = useTerminal((s) => s.addTab)
  if (!engaged) return null
  const agentTab = tabs.find((t) => t.type === 'agent')
  return (
    <>
      <div className="fsd-rainbow-strip absolute inset-x-0 top-0 h-[3px]" aria-hidden="true" />
      <button
        onClick={() => (agentTab ? setActiveTab(agentTab.id) : addTab('agent'))}
        title="FSD fleet is trading — open the 智慧體 tab"
        aria-label="FSD fleet running — open the autopilot tab"
        className="fsd-live-chip"
      >
        <span className="fsd-live-dot" aria-hidden="true" />
        <span className="fsd-live-chip-text font-mono text-[9px] tracking-widest">FSD</span>
      </button>
    </>
  )
}

// Build version (stamped by scripts/stamp-version.mjs on every dev/build):
// display "v1.79.0+69" — base semver + git commit count; hover shows the
// full version (sha, branch, commit date). Static build-time constant, so
// SSR/CSR markup always matches (no hydration risk, no ticking).
function AppVersion() {
  return (
    <span
      className="font-mono text-[10px] tabular-nums text-zinc-600"
      title={`TradeTerminal ${APP_VERSION.full} · branch ${APP_VERSION.branch} · commit ${APP_VERSION.commitDate}`}
      aria-label={`App version ${APP_VERSION.full}`}
    >
      {APP_VERSION.display}
    </span>
  )
}

// (v1.95.0 — the footer market-status chip was REMOVED per user request:
// "move back the market status back to the chart align with the symbol" — the
// indicator lives in every chart pane's header again, see ChartPanel.)

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

// Task 4-c: live/reconnecting indicator for the price stream — purely visual,
// persists nothing. Emerald "Live" = socket.io connected; amber "Reconnecting…"
// = socket down and auto-retrying (1s→15s backoff); gray "Polling" = the stream
// never opened (no subscription yet) and REST polling is the fallback. The
// aria-live region (with sr-only text) announces status changes to screen
// readers without shouting (polite).
function StreamStatusChip() {
  const [status, setStatus] = useState<StreamStatus>('idle')
  useEffect(() => onConnectChange(setStatus), [])
  const meta =
    status === 'connected'
      ? { dot: 'bg-emerald-400', text: 'Live', sr: 'Price stream connected — real-time ticks' }
      : status === 'reconnecting'
        ? { dot: 'bg-amber-400 animate-pulse', text: 'Reconnecting…', sr: 'Price stream reconnecting — REST polling fallback' }
        : { dot: 'bg-zinc-500', text: 'Polling', sr: 'Price stream not in use — REST polling' }
  return (
    <span className="ml-2 inline-flex items-center gap-1.5 align-middle" title={meta.sr} aria-live="polite">
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} aria-hidden="true" />
      <span>{meta.text}</span>
      <span className="sr-only">{meta.sr}</span>
    </span>
  )
}

// Task 4-c: keyboard shortcuts cheatsheet. Honest list — only shortcuts that
// actually exist in the terminal today (grepped keydown/contextmenu handlers).
const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Alt + Shift + E', action: 'Toggle extended-hours (pre/post-market) data on all charts' },
  { keys: 'Right-click on a chart', action: 'Context menu — trade here, set an alarm, clone/delete a drawing, edit exits' },
  { keys: 'Long-press ~0.5s (touch)', action: 'Same chart context menu on phones and tablets' },
  { keys: 'Esc', action: 'Cancel an in-progress drawing drag, reset the drawing tool, close dialogs' },
  { keys: '↑ / ↓ on a splitter', action: 'Nudge the Positions panel splitters (keyboard resize)' },
  { keys: '?', action: 'Open this shortcuts dialog' },
]

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-zinc-800 bg-zinc-900 text-zinc-200">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Keyboard className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            Shortcuts are ignored while you are typing in an input.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2.5 pb-1">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="flex items-start justify-between gap-3">
              <span className="min-w-0 text-xs leading-snug text-zinc-300">{s.action}</span>
              <kbd className="shrink-0 whitespace-nowrap rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <p className="text-[10px] leading-snug text-zinc-600">
          Tabs drag to reorder · panels and splitters drag to resize · everything else lives in the menus.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function ActiveTabContent() {
  const tabs = useTerminal((s) => s.tabs)
  const activeTabId = useTerminal((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId) || tabs[0]
  if (!active) return null
  if (active.type === 'calendar') return <CalendarTab />
  if (active.type === 'heatmap') return <HeatmapTab />
  if (active.type === 'positions') return <PositionsTab />
  if (active.type === 'strategy') return <StrategyTab />
  if (active.type === 'report') return <ReportTab />
  if (active.type === 'algo') return <AlgoTab />
  if (active.type === 'grid') return <GridTab />
  if (active.type === 'agent') return <AgentTab key={active.id} />
  if (active.type === 'aitrade') return <AiTradeTab key={active.id} />
  return <ChartWorkspace key={active.id} tab={active} />
}

const ALERT_TFS = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'] as const
const TF_LABEL: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1D': '1D', '1W': '1W', '1M': '1M' }

/** One-line human summary of an alarm (any kind) for the list. */
function alertSummary(a: Alert): string {
  if (a.kind === 'rsi') {
    return `RSI(${a.params?.period ?? 14}) crosses ${a.direction === 'above' ? 'above' : 'below'} ${a.price} · ${TF_LABEL[a.timeframe] ?? a.timeframe}`
  }
  if (a.kind === 'macd') {
    const p = a.params ?? {}
    const base = `MACD(${p.fast ?? 12},${p.slow ?? 26},${p.signal ?? 9})`
    const cond =
      a.condition === 'bull_cross' ? 'bullish crossover'
      : a.condition === 'bear_cross' ? 'bearish crossover'
      : a.condition === 'cross_above' ? `crosses above ${a.price}`
      : a.condition === 'cross_below' ? `crosses below ${a.price}`
      : 'crossover'
    return `${base} ${cond} · ${TF_LABEL[a.timeframe] ?? a.timeframe}`
  }
  if (a.kind === 'trend') {
    // the level MOVES with the bound trend line — show the crossing direction
    // plus the level the line had when the alarm was created
    return `Trend line · crosses ${a.direction === 'above' ? 'up' : 'down'} · level was ${fmtPrice(a.price)}`
  }
  return `${a.direction === 'above' ? '≥' : '≤'} ${fmtPrice(a.price)}`
}

function AlertsDrawer({ onClose }: { onClose: () => void }) {
  const alerts = useTerminal((s) => s.alerts)
  const addAlertLocal = useTerminal((s) => s.addAlertLocal)
  const patchAlertLocal = useTerminal((s) => s.patchAlertLocal)
  const removeAlertLocal = useTerminal((s) => s.removeAlertLocal)
  const activeTab = useTerminal((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0])

  // ---- creation form state ----
  const [kind, setKind] = useState<'price' | 'rsi' | 'macd'>('rsi')
  const [symbol, setSymbol] = useState('')
  const [tf, setTf] = useState('1D')
  // price alarm fields
  const [price, setPrice] = useState('')
  const [dir, setDir] = useState<'above' | 'below'>('above')
  // rsi fields
  const [rsiPeriod, setRsiPeriod] = useState('14')
  const [rsiLevel, setRsiLevel] = useState('70')
  // macd fields
  const [fast, setFast] = useState('12')
  const [slow, setSlow] = useState('26')
  const [signal, setSignal] = useState('9')
  const [cond, setCond] = useState<'bull_cross' | 'bear_cross' | 'cross_above' | 'cross_below'>('bull_cross')
  const [macdLevel, setMacdLevel] = useState('0')
  const [creating, setCreating] = useState(false)
  const symTouched = useRef(false)

  // prefill symbol/timeframe from the active chart tab (once)
  useEffect(() => {
    if (symTouched.current) return
    if (activeTab?.symbol) {
      setSymbol(activeTab.symbol)
      if (activeTab.timeframe) setTf(activeTab.timeframe)
    }
  }, [activeTab?.symbol, activeTab?.timeframe])

  // RSI level default flips with the direction (70 overbought / 30 oversold)
  const flipRsiLevel = (d: 'above' | 'below') => {
    setDir(d)
    if (!symTouched.current || rsiLevel === '70' || rsiLevel === '30') setRsiLevel(d === 'above' ? '70' : '30')
  }

  const create = async () => {
    const sym = symbol.trim().toUpperCase()
    if (!sym) return
    setCreating(true)
    try {
      const body: Record<string, unknown> =
        kind === 'price'
          ? {
              symbol: sym, kind, price: parseFloat(price),
              direction: dir, color: '#f59e0b',
            }
          : kind === 'rsi'
            ? {
                symbol: sym, kind, price: parseFloat(rsiLevel),
                direction: dir, timeframe: tf,
                params: { period: parseInt(rsiPeriod, 10) }, color: '#f472b6',
              }
            : {
                symbol: sym, kind, condition: cond, timeframe: tf,
                price: parseFloat(macdLevel) || 0,
                params: { fast: parseInt(fast, 10), slow: parseInt(slow, 10), signal: parseInt(signal, 10) },
                color: '#f59e0b',
              }
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.alert) {
        addAlertLocal(json.alert as Alert)
      } else {
        ttLog('alerts', `Create alarm failed: ${json?.error || res.status}`, 'warn')
      }
    } catch { /* offline */ } finally {
      setCreating(false)
    }
  }

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

  const formValid =
    kind === 'price'
      ? Number.isFinite(parseFloat(price)) && parseFloat(price) > 0 && symbol.trim().length > 0
      : kind === 'rsi'
        ? Number.isFinite(parseFloat(rsiLevel)) && parseFloat(rsiLevel) > 0 && symbol.trim().length > 0
        : cond === 'cross_above' || cond === 'cross_below'
          ? Number.isFinite(parseFloat(macdLevel)) && symbol.trim().length > 0
          : symbol.trim().length > 0

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Alerts">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close alerts" />
      <div className="absolute right-3 top-12 w-[340px] max-w-[calc(100vw-24px)] rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5 text-sm font-medium">
          <span className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-amber-400" /> Alerts
          </span>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-xs">
            Close
          </Button>
        </div>

        {/* ---- new alarm form ---- */}
        <div className="border-b border-zinc-800 p-2.5">
          <div className="mb-2 flex items-center gap-1.5">
            {(['price', 'rsi', 'macd'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={cn(
                  'rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
                  kind === k
                    ? k === 'rsi'
                      ? 'bg-pink-500/15 text-pink-300'
                      : k === 'macd'
                        ? 'bg-amber-500/15 text-amber-300'
                        : 'bg-emerald-500/15 text-emerald-300'
                    : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300',
                )}
              >
                {k}
              </button>
            ))}
            <Input
              value={symbol}
              onChange={(e) => { symTouched.current = true; setSymbol(e.target.value.toUpperCase()) }}
              placeholder="SYMBOL"
              aria-label="Alarm symbol"
              className="ml-auto h-7 w-[110px] border-zinc-700 bg-zinc-950 text-xs uppercase"
            />
          </div>

          {kind === 'price' && (
            <div className="flex items-center gap-1.5">
              <select
                value={dir}
                onChange={(e) => setDir(e.target.value as 'above' | 'below')}
                aria-label="Trigger direction"
                className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1 text-xs text-zinc-200"
              >
                <option value="above">crosses above</option>
                <option value="below">falls below</option>
              </select>
              <Input
                type="number" step="any" value={price}
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && formValid && void create()}
                placeholder="Price" aria-label="Alert price"
                className="h-7 flex-1 border-zinc-700 bg-zinc-950 text-xs"
              />
            </div>
          )}

          {kind === 'rsi' && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] uppercase tracking-wider text-zinc-500">Len</label>
                <Input
                  type="number" value={rsiPeriod} min={2} max={200}
                  onChange={(e) => setRsiPeriod(e.target.value)}
                  aria-label="RSI period"
                  className="h-7 w-14 border-zinc-700 bg-zinc-950 text-xs"
                />
                <select
                  value={dir}
                  onChange={(e) => flipRsiLevel(e.target.value as 'above' | 'below')}
                  aria-label="RSI trigger direction"
                  className="h-7 rounded border border-zinc-700 bg-zinc-950 px-1 text-xs text-zinc-200"
                >
                  <option value="above">crosses above</option>
                  <option value="below">crosses below</option>
                </select>
                <Input
                  type="number" step="any" value={rsiLevel} min={1} max={99}
                  onChange={(e) => setRsiLevel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && formValid && void create()}
                  aria-label="RSI level"
                  className="h-7 w-16 border-zinc-700 bg-zinc-950 text-xs"
                />
              </div>
              <TfRow tf={tf} setTf={setTf} />
            </div>
          )}

          {kind === 'macd' && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">F/S/G</span>
                <Input type="number" value={fast} min={1} onChange={(e) => setFast(e.target.value)} aria-label="MACD fast" className="h-7 w-12 border-zinc-700 bg-zinc-950 text-xs" />
                <Input type="number" value={slow} min={2} onChange={(e) => setSlow(e.target.value)} aria-label="MACD slow" className="h-7 w-12 border-zinc-700 bg-zinc-950 text-xs" />
                <Input type="number" value={signal} min={1} onChange={(e) => setSignal(e.target.value)} aria-label="MACD signal" className="h-7 w-12 border-zinc-700 bg-zinc-950 text-xs" />
                <select
                  value={cond}
                  onChange={(e) => setCond(e.target.value as typeof cond)}
                  aria-label="MACD condition"
                  className="h-7 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-1 text-xs text-zinc-200"
                >
                  <option value="bull_cross">bull crossover</option>
                  <option value="bear_cross">bear crossover</option>
                  <option value="cross_above">crosses above</option>
                  <option value="cross_below">crosses below</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                {(cond === 'cross_above' || cond === 'cross_below') && (
                  <Input
                    type="number" step="any" value={macdLevel}
                    onChange={(e) => setMacdLevel(e.target.value)}
                    aria-label="MACD level"
                    className="h-7 w-20 border-zinc-700 bg-zinc-950 text-xs"
                  />
                )}
                <TfRow tf={tf} setTf={setTf} right />
              </div>
            </div>
          )}

          <Button
            size="sm" disabled={!formValid || creating} onClick={() => void create()}
            className="mt-2 h-7 w-full bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400"
          >
            {creating ? <TaijiSpinner className="h-3 w-3" /> : '🔔 Create alarm'}
          </Button>
        </div>

        {/* ---- alarm list ---- */}
        <div className="max-h-[45vh] overflow-y-auto p-2">
          {alerts.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-zinc-500">
              No alarms yet — create one above or right-click the chart.
            </p>
          )}
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-zinc-800/60">
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: a.color }} />
                <span className="font-medium text-zinc-200">{a.symbol}</span>
                <span className="truncate text-zinc-400">{alertSummary(a)}</span>
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
          Checked every 30s · indicator alarms fire on a real crossing of the chosen timeframe · Telegram via Settings
          <span className="ml-1 inline-flex items-center align-middle">
            <Settings2 className="h-3 w-3" />
          </span>
        </div>
      </div>
    </div>
  )
}

/** Timeframe selector row for indicator alarms. */
function TfRow({ tf, setTf, right }: { tf: string; setTf: (v: string) => void; right?: boolean }) {
  return (
    <div className={cn('flex items-center gap-1', right && 'ml-auto')}>
      <label className="text-[10px] uppercase tracking-wider text-zinc-500">TF</label>
      <div className="flex overflow-hidden rounded border border-zinc-700" role="radiogroup" aria-label="Timeframe">
        {ALERT_TFS.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            aria-pressed={tf === t}
            className={cn(
              'px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              tf === t ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300',
            )}
          >
            {TF_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  )
}
