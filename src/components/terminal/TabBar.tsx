'use client'

// Top bar: local tabs (chart / calendar / heat map) + add-tab menu + account controls.
// Tabs are drag-reorderable (HTML5 DnD, Task 28 #2) and the order persists via
// the autosaved layout.
import { useState } from 'react'
import { useTerminal, TabType, tabPanes, tabLayout, GRID_LAYOUTS, GridLayoutId } from '@/store/terminal'
import {
  CandlestickChart, CalendarDays, Flame, Plus, X, LogOut, Settings2, BellRing, UserRound,
  PanelsTopLeft, Crosshair, Check, Layers, Bot, ChartColumnBig, Rocket,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const TYPE_META: Record<TabType, { label: string; icon: typeof CandlestickChart }> = {
  chart: { label: 'Chart', icon: CandlestickChart },
  calendar: { label: 'Economic Calendar', icon: CalendarDays },
  heatmap: { label: 'Heat Map', icon: Flame },
  positions: { label: 'Positions', icon: Layers },
  strategy: { label: 'Strategy Orders', icon: Bot },
  report: { label: 'Report', icon: ChartColumnBig },
  algo: { label: 'Algo Trading', icon: Rocket },
}

export function TabBar({
  onOpenSettings,
  alertsOpen,
  setAlertsOpen,
  strategiesOpen,
  setStrategiesOpen,
}: {
  onOpenSettings: () => void
  alertsOpen: boolean
  setAlertsOpen: (v: boolean) => void
  strategiesOpen: boolean
  setStrategiesOpen: (v: boolean) => void
}) {
  const tabs = useTerminal((s) => s.tabs)
  const activeTabId = useTerminal((s) => s.activeTabId)
  const setActiveTab = useTerminal((s) => s.setActiveTab)
  const addTab = useTerminal((s) => s.addTab)
  const closeTab = useTerminal((s) => s.closeTab)
  const moveTab = useTerminal((s) => s.moveTab)
  const user = useTerminal((s) => s.user)
  const alerts = useTerminal((s) => s.alerts)
  const activeAlerts = alerts.filter((a) => a.status === 'active').length
  const strategies = useTerminal((s) => s.strategies)
  const armedStrategies = strategies.filter((r) => r.status === 'armed').length
  const [confirmClose, setConfirmClose] = useState<string | null>(null)

  // ---- tab drag-and-drop reorder (Task 28 #2) ----
  // HTML5 DnD: dragging over a tab shows an emerald insertion edge on the
  // hovered half; dropping moves the dragged tab there.
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dropEdge, setDropEdge] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const reorderable = tabs.length > 1
  const clearDropEdge = () => setDropEdge(null)
  const handleDropOn = (targetId: string) => {
    if (!dragTabId || dragTabId === targetId) return clearDropEdge()
    const edge = dropEdge && dropEdge.id === targetId ? dropEdge.side : 'before'
    const fromIdx = tabs.findIndex((t) => t.id === dragTabId)
    const targetIdx = tabs.findIndex((t) => t.id === targetId)
    if (fromIdx < 0 || targetIdx < 0) return clearDropEdge()
    // index in the array WITHOUT the dragged tab (store removes-then-inserts)
    let insertAt = edge === 'before' ? targetIdx : targetIdx + 1
    if (fromIdx < insertAt) insertAt -= 1
    moveTab(dragTabId, insertAt)
    clearDropEdge()
  }

  // multi-chart grid controls apply to the active chart tab
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
  const isChartTab = activeTab?.type === 'chart'
  const layout = activeTab ? tabLayout(activeTab) : '1'
  const paneCount = activeTab ? tabPanes(activeTab).length : 1
  const syncOn = Boolean(activeTab?.syncCrosshair)

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.reload()
  }

  return (
    <header className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-900/80 px-2 py-1.5">
      <div className="mr-2 flex items-center gap-1.5 pl-1">
        <CandlestickChart className="h-4 w-4 text-emerald-500" />
        <span className="hidden text-sm font-semibold tracking-tight text-zinc-100 sm:inline">TradeTerminal</span>
      </div>

      {/* tabs strip */}
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Terminal tabs">
        {tabs.map((t) => {
          const Icon = TYPE_META[t.type].icon
          const isActive = t.id === activeTabId
          // chart tabs show the FOCUSED pane's symbol so multi-chart tabs
          // follow "the symbol selected in each chart" (legacy tabs keep
          // tab.symbol, which mirrors pane 0)
          const panes = t.type === 'chart' ? tabPanes(t) : null
          const title = panes
            ? panes[Math.min(t.focusedPane ?? 0, panes.length - 1)]?.symbol ?? t.symbol
            : TYPE_META[t.type].label
          const edge = dropEdge?.id === t.id ? dropEdge.side : null
          const dragging = dragTabId === t.id
          return (
            <div
              key={t.id}
              className={`relative group flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs transition-colors ${
                isActive
                  ? 'border-emerald-500 bg-zinc-800/80 text-zinc-100'
                  : 'border-transparent text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
              } ${dragging ? 'opacity-40' : ''}`}
              draggable={reorderable}
              onDragStart={(e) => {
                if (!reorderable) {
                  e.preventDefault()
                  return
                }
                setDragTabId(t.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', t.id)
              }}
              onDragOver={(e) => {
                if (!dragTabId) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const side = e.clientX <= e.currentTarget.getBoundingClientRect().left + e.currentTarget.clientWidth / 2 ? 'before' : 'after'
                setDropEdge((prev) => (prev?.id === t.id && prev.side === side ? prev : { id: t.id, side }))
              }}
              onDrop={(e) => {
                e.preventDefault()
                handleDropOn(t.id)
              }}
              onDragEnd={() => {
                setDragTabId(null)
                clearDropEdge()
              }}
              title={reorderable ? `${title} — drag to reorder` : title}
            >
              {/* insertion edge indicator */}
              {edge && (
                <span
                  aria-hidden="true"
                  className={`absolute top-1 bottom-1 z-10 w-0.5 rounded-full bg-emerald-400 ${
                    edge === 'before' ? '-left-px' : '-right-px'
                  }`}
                />
              )}
              <button
                className="flex items-center gap-1.5"
                onClick={() => setActiveTab(t.id)}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="max-w-[140px] truncate font-medium">{title}</span>
              </button>
              {tabs.length > 1 && (
                <button
                  className="rounded p-0.5 text-zinc-500 transition-opacity hover:bg-rose-500/20 hover:text-rose-400 focus:opacity-100 md:opacity-60 md:group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmClose(t.id)
                  }}
                  aria-label={`Remove ${title} tab`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )
        })}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-zinc-400 hover:text-zinc-100" aria-label="Add tab">
              <Plus className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="border-zinc-800 bg-zinc-900">
            <DropdownMenuLabel className="text-xs text-zinc-500">New tab</DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuItem onClick={() => addTab('chart')} className="gap-2 text-xs">
              <CandlestickChart className="h-3.5 w-3.5" /> Chart layout
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('calendar')} className="gap-2 text-xs">
              <CalendarDays className="h-3.5 w-3.5" /> Economic Calendar
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('heatmap')} className="gap-2 text-xs">
              <Flame className="h-3.5 w-3.5" /> Heat Map
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('positions')} className="gap-2 text-xs">
              <Layers className="h-3.5 w-3.5" /> Positions
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('strategy')} className="gap-2 text-xs">
              <Bot className="h-3.5 w-3.5" /> Strategy Orders
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('report')} className="gap-2 text-xs">
              <ChartColumnBig className="h-3.5 w-3.5" /> Performance Report
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addTab('algo')} className="gap-2 text-xs">
              <Rocket className="h-3.5 w-3.5" /> Algo Trading
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      {/* multi-chart layout selector + crosshair sync (chart tabs only) */}
      {isChartTab && (
        <div className="flex shrink-0 items-center gap-1 pl-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-zinc-400 hover:text-zinc-100"
                aria-label="Chart layout"
                title="Chart layout — number of charts in this tab"
              >
                <PanelsTopLeft className="h-3.5 w-3.5" />
                <span className="hidden text-[11px] font-medium sm:inline">{GRID_LAYOUTS.find((l) => l.id === layout)?.short ?? '1'}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-zinc-800 bg-zinc-900">
              <DropdownMenuLabel className="text-xs text-zinc-500">Chart layout (this tab)</DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-zinc-800" />
              {GRID_LAYOUTS.map((l) => (
                <DropdownMenuItem
                  key={l.id}
                  onClick={() => {
                    if (activeTab) useTerminal.getState().setGridLayout(activeTab.id, l.id as GridLayoutId)
                  }}
                  className="gap-2 text-xs"
                >
                  <span className="w-7 shrink-0 rounded border border-zinc-700 text-center text-[10px] text-zinc-400">{l.short}</span>
                  <span className="flex-1">{l.label}</span>
                  {l.id === layout && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {paneCount > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-7 w-7',
                syncOn ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-400 hover:text-zinc-100',
              )}
              onClick={() => {
                if (activeTab) useTerminal.getState().setSyncCrosshair(activeTab.id, !syncOn)
              }}
              aria-pressed={syncOn}
              aria-label="Sync crosshair across charts"
              title={syncOn ? 'Crosshair sync ON — hover one chart, others follow' : 'Sync crosshair across charts'}
            >
              <Crosshair className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}

      {/* account cluster */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'relative h-7 w-7 text-zinc-400 hover:text-zinc-100',
            strategiesOpen && 'bg-violet-500/15 text-violet-300',
          )}
          onClick={() => setStrategiesOpen(!strategiesOpen)}
          aria-label="Strategy orders"
          title="Strategy orders — IF indicator condition THEN buy/sell with TP/SL"
        >
          <Bot className="h-4 w-4" />
          {armedStrategies > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-violet-500 px-0.5 text-[9px] font-bold text-zinc-950">
              {armedStrategies}
            </span>
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-7 w-7 text-zinc-400 hover:text-zinc-100"
          onClick={() => setAlertsOpen(!alertsOpen)}
          aria-label="Alerts"
        >
          <BellRing className="h-4 w-4" />
          {activeAlerts > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[9px] font-bold text-zinc-950">
              {activeAlerts}
            </span>
          )}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-zinc-100" onClick={onOpenSettings} aria-label="Settings">
          <Settings2 className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-zinc-300">
              <UserRound className="h-3.5 w-3.5" />
              <span className="hidden max-w-[120px] truncate md:inline">{user?.username}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Badge variant="outline" className="border-emerald-500/40 text-[10px] text-emerald-400">
                2FA enabled
              </Badge>
            </div>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuItem onClick={logout} className="gap-2 text-xs text-rose-400">
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* confirm before removing a tab (layout action) */}
      <AlertDialog open={confirmClose != null} onOpenChange={(o) => !o && setConfirmClose(null)}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-zinc-100">Remove this tab?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              “{confirmClose ? (() => { const t = tabs.find((x) => x.id === confirmClose); return t ? (t.type === 'chart' ? t.symbol : TYPE_META[t.type].label) : '' })() : ''}” will be removed from your saved layout. Drawings and alerts are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={() => {
                if (confirmClose) closeTab(confirmClose)
                setConfirmClose(null)
              }}
            >
              Remove tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  )
}
