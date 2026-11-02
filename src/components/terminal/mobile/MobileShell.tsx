'use client'

// Mobile shell (Task 56) — clones the TradingView mobile app chrome from the
// user's screen dumps (IMG_1748 / IMG_1749): a fixed bottom tab bar
// (Watchlist · Chart · Grid · Algo · Trades · Report · Menu) with safe-area
// padding and a stack of full-screen views. Only rendered below 768px
// (useIsMobile) — the desktop terminal is untouched. State (watchlists, tabs,
// alerts, strategies) is the SAME zustand store the desktop uses, so edits
// from either side stay in sync and the layout autosave keeps working.

import { useCallback, useEffect, useState } from 'react'
import { useTerminal } from '@/store/terminal'
import { MobileWatchlist } from './MobileWatchlist'
import { MobileChartView } from './MobileChartView'
import PositionsTab from '../tabs/PositionsTab'
import GridTab from '../tabs/GridTab'
import ReportTab from '../tabs/ReportTab'
import HeatmapTab from '../tabs/HeatmapTab'
import CalendarTab from '../tabs/CalendarTab'
import AlgoTab from '../tabs/AlgoTab'
import AgentTab from '../tabs/AgentTab'
import { ConsoleDrawer } from '../ConsoleDrawer'
import { useFleetPresence } from '@/hooks/use-fleet-presence'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  Bookmark, CandlestickChart, Layers, ChartColumnBig, Menu as MenuIcon,
  Settings2, BellRing, Bot, Flame, CalendarDays, LogOut, Home,
  ChevronLeft, ChevronRight, ShieldCheck, Rocket, LayoutGrid, Sparkles,
} from 'lucide-react'

// v2.8.2 — 'agent' (FSD 智慧體 autopilot) joins as a first-class view; it was
// desktop-only before, so a phone had no path to the full-scan/engage UI.
type MobileView = 'watchlist' | 'chart' | 'grid' | 'trades' | 'report' | 'menu' | 'tool' | 'algo' | 'agent'
type ToolTab = 'heatmap' | 'calendar' | 'algo'

const TOOL_TITLES: Record<ToolTab, string> = {
  heatmap: 'Heat Map',
  calendar: 'Economic Calendar',
  algo: 'Algo Trading',
}

const VIEW_KEY = 'tt:mobileView'

// 'algo' is a first-class bottom-nav tab (Task 75) — the algo workspace was
// previously buried in Menu → Algo Trading; it now sits next to Trades/Report.
// 'grid' joined it (v1.80.5) — Grid Trading was entirely absent from mobile
// before; the full GridTab mission-control (monitor / stop / edit / export /
// import-start) now renders as a first-class tab next to Chart.
const NAV: { id: Exclude<MobileView, 'tool'>; label: string; icon: typeof Bookmark }[] = [
  // 'Watch' not 'Watchlist' — 8 tabs × ~49px each on a 390px phone; the long
  // label truncated. Icon (bookmark) + position keep it unmistakable.
  { id: 'watchlist', label: 'Watch', icon: Bookmark },
  { id: 'chart', label: 'Chart', icon: CandlestickChart },
  { id: 'grid', label: 'Grid', icon: LayoutGrid },
  { id: 'algo', label: 'Algo', icon: Rocket },
  { id: 'agent', label: 'FSD', icon: Sparkles },
  { id: 'trades', label: 'Trades', icon: Layers },
  { id: 'report', label: 'Report', icon: ChartColumnBig },
  { id: 'menu', label: 'Menu', icon: MenuIcon },
]

export function MobileShell({
  onExit,
  onOpenSettings,
  onOpenAlerts,
  onOpenStrategies,
}: {
  onExit?: () => void
  onOpenSettings: () => void
  onOpenAlerts: () => void
  onOpenStrategies: () => void
}) {
  // Last-view restore. The shell only mounts CLIENT-SIDE (useIsMobile is
  // false during SSR and the first render, so this component never renders
  // on the server) — reading localStorage in the lazy initializer is safe.
  const [view, setView] = useState<MobileView>(() => {
    if (typeof window === 'undefined') return 'watchlist'
    try {
      const v = localStorage.getItem(VIEW_KEY)
      if (v && ['watchlist', 'chart', 'grid', 'algo', 'agent', 'trades', 'report', 'menu'].includes(v)) return v as MobileView
    } catch {
      /* private mode */
    }
    return 'watchlist'
  })
  const [toolTab, setToolTab] = useState<ToolTab>('heatmap')

  const user = useTerminal((s) => s.user)
  const alerts = useTerminal((s) => s.alerts)
  const strategies = useTerminal((s) => s.strategies)
  const selectSymbol = useTerminal((s) => s.selectSymbol)
  // v2.8.3 — running-rainbow on the bottom nav while the FSD fleet trades
  // (strip along the nav's top edge + live treatment on the FSD entry)
  const fleetEngaged = useFleetPresence()
  const activeAlerts = alerts.filter((a) => a.status === 'active').length
  const armedStrategies = strategies.filter((r) => r.status === 'armed').length

  const go = useCallback((v: MobileView) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* private mode */
    }
  }, [])

  // a symbol picked from a full-screen tool (heat-map tile, calendar row)
  // routes the terminal to the chart view (store dispatches tt:symbol-picked)
  useEffect(() => {
    const onPicked = () => go('chart')
    window.addEventListener('tt:symbol-picked', onPicked)
    return () => window.removeEventListener('tt:symbol-picked', onPicked)
  }, [go])

  const openChart = useCallback(
    (sym: string) => {
      selectSymbol(sym) // updates the focused pane; activates the first chart tab when needed
      go('chart')
    },
    [selectSymbol, go],
  )

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.reload()
  }, [])

  const menuRow = (
    label: string,
    icon: typeof Settings2,
    onClick: () => void,
    opts?: { danger?: boolean; badge?: number; badgeClass?: string },
  ) => {
    const Icon = icon
    return (
      <button
        key={label}
        onClick={onClick}
        className={cn(
          'flex min-h-[52px] w-full items-center gap-3 border-b border-zinc-800/60 px-4 text-left text-[15px] transition-colors last:border-b-0 active:bg-zinc-800/60',
          opts?.danger ? 'text-rose-400' : 'text-zinc-200',
        )}
      >
        <Icon className="h-5 w-5 shrink-0 text-zinc-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {opts?.badge != null && opts.badge > 0 && (
          <Badge variant="outline" className={cn('shrink-0 px-1.5 text-[10px]', opts.badgeClass ?? 'border-zinc-700 text-zinc-400')}>
            {opts.badge}
          </Badge>
        )}
        {!opts?.danger && <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" aria-hidden />}
      </button>
    )
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      {/* ---- full-screen views ---- */}
      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'watchlist' && <MobileWatchlist onOpenChart={openChart} />}

        {view === 'chart' && <MobileChartView onOpenWatchlist={() => go('watchlist')} />}

        {view === 'trades' && <PositionsTab />}

        {view === 'report' && (
          <div className="min-h-0 flex-1 overflow-y-auto terminal-scroll">
            <ReportTab />
          </div>
        )}

        {/* first-class Algo tab — same workspace the Menu row opens, rendered
            directly (AlgoTab scrolls itself: flex-1 + overflow-y-auto) */}
        {view === 'algo' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <AlgoTab />
          </div>
        )}

        {/* first-class Grid tab (v1.80.5) — the full GridTab mission-control:
            live grid list, P&L, fills, stop / edit-when-flat / delete and
            export-import (import can START a grid without the chart tool).
            Creation via the chart's two-click Grid tool stays desktop-only. */}
        {view === 'grid' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <GridTab />
          </div>
        )}

        {/* first-class FSD tab (v2.8.2) — the 智慧體 autopilot workspace:
            full scan / abort / ranked board / engage-disengage. AgentTab's
            root scrolls itself (flex-1 + overflow-y-auto), so the wrapper
            must be a flex column for flex-1 to bite. */}
        {view === 'agent' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <AgentTab />
          </div>
        )}

        {view === 'tool' && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900/80 px-1.5">
              <button
                onClick={() => go('menu')}
                className="flex h-9 items-center gap-0.5 rounded px-2 text-sm font-medium text-zinc-300 active:bg-zinc-800"
                aria-label="Back to menu"
              >
                <ChevronLeft className="h-4.5 w-4.5" /> Menu
              </button>
              <span className="ml-1 text-sm font-semibold text-zinc-100">
                {TOOL_TITLES[toolTab] ?? 'Tool'}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              {toolTab === 'heatmap' ? <HeatmapTab /> : toolTab === 'calendar' ? <CalendarTab /> : <AlgoTab />}
            </div>
          </div>
        )}

        {view === 'menu' && (
          <div className="min-h-0 flex-1 overflow-y-auto terminal-scroll px-4 pb-6 pt-4">
            {/* account card */}
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-lg font-bold text-emerald-400" aria-hidden>
                {(user?.username ?? '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-zinc-100">{user?.username ?? 'Trader'}</p>
                <Badge variant="outline" className="mt-1 gap-1 border-emerald-500/40 text-[10px] text-emerald-400">
                  <ShieldCheck className="h-3 w-3" aria-hidden /> 2FA enabled
                </Badge>
              </div>
            </div>

            {/* actions */}
            <nav aria-label="Menu" className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70">
              {menuRow('Settings', Settings2, onOpenSettings)}
              {menuRow('Alerts', BellRing, onOpenAlerts, { badge: activeAlerts, badgeClass: 'border-amber-500/40 text-amber-400' })}
              {menuRow('Strategy orders', Bot, onOpenStrategies, { badge: armedStrategies, badgeClass: 'border-violet-500/40 text-violet-400' })}
              {menuRow('FSD Autopilot (智慧體)', Sparkles, () => go('agent'))}
              {menuRow('Algo Trading', Rocket, () => { setToolTab('algo'); go('tool') })}
              {menuRow('Grid Trading', LayoutGrid, () => go('grid'))}
              {menuRow('Heat Map', Flame, () => { setToolTab('heatmap'); go('tool') })}
              {menuRow('Economic Calendar', CalendarDays, () => { setToolTab('calendar'); go('tool') })}
              {onExit && menuRow('Back to landing page', Home, onExit)}
              {menuRow('Sign out', LogOut, () => void logout(), { danger: true })}
            </nav>

            <p className="mt-4 text-center text-[10px] leading-4 text-zinc-600">
              BLACKHOLE Terminal · data: Alpaca · 2FA-protected
              <br />
              layout auto-saves every 5s
            </p>
          </div>
        )}
      </div>

      {/* console (slim bar above the nav; expandable event log) */}
      <ConsoleDrawer />

      {/* ---- fixed bottom tab bar (clone of the dump's 觀察清單/圖表/… nav) ---- */}
      <nav
        aria-label="Mobile sections"
        className="relative shrink-0 border-t border-zinc-800 bg-zinc-900/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur"
      >
        {/* v2.8.3 — running rainbow while the FSD fleet is ENGAGED (every tab) */}
        {fleetEngaged && <div className="fsd-rainbow-strip absolute inset-x-0 top-0 z-10 h-[3px]" aria-hidden="true" />}
        <div className="flex items-stretch">
          {NAV.map(({ id, label, icon: Icon }) => {
            const isActive = view === id || (view === 'tool' && id === 'menu')
            // v2.8.3 — the FSD entry itself goes live while the fleet trades
            const fsdLive = fleetEngaged && id === 'agent'
            return (
              <button
                key={id}
                onClick={() => go(id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex min-h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 overflow-hidden px-0.5 py-1.5 text-[10px] font-medium transition-colors active:bg-zinc-800/60',
                  isActive ? 'text-emerald-400' : 'text-zinc-500',
                  fsdLive && 'fsd-nav-live',
                )}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden />
                <span className={cn('max-w-full truncate', fsdLive && 'fsd-live-chip-text')}>{label}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
