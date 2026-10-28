'use client'

// Mobile chart view (Task 56) — clones the TradingView mobile app chart
// screen from the user's dump (IMG_1749): the chart fills the whole area and
// a floating bottom toolbar carries the primary actions — symbol (opens the
// chart's symbol search), timeframe sheet, draw-tools sheet, indicators,
// trade ticket and a "more" sheet (chart type / watchlist jump).
//
// The ChartPanel keeps all of its desktop superpowers (drawings, alerts,
// ticket, indicators). The mobile shell reaches into its few INTERNAL states
// (symbol search, ticket, indicator popover, drawing color) through small
// window-event listeners the panel exposes — see ChartPanel.tsx.

import { useEffect, useState } from 'react'
import { useTerminal, tabPanes, DRAW_COLORS, DrawingKind } from '@/store/terminal'
import { TIMEFRAMES, isCryptoSymbol, Timeframe } from '@/lib/market-types'
import { ChartPanel } from '@/components/chart/ChartPanel'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import {
  ChevronDown, Pencil, Sigma, Briefcase, Ellipsis, X, Plus,
  MousePointer2, Minus, ArrowUpDown, TrendingUp, Ruler, Square, Type,
  CandlestickChart as CandlestickIcon, LineChart as LineChartIcon,
  AlignHorizontalJustifyCenter, Clock, Lightbulb, Grid3x3, Layers,
} from 'lucide-react'

const TOOLS: { id: DrawingKind | 'cursor'; label: string; icon: typeof MousePointer2; hint?: string }[] = [
  { id: 'cursor', label: 'Cursor', icon: MousePointer2, hint: 'Pan / zoom / select' },
  { id: 'hline', label: 'H-line', icon: Minus, hint: 'Horizontal price line' },
  { id: 'vline', label: 'V-line', icon: ArrowUpDown, hint: 'Vertical time line' },
  { id: 'trend', label: 'Trend line', icon: TrendingUp, hint: '2 taps on the chart' },
  { id: 'fib', label: 'Fib', icon: Ruler, hint: 'Fib retracement — 2 taps' },
  { id: 'rect', label: 'Rect', icon: Square, hint: 'Rectangle zone — 2 taps' },
  { id: 'text', label: 'Text', icon: Type, hint: 'Tap to place a note' },
]

const TOOL_LABEL: Record<string, string> = {
  cursor: 'Cursor',
  hline: 'Horizontal line',
  vline: 'Vertical line',
  trend: 'Trend line',
  fib: 'Fib retracement',
  rect: 'Rectangle',
  text: 'Text',
}

// ---- Grid-trade overlay UI state (v1.87.0) ----
// The desktop drawing toolbar's Grid3x3 toggle + Layers popover are hidden on
// mobile (<640px), so the More sheet mirrors them here. ChartPanel owns the
// state and broadcasts it on every change via tt:grid-ui-changed; this view
// lazy-initializes from the same localStorage keys the panel persists, so the
// badges/slider are correct on first paint even before any event arrives.
interface GridUiState {
  overlay: boolean
  bandOn: boolean
  opacity: number
}
const GRID_UI_DEFAULT: GridUiState = { overlay: false, bandOn: true, opacity: 0.2 }
function loadGridUi(): GridUiState {
  if (typeof window === 'undefined') return GRID_UI_DEFAULT
  try {
    const band = JSON.parse(localStorage.getItem('bh-grid-band') ?? '{}') as {
      on?: unknown
      opacity?: unknown
    }
    return {
      overlay: localStorage.getItem('bh-grid-overlay') === '1',
      bandOn: typeof band?.on === 'boolean' ? band.on : true,
      opacity:
        typeof band?.opacity === 'number' && band.opacity >= 0 && band.opacity <= 0.5
          ? band.opacity
          : 0.2,
    }
  } catch {
    return GRID_UI_DEFAULT
  }
}

export function MobileChartView({ onOpenWatchlist }: { onOpenWatchlist: () => void }) {
  const tabs = useTerminal((s) => s.tabs)
  const activeTabId = useTerminal((s) => s.activeTabId)
  const setPaneSymbol = useTerminal((s) => s.setPaneSymbol)
  const setPaneTimeframe = useTerminal((s) => s.setPaneTimeframe)
  const setPaneChartType = useTerminal((s) => s.setPaneChartType)
  const drawingTool = useTerminal((s) => s.drawingTool)
  const setDrawingTool = useTerminal((s) => s.setDrawingTool)
  const addTab = useTerminal((s) => s.addTab)
  // ETH toggle state lives in the shared store (Task 59) — the row only
  // READS it for the ON/OFF badge; flipping dispatches tt:toggle-eth which
  // the chart panel (and the Alt+Shift+E shortcut) apply globally
  const showExtendedHours = useTerminal((s) => s.showExtendedHours)

  const [tfOpen, setTfOpen] = useState(false)
  const [drawOpen, setDrawOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // grid overlay + range shadow state, mirrored from ChartPanel via events
  const [gridUi, setGridUi] = useState<GridUiState>(loadGridUi)

  // ChartPanel broadcasts {overlay, bandOn, opacity} on mount/hydration and
  // every toggle/slider change — keep the More sheet in sync (it re-reads
  // loadGridUi() on open too, covering panels mounted before this sheet).
  useEffect(() => {
    const onGridUi = (e: Event) => {
      const d = (e as CustomEvent).detail as Partial<GridUiState> | null
      if (!d || typeof d !== 'object') return
      setGridUi((prev) => ({
        overlay: typeof d.overlay === 'boolean' ? d.overlay : prev.overlay,
        bandOn: typeof d.bandOn === 'boolean' ? d.bandOn : prev.bandOn,
        opacity: typeof d.opacity === 'number' && d.opacity >= 0 && d.opacity <= 0.5 ? d.opacity : prev.opacity,
      }))
    }
    window.addEventListener('tt:grid-ui-changed', onGridUi)
    return () => window.removeEventListener('tt:grid-ui-changed', onGridUi)
  }, [])

  const active = tabs.find((t) => t.id === activeTabId)
  const chartTab = active?.type === 'chart' ? active : tabs.find((t) => t.type === 'chart')

  if (!chartTab) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-zinc-950 p-8 text-center">
        <p className="text-sm text-zinc-400">No chart tab in this layout yet.</p>
        <button
          className="rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 active:bg-emerald-400"
          onClick={() => addTab('chart')}
        >
          <span className="flex items-center gap-1.5"><Plus className="h-4 w-4" /> Create chart</span>
        </button>
      </div>
    )
  }

  const panes = tabPanes(chartTab)
  const paneIdx = Math.min(chartTab.focusedPane ?? 0, panes.length - 1)
  const pane = panes[paneIdx]
  const tfLabel = TIMEFRAMES[pane.timeframe]?.label ?? pane.timeframe
  // extended hours only make sense for stocks on intraday timeframes
  const ethApplies = !isCryptoSymbol(pane.symbol) && (TIMEFRAMES[pane.timeframe]?.seconds ?? 86400) < 86400

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-zinc-950">
      <div className="min-h-0 flex-1">
        <ChartPanel
          symbol={pane.symbol}
          timeframe={pane.timeframe}
          chartType={pane.chartType}
          onSymbolChange={(s) => setPaneSymbol(chartTab.id, paneIdx, s)}
          onTimeframeChange={(tf) => setPaneTimeframe(chartTab.id, paneIdx, tf)}
          onChartTypeChange={(t) => setPaneChartType(chartTab.id, paneIdx, t)}
          syncKey={`m:${chartTab.id}`}
          syncGroup={null}
        />
      </div>

      {/* active drawing tool chip — mobile-only confirmation of the tool the
          draw sheet armed (desktop shows it in the left toolbar instead) */}
      {drawingTool !== 'cursor' && (
        <div className="absolute left-1/2 top-12 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-emerald-500/40 bg-zinc-900/95 py-1.5 pl-3 pr-1.5 text-xs font-medium text-emerald-400 shadow-lg backdrop-blur sm:hidden">
          <Pencil className="h-3 w-3" aria-hidden />
          {TOOL_LABEL[drawingTool] ?? drawingTool}
          <button
            onClick={() => setDrawingTool('cursor')}
            aria-label="Back to cursor tool"
            className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* ---- floating bottom toolbar (clone of the dump's TSLA | 1H | ✏ | ƒx | ⋯) ---- */}
      <div
        className="absolute inset-x-2 bottom-2 z-40 flex items-center gap-0.5 rounded-xl border border-zinc-800/90 bg-zinc-900/90 p-1 shadow-xl backdrop-blur-md"
        style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
        role="toolbar"
        aria-label="Chart actions"
      >
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('tt:open-symbol-search'))}
          className="flex h-10 min-w-0 shrink items-center gap-1 rounded-lg px-3 text-sm font-semibold text-zinc-100 active:bg-zinc-800"
          aria-label={`Change symbol — current ${pane.symbol}`}
        >
          <span className="truncate">{pane.symbol}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        </button>
        <button
          onClick={() => setTfOpen(true)}
          className="flex h-10 shrink-0 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-emerald-400 active:bg-zinc-800"
          aria-label={`Change timeframe — current ${tfLabel}`}
        >
          {tfLabel}
          <ChevronDown className="h-3.5 w-3.5 text-emerald-500/60" />
        </button>
        <div className="mx-0.5 h-6 w-px shrink-0 bg-zinc-800" aria-hidden />
        <button
          onClick={() => setDrawOpen(true)}
          aria-label="Drawing tools"
          aria-pressed={drawingTool !== 'cursor'}
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg active:bg-zinc-800',
            drawingTool !== 'cursor' ? 'text-emerald-400' : 'text-zinc-300',
          )}
        >
          <Pencil className="h-[18px] w-[18px]" />
        </button>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('tt:toggle-indicators'))}
          aria-label="Indicators"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-300 active:bg-zinc-800"
        >
          <Sigma className="h-[18px] w-[18px]" />
        </button>
        <div className="ml-auto" aria-hidden />
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('tt:open-ticket'))}
          aria-label="Open trade ticket"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-emerald-400 active:bg-zinc-800"
        >
          <Briefcase className="h-[18px] w-[18px]" />
        </button>
        <button
          onClick={() => {
            setGridUi(loadGridUi()) // re-sync in case the panel remounted
            setMoreOpen(true)
          }}
          aria-label="More chart actions"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-300 active:bg-zinc-800"
        >
          <Ellipsis className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* ---- timeframe sheet ---- */}
      <Dialog open={tfOpen} onOpenChange={setTfOpen}>
        <DialogContent className="max-w-xs border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-base text-zinc-100">Timeframe</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-4 gap-2" role="group" aria-label="Timeframes">
            {(Object.keys(TIMEFRAMES) as Timeframe[]).map((k) => (
              <button
                key={k}
                onClick={() => {
                  setPaneTimeframe(chartTab.id, paneIdx, k)
                  setTfOpen(false)
                }}
                aria-pressed={k === pane.timeframe}
                className={cn(
                  'h-11 rounded-lg border text-sm font-semibold transition-colors',
                  k === pane.timeframe
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-300 active:bg-zinc-800',
                )}
              >
                {TIMEFRAMES[k].label}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- drawing tools sheet ---- */}
      <Dialog open={drawOpen} onOpenChange={setDrawOpen}>
        <DialogContent className="max-w-xs border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-base text-zinc-100">Drawing tools</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-4 gap-2" role="group" aria-label="Drawing tools">
            {TOOLS.map(({ id, label, icon: Icon, hint }) => (
              <button
                key={id}
                title={hint}
                aria-pressed={drawingTool === id}
                onClick={() => {
                  setDrawingTool(id)
                  setDrawOpen(false)
                }}
                className={cn(
                  'flex h-14 flex-col items-center justify-center gap-1 rounded-lg border text-[10px] font-medium transition-colors',
                  drawingTool === id
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-400'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 active:bg-zinc-800',
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-zinc-800 pt-2" role="group" aria-label="Drawing color">
            <span className="text-xs text-zinc-500">Color</span>
            <div className="flex items-center gap-2.5">
              {DRAW_COLORS.map((c) => (
                <button
                  key={c}
                  aria-label={`Set drawing color ${c}`}
                  onClick={() => window.dispatchEvent(new CustomEvent('tt:set-color', { detail: c }))}
                  className="h-5 w-5 rounded-full transition-transform active:scale-125"
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---- more actions sheet ---- */}
      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent className="max-w-xs border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-base text-zinc-100">More</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-2">
              <span className="text-xs text-zinc-500">Chart type</span>
              <div className="flex items-center gap-1" role="group" aria-label="Chart type">
                <button
                  aria-pressed={(pane.chartType ?? 'candles') === 'candles'}
                  aria-label="Candlesticks"
                  onClick={() => window.dispatchEvent(new CustomEvent('tt:set-chart-type', { detail: 'candles' }))}
                  className={cn(
                    'flex h-9 w-14 items-center justify-center rounded-md',
                    (pane.chartType ?? 'candles') === 'candles' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500',
                  )}
                >
                  <CandlestickIcon className="h-4 w-4" />
                </button>
                <button
                  aria-pressed={pane.chartType === 'line'}
                  aria-label="Line"
                  onClick={() => window.dispatchEvent(new CustomEvent('tt:set-chart-type', { detail: 'line' }))}
                  className={cn(
                    'flex h-9 w-14 items-center justify-center rounded-md',
                    pane.chartType === 'line' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500',
                  )}
                >
                  <LineChartIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            <button
              onClick={() => {
                setMoreOpen(false)
                window.dispatchEvent(new CustomEvent('tt:open-sr'))
              }}
              className="flex h-11 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 active:bg-zinc-800"
            >
              <AlignHorizontalJustifyCenter className="h-4 w-4 text-emerald-400" aria-hidden />
              Auto S/R lines
              <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500">
                <span className="h-2 w-2 rounded-full bg-[#ef4444]" aria-hidden />1D
                <span className="h-2 w-2 rounded-full bg-[#f59e0b]" aria-hidden />4H
                <span className="h-2 w-2 rounded-full bg-[#22c55e]" aria-hidden />1H
              </span>
            </button>
            <button
              onClick={() => {
                setMoreOpen(false)
                window.dispatchEvent(new CustomEvent('tt:open-advisor'))
              }}
              className="flex h-11 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 active:bg-zinc-800"
            >
              <Lightbulb className="h-4 w-4 text-amber-400" aria-hidden />
              Trade Advisor
              <span className="ml-auto text-[10px] text-zinc-500">S/R + fib plan</span>
            </button>
            {ethApplies && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('tt:toggle-eth'))}
                aria-pressed={showExtendedHours}
                className="flex h-11 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 active:bg-zinc-800"
              >
                <Clock className="h-4 w-4 text-emerald-400" aria-hidden />
                Extended trading hours
                <span
                  className={cn(
                    'ml-auto rounded border px-1.5 py-0.5 text-[10px] font-semibold',
                    showExtendedHours
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-500',
                  )}
                >
                  {showExtendedHours ? 'ON' : 'OFF'}
                </span>
              </button>
            )}

            {/* ---- Grid trades on chart (v1.87.0) — mirrors the desktop drawing
                toolbar's Grid3x3 overlay toggle + Layers shadow popover, which
                are hidden below 640px. State lives in ChartPanel; commands go
                out as tt:toggle-grid-overlay / tt:set-grid-band events and the
                panel broadcasts tt:grid-ui-changed back. Choice persists. ---- */}
            <div
              className="rounded-lg border border-zinc-800 bg-zinc-950 p-1"
              role="group"
              aria-label="Grid trades on chart"
            >
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('tt:toggle-grid-overlay'))}
                aria-pressed={gridUi.overlay}
                className="flex h-11 w-full items-center gap-2 rounded-md px-2 text-sm text-zinc-200 active:bg-zinc-800"
              >
                <Grid3x3 className="h-4 w-4 text-emerald-400" aria-hidden />
                <span className="min-w-0 flex-1 text-left">Grid trades on chart</span>
                <span
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[10px] font-semibold',
                    gridUi.overlay
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-500',
                  )}
                >
                  {gridUi.overlay ? 'ON' : 'OFF'}
                </span>
              </button>
              {gridUi.overlay && (
                <button
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent('tt:set-grid-band', { detail: { on: !gridUi.bandOn } }))
                  }
                  aria-pressed={gridUi.bandOn}
                  className="flex h-11 w-full items-center gap-2 rounded-md px-2 text-sm text-zinc-200 active:bg-zinc-800"
                >
                  <Layers className="h-4 w-4 text-sky-400" aria-hidden />
                  <span className="min-w-0 flex-1 text-left">Range shadow</span>
                  <span
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[10px] font-semibold',
                      gridUi.bandOn
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-500',
                    )}
                  >
                    {gridUi.bandOn ? 'ON' : 'OFF'}
                  </span>
                </button>
              )}
              {gridUi.overlay && gridUi.bandOn && (
                <div className="px-2 pb-2 pt-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500">Shadow opacity</span>
                    <span className="text-xs tabular-nums text-zinc-300">{Math.round(gridUi.opacity * 100)}%</span>
                  </div>
                  <Slider
                    value={[Math.round(gridUi.opacity * 100)]}
                    min={0}
                    max={50}
                    step={5}
                    onValueChange={(vals) => {
                      const v = Array.isArray(vals) ? vals[0] : vals
                      if (typeof v === 'number' && isFinite(v)) {
                        window.dispatchEvent(new CustomEvent('tt:set-grid-band', { detail: { opacity: v / 100 } }))
                      }
                    }}
                    aria-label="Grid range shadow opacity"
                    className="mt-2.5"
                  />
                  <div className="mt-1 flex justify-between text-[9px] text-zinc-600"><span>0%</span><span>50%</span></div>
                  <p className="mt-1 text-[10px] leading-4 text-zinc-600">
                    Shades each active grid's price range while Grid trades is on — tinted per direction: emerald / buy sky / sell violet.
                  </p>
                </div>
              )}
            </div>

            <button
              onClick={() => {
                setMoreOpen(false)
                onOpenWatchlist()
              }}
              className="flex h-11 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 active:bg-zinc-800"
            >
              <ChevronDown className="h-4 w-4 -rotate-90 text-zinc-500" aria-hidden />
              Back to watchlist
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
