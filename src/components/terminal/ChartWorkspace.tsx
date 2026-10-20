'use client'

// Chart workspace: chart area (multi-chart grid) | sidebar split; sidebar =
// reorderable, collapsible Watchlist/Quote/News panels (Task 12).
// Grid layouts per chart tab: 1 / 2 side-by-side / 2 stacked / 3 / 4 (Task 19).
import { useCallback } from 'react'
import { ResizablePanelGroup as PanelGroup, ResizablePanel as Panel, ResizableHandle as PanelResizeHandle } from '@/components/ui/resizable'
import { useTerminal, PanelId, Tab, tabPanes, tabLayout, GridLayoutId, GridSizes } from '@/store/terminal'
import { useIsMobile } from '@/hooks/use-mobile'
import { WatchlistPanel } from './sidebar/WatchlistPanel'
import { QuotePanel } from './sidebar/QuotePanel'
import { NewsPanel } from './sidebar/NewsPanel'
import { ChartPanel } from '@/components/chart/ChartPanel'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'

const PANEL_TITLES: Record<PanelId, string> = {
  watchlist: 'Watchlist',
  quote: 'Quote',
  news: 'News',
}

export function ChartWorkspace({ tab }: { tab: Tab }) {
  const isMobile = useIsMobile()
  const panelOrder = useTerminal((s) => s.panelOrder)
  const setPanelOrder = useTerminal((s) => s.setPanelOrder)
  const panelCollapsed = useTerminal((s) => s.panelCollapsed)
  const togglePanelCollapsed = useTerminal((s) => s.togglePanelCollapsed)
  const mainSizes = useTerminal((s) => s.mainSizes)
  const setMainSizes = useTerminal((s) => s.setMainSizes)

  const move = useCallback(
    (id: PanelId, dir: -1 | 1) => {
      const order = [...panelOrder]
      const i = order.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= order.length) return
      ;[order[i], order[j]] = [order[j], order[i]]
      setPanelOrder(order)
    },
    [panelOrder, setPanelOrder],
  )

  const renderPanel = (id: PanelId) => {
    const collapsed = Boolean(panelCollapsed[id])
    return (
      <Panel key={id} id={id} order={panelOrder.indexOf(id)} minSize={8} className="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-900/70">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/80 bg-zinc-900 px-2.5 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{PANEL_TITLES[id]}</span>
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-5 w-5 text-zinc-500 hover:text-zinc-200" onClick={() => move(id, -1)} aria-label={`Move ${PANEL_TITLES[id]} up`}>
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-5 w-5 text-zinc-500 hover:text-zinc-200" onClick={() => move(id, 1)} aria-label={`Move ${PANEL_TITLES[id]} down`}>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-5 w-5 text-zinc-500 hover:text-zinc-200" onClick={() => togglePanelCollapsed(id)} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${PANEL_TITLES[id]}`}>
              {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5 rotate-180" />}
            </Button>
          </div>
        </div>
        {!collapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto terminal-scroll">
            {id === 'watchlist' && <WatchlistPanel />}
            {id === 'quote' && <QuotePanel symbol={focusedPaneSymbol(tab)} />}
            {id === 'news' && <NewsPanel symbol={focusedPaneSymbol(tab)} />}
          </div>
        )}
      </Panel>
    )
  }

  if (isMobile) {
    // Mobile: charts stacked on top, sidebar below (grid layouts stack vertically)
    const panes = tabPanes(tab)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <div className="flex h-[52vh] shrink-0 flex-col gap-1.5 overflow-y-auto terminal-scroll">
          {panes.map((p, i) => (
            <div key={i} className="h-[50vh] shrink-0 overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-900/70">
              <ChartPane tab={tab} paneIdx={i} />
            </div>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto terminal-scroll">
          {panelOrder.map((id) => (
            <div key={id} className="flex max-h-[70vh] flex-col overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-900/70">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/80 bg-zinc-900 px-2.5 py-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{PANEL_TITLES[id]}</span>
                <Button variant="ghost" size="icon" className="h-5 w-5 text-zinc-500 hover:text-zinc-200" onClick={() => togglePanelCollapsed(id)} aria-label={`${panelCollapsed[id] ? 'Expand' : 'Collapse'} ${PANEL_TITLES[id]}`}>
                  {panelCollapsed[id] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                </Button>
              </div>
              {!panelCollapsed[id] && (
                <div className="min-h-0 overflow-y-auto terminal-scroll" style={{ maxHeight: '40vh' }}>
                  {id === 'watchlist' && <WatchlistPanel />}
                  {id === 'quote' && <QuotePanel symbol={focusedPaneSymbol(tab)} />}
                  {id === 'news' && <NewsPanel symbol={focusedPaneSymbol(tab)} />}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 p-2">
      <PanelGroup
        direction="horizontal"
        onLayout={(sizes: number[]) => {
          if (sizes.length === 2) setMainSizes([sizes[0], sizes[1]])
        }}
      >
        <Panel defaultSize={mainSizes[0]} minSize={35}>
          <div className="h-full overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-900/70">
            <ChartGrid tab={tab} />
          </div>
        </Panel>
        <PanelResizeHandle className="w-1.5 rounded bg-transparent transition-colors hover:bg-zinc-700/60 data-[resize-handle-state=drag]:bg-emerald-500/50" />
        <Panel defaultSize={mainSizes[1]} minSize={16} maxSize={55}>
          <PanelGroup direction="vertical" className="h-full">
            {panelOrder.map((id, idx) => (
              <div key={id} className="contents">
                {idx > 0 && (
                  <PanelResizeHandle className="h-1.5 rounded bg-transparent transition-colors hover:bg-zinc-700/60 data-[resize-handle-state=drag]:bg-emerald-500/50" />
                )}
                {renderPanel(id)}
              </div>
            ))}
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  )
}

/** Symbol of the focused pane (drives Quote/News sidebar). */
function focusedPaneSymbol(tab: Tab): string {
  const panes = tabPanes(tab)
  const idx = Math.min(tab.focusedPane ?? 0, panes.length - 1)
  return panes[idx]?.symbol ?? tab.symbol
}

/** One chart pane wired to per-pane store state. */
function ChartPane({ tab, paneIdx }: { tab: Tab; paneIdx: number }) {
  const setPaneSymbol = useTerminal((s) => s.setPaneSymbol)
  const setPaneTimeframe = useTerminal((s) => s.setPaneTimeframe)
  const setPaneChartType = useTerminal((s) => s.setPaneChartType)
  const setFocusedPane = useTerminal((s) => s.setFocusedPane)
  const panes = tabPanes(tab)
  const pane = panes[Math.min(paneIdx, panes.length - 1)]
  const focusedIdx = Math.min(tab.focusedPane ?? 0, panes.length - 1)
  const multi = panes.length > 1
  return (
    <ChartPanel
      symbol={pane.symbol}
      timeframe={pane.timeframe}
      chartType={pane.chartType}
      onSymbolChange={(s) => setPaneSymbol(tab.id, paneIdx, s)}
      onTimeframeChange={(tf) => setPaneTimeframe(tab.id, paneIdx, tf)}
      onChartTypeChange={(t) => setPaneChartType(tab.id, paneIdx, t)}
      onFocus={multi ? () => setFocusedPane(tab.id, paneIdx) : undefined}
      focused={multi ? paneIdx === focusedIdx : undefined}
      syncKey={`${tab.id}:${paneIdx}`}
      syncGroup={tab.syncCrosshair ? tab.id : null}
      compact={multi}
    />
  )
}

/** Hook up per-group pane-proportion persistence: defaultSize seeds from the
 *  tab's stored grid.sizes (hydrate restores them), onLayout writes drags back
 *  so the 5s autosave carries them. Tabs remount on switch (keyed upstream),
 *  so the stored proportions re-apply on every mount. */
function useGridSizes(tab: Tab): {
  sizeOf: (key: string, idx: number, dflt: number) => number
  onLayout: (key: string) => (sizes: number[]) => void
} {
  const setGridSizes = useTerminal((s) => s.setGridSizes)
  const sizes: GridSizes | undefined = tab.grid?.sizes
  const sizeOf = useCallback(
    (key: string, idx: number, dflt: number) => {
      const arr = sizes?.[key]
      const v = arr?.[idx]
      return typeof v === 'number' && Number.isFinite(v) ? v : dflt
    },
    [sizes],
  )
  const onLayout = useCallback(
    (key: string) => (groupSizes: number[]) => {
      if (groupSizes.length >= 2) setGridSizes(tab.id, key, groupSizes)
    },
    [setGridSizes, tab.id],
  )
  return { sizeOf, onLayout }
}

/** Multi-chart grid: renders the tab's layout (1/2h/2v/3s/4/6/8) with the
 *  tab's persisted pane proportions (dragged splitters survive reload/import). */
function ChartGrid({ tab }: { tab: Tab }) {
  const layout: GridLayoutId = tabLayout(tab)
  const panes = tabPanes(tab)
  const { sizeOf, onLayout } = useGridSizes(tab)
  const pane = (i: number) => <ChartPane tab={tab} paneIdx={i} />
  const handle = (dir: 'horizontal' | 'vertical') => (
    <PanelResizeHandle
      className={cnResize(dir)}
    />
  )

  switch (layout) {
    case '2h':
      return (
        <PanelGroup direction="horizontal" onLayout={onLayout('g')} className="h-full">
          <Panel defaultSize={sizeOf('g', 0, 50)} minSize={20}>{pane(0)}</Panel>
          {handle('horizontal')}
          <Panel defaultSize={sizeOf('g', 1, 50)} minSize={20}>{pane(1)}</Panel>
        </PanelGroup>
      )
    case '2v':
      return (
        <PanelGroup direction="vertical" onLayout={onLayout('g')} className="h-full">
          <Panel defaultSize={sizeOf('g', 0, 50)} minSize={20}>{pane(0)}</Panel>
          {handle('vertical')}
          <Panel defaultSize={sizeOf('g', 1, 50)} minSize={20}>{pane(1)}</Panel>
        </PanelGroup>
      )
    case '3s':
      return (
        <PanelGroup direction="vertical" onLayout={onLayout('v')} className="h-full">
          <Panel defaultSize={sizeOf('v', 0, 58)} minSize={25}>{pane(0)}</Panel>
          {handle('vertical')}
          <Panel defaultSize={sizeOf('v', 1, 42)} minSize={20}>
            <PanelGroup direction="horizontal" onLayout={onLayout('h')} className="h-full">
              <Panel defaultSize={sizeOf('h', 0, 50)} minSize={20}>{pane(1)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('h', 1, 50)} minSize={20}>{pane(2)}</Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      )
    case '4':
      return (
        <PanelGroup direction="vertical" onLayout={onLayout('v')} className="h-full">
          <Panel defaultSize={sizeOf('v', 0, 50)} minSize={20}>
            <PanelGroup direction="horizontal" onLayout={onLayout('ht')} className="h-full">
              <Panel defaultSize={sizeOf('ht', 0, 50)} minSize={20}>{pane(0)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('ht', 1, 50)} minSize={20}>{pane(1)}</Panel>
            </PanelGroup>
          </Panel>
          {handle('vertical')}
          <Panel defaultSize={sizeOf('v', 1, 50)} minSize={20}>
            <PanelGroup direction="horizontal" onLayout={onLayout('hb')} className="h-full">
              <Panel defaultSize={sizeOf('hb', 0, 50)} minSize={20}>{pane(2)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('hb', 1, 50)} minSize={20}>{pane(3)}</Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      )
    case '6':
      return (
        <PanelGroup direction="vertical" onLayout={onLayout('v')} className="h-full">
          <Panel defaultSize={sizeOf('v', 0, 50)} minSize={20}>
            <PanelGroup direction="horizontal" onLayout={onLayout('ht')} className="h-full">
              <Panel defaultSize={sizeOf('ht', 0, 33.4)} minSize={15}>{pane(0)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('ht', 1, 33.3)} minSize={15}>{pane(1)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('ht', 2, 33.3)} minSize={15}>{pane(2)}</Panel>
            </PanelGroup>
          </Panel>
          {handle('vertical')}
          <Panel defaultSize={sizeOf('v', 1, 50)} minSize={20}>
            <PanelGroup direction="horizontal" onLayout={onLayout('hb')} className="h-full">
              <Panel defaultSize={sizeOf('hb', 0, 33.4)} minSize={15}>{pane(3)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('hb', 1, 33.3)} minSize={15}>{pane(4)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('hb', 2, 33.3)} minSize={15}>{pane(5)}</Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      )
    case '8':
      return (
        <PanelGroup direction="vertical" onLayout={onLayout('v')} className="h-full">
          <Panel defaultSize={sizeOf('v', 0, 50)} minSize={20}>
            <PanelGroup direction="horizontal" onLayout={onLayout('ht')} className="h-full">
              <Panel defaultSize={sizeOf('ht', 0, 25)} minSize={12}>{pane(0)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('ht', 1, 25)} minSize={12}>{pane(1)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('ht', 2, 25)} minSize={12}>{pane(2)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('ht', 3, 25)} minSize={12}>{pane(3)}</Panel>
            </PanelGroup>
          </Panel>
          {handle('vertical')}
          <Panel defaultSize={sizeOf('v', 1, 50)} minSize={20}>
            <PanelGroup direction="horizontal" onLayout={onLayout('hb')} className="h-full">
              <Panel defaultSize={sizeOf('hb', 0, 25)} minSize={12}>{pane(4)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('hb', 1, 25)} minSize={12}>{pane(5)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('hb', 2, 25)} minSize={12}>{pane(6)}</Panel>
              {handle('horizontal')}
              <Panel defaultSize={sizeOf('hb', 3, 25)} minSize={12}>{pane(7)}</Panel>
            </PanelGroup>
          </Panel>
        </PanelGroup>
      )
    case '1':
    default:
      return pane(0)
  }
}

function cnResize(dir: 'horizontal' | 'vertical'): string {
  const base = 'rounded bg-transparent transition-colors hover:bg-zinc-700/60 data-[resize-handle-state=drag]:bg-emerald-500/50 z-40'
  return dir === 'horizontal' ? `${base} w-1.5` : `${base} h-1.5`
}
