'use client'

// Grid Trading tab (Task 9-q, extended by Task 10-b/10-f/10-l) — tracks every
// grid trade: live status, total realized/unrealized P&L, grid start time and
// per-fill history. Grids are created from the chart's two-click "Grid" range
// tool; this tab is the mission control (stop / edit-when-flat / inspect /
// delete / export-import setups / export-import ALL setups as a bundle).
// Polls every 5s like the Algo tab.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LayoutGrid, RefreshCw, Square, Trash2, Info, Loader2, CircleAlert, Pencil,
  Download, Upload, Copy, Sparkles, Pause, Play,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTerminal } from '@/store/terminal'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmtPrice } from '@/lib/market-types'
import GridTradeDialog from '@/components/chart/GridTradeDialog'
import { gridSetupFromRow, downloadGridSetup, buildGridSetupBundle, downloadGridSetupBundle } from '@/lib/grid-setup'
import GridBundleImportDialog from './GridBundleImportDialog'
import GridAutoDialog from './GridAutoDialog'
import { tabPanes, type Tab } from '@/store/terminal'
import type { GridTradeDto, GridFillDto, GridAutoPlanDto } from '@/app/api/grid/route'

/** API rows gain slBasis/tpBasis ('price'|'percent') via Task 10-a — treat as
 * optional strings so pre-10-a rows (and the base DTO type) keep working. */
type GridRow = GridTradeDto & { slBasis?: string | null; tpBasis?: string | null }

/** Percent → display without trailing zeros (5 → "5", 5.25 → "5.25"). */
const trimNum = (n: number) => String(Number(n.toFixed(2)))

/** Resolve a percent-basis SL/TP exactly like the server/engine does:
 * SL trigger = lower × (1 − pct/100), TP trigger = upper × (1 + pct/100). */
const resolveTrigger = (bound: number, pct: number, kind: 'sl' | 'tp') =>
  Math.round((kind === 'sl' ? bound * (1 - pct / 100) : bound * (1 + pct / 100)) * 100) / 100

const STATUS_CLS: Record<string, string> = {
  active: 'border-emerald-500/40 text-emerald-400',
  paused: 'border-amber-500/40 text-amber-400',
  stopped: 'border-zinc-700 text-zinc-400',
  error: 'border-rose-500/40 text-rose-400',
}

const pnlCls = (v: number | null | undefined) =>
  v == null ? 'text-zinc-500' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-400'

const signed = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "3m ago" style relative time (coarse — minutes/hours/days). */
function rel(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m ago`
  return `${Math.floor(h / 24)}d ago`
}

/** 12345 → "3h 25m" (engine uptime). */
function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const REASON_LABEL: Record<string, string> = {
  grid: 'grid',
  tp: 'TP',
  sl: 'max SL',
  maxtp: 'max TP',
  manual_close: 'manual',
  auto_end: 'auto end',
}

interface GridData {
  grids: GridRow[]
}

/** Mirror ChartWorkspace.focusedPaneSymbol — the symbol the "Import setup"
 * flow targets (the imported grid runs on the currently focused chart). */
function focusedSymbol(tab: Tab | null): string {
  if (!tab) return ''
  const panes = tabPanes(tab)
  const idx = Math.min(tab.focusedPane ?? 0, panes.length - 1)
  return panes[idx]?.symbol ?? tab.symbol
}

export default function GridTab() {
  const { toast } = useToast()
  const [data, setData] = useState<GridData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [stopTarget, setStopTarget] = useState<GridRow | null>(null)
  // edit-when-flat (Task 10-b): the grid being reconfigured in-place
  const [editTarget, setEditTarget] = useState<GridRow | null>(null)
  // details dialog: the grid id + its fetched fills
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ grid: GridTradeDto; fills: GridFillDto[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // setup import (Task 10-f): opens the create dialog with the import panel
  // expanded — the setup JSON fills the form there (paste or file). When the
  // applied setup names its own symbol, the new grid retargets to it
  // (importSymbol) instead of the focused chart's symbol.
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importSymbol, setImportSymbol] = useState<string | null>(null)
  // Task 10-l — ALL-setups bundle import (file/paste → preview → bulk start)
  const [bundleImportOpen, setBundleImportOpen] = useState(false)
  // Task 18 — Auto Grid watchlist scan + start dialog
  const [autoOpen, setAutoOpen] = useState(false)
  const activeTab = useTerminal(useShallow((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null))
  const chartSymbol = useMemo(() => focusedSymbol(activeTab), [activeTab])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/grid')
      if (res.ok) setData((await res.json()) as GridData)
    } catch { /* offline — keep the last snapshot */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load])

  const openDetails = async (id: string) => {
    setDetailId(id)
    setDetail(null)
    setDetailLoading(true)
    try {
      const res = await fetch(`/api/grid/${id}`)
      if (res.ok) setDetail((await res.json()) as { grid: GridTradeDto; fills: GridFillDto[] })
    } catch { /* keep skeleton */ }
    finally { setDetailLoading(false) }
  }

  const stop = async (grid: GridRow) => {
    setBusyId(grid.id)
    try {
      const res = await fetch(`/api/grid/${grid.id}/stop`, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        // a retried close on an error grid can fail AGAIN (status stays
        // 'error') — surface that honestly instead of "Grid stopped"
        if (json?.grid?.status === 'error') {
          toast({ title: `Close retry failed — ${grid.symbol}`, description: json?.grid?.stopReason || undefined, variant: 'destructive' })
        } else {
          toast({ title: `Grid stopped — ${grid.symbol}`, description: json?.grid?.stopReason || undefined })
        }
      } else {
        toast({ title: 'Could not stop grid', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Could not stop grid', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusyId(null)
      setStopTarget(null)
      void load()
    }
  }

  /** Task 18 — suspend (pause) / resume a grid. The engine only evaluates
   *  status 'active' rows, so pause = full freeze (no orders, no guards). */
  const pauseResume = async (grid: GridRow, action: 'pause' | 'resume') => {
    setBusyId(grid.id)
    try {
      const res = await fetch(`/api/grid/${grid.id}/${action}`, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({
          title: action === 'pause' ? `Grid suspended — ${grid.symbol}` : `Grid resumed — ${grid.symbol}`,
          description: action === 'pause'
            ? 'The engine freezes it (no orders, no guard checks) until you resume.'
            : 'The next engine tick picks it up with its open lots intact.',
        })
      } else {
        toast({
          title: action === 'pause' ? 'Could not suspend grid' : 'Could not resume grid',
          description: json?.error || `HTTP ${res.status}`,
          variant: 'destructive',
        })
      }
    } catch {
      toast({
        title: action === 'pause' ? 'Could not suspend grid' : 'Could not resume grid',
        description: 'Network error',
        variant: 'destructive',
      })
    } finally {
      setBusyId(null)
      void load()
    }
  }

  const remove = async (grid: GridRow) => {
    setBusyId(grid.id)
    try {
      const res = await fetch(`/api/grid/${grid.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: `Grid deleted — ${grid.symbol}` })
      } else {
        toast({ title: 'Could not delete grid', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Could not delete grid', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusyId(null)
      void load()
    }
  }

  /** Copy a grid's config to the clipboard as a portable setup JSON. */
  const copySetup = async (grid: GridRow) => {
    const json = JSON.stringify(gridSetupFromRow(grid), null, 2)
    try {
      await navigator.clipboard.writeText(json)
      toast({ title: 'Setup copied', description: `${grid.symbol} grid config is on the clipboard` })
    } catch {
      toast({ title: 'Could not copy', description: 'Clipboard unavailable — use Download instead', variant: 'destructive' })
    }
  }

  /** Task 10-l — copy EVERY grid's config to the clipboard as one bundle. */
  const copyAllSetups = async () => {
    const json = JSON.stringify(buildGridSetupBundle(grids), null, 2)
    try {
      await navigator.clipboard.writeText(json)
      toast({ title: 'Bundle copied', description: `${grids.length} grid setup${grids.length === 1 ? '' : 's'} on the clipboard` })
    } catch {
      toast({ title: 'Could not copy', description: 'Clipboard unavailable — use Download instead', variant: 'destructive' })
    }
  }

  const grids = data?.grids ?? []
  const active = grids.filter((g) => g.status === 'active')
  const totalRealized = grids.reduce((acc, g) => acc + g.realizedPnl, 0)
  const openLots = grids.reduce((acc, g) => acc + g.stats.openLots, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
        <LayoutGrid className="h-4 w-4 text-emerald-400" aria-hidden />
        <span className="text-sm font-semibold text-zinc-100">Grid Trading</span>
        <Badge variant="outline" className={cn('text-[10px]', active.length > 0 ? 'border-emerald-500/40 text-emerald-400' : 'border-zinc-700 text-zinc-400')}>
          {active.length} active
        </Badge>
        <Badge variant="outline" className={cn('text-[10px] tabular-nums', totalRealized > 0 ? 'border-emerald-500/40 text-emerald-400' : totalRealized < 0 ? 'border-rose-500/40 text-rose-400' : 'border-zinc-700 text-zinc-400')}>
          realized {signed(totalRealized)}
        </Badge>
        <Badge variant="outline" className="text-[10px] text-zinc-400">
          {openLots} open lot{openLots === 1 ? '' : 's'}
        </Badge>
        <span className="ml-auto text-[11px] text-zinc-500">engine tick every 5s · paper orders</span>
        {/* Task 18 — one-click Auto Grid: scan a watchlist, start the winners */}
        <Button
          size="sm"
          className="h-7 gap-1.5 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-500"
          onClick={() => setAutoOpen(true)}
          title="Scan a watchlist and auto-start the symbols where a grid backtests profitably — full reasons + setups shown"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Auto grid
        </Button>
        {/* Task 10-l — one-click export of ALL grid setups as one bundle */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost" size="sm"
              className="h-7 gap-1.5 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
              disabled={grids.length === 0}
              title="Export EVERY grid's config as one bundle (JSON) — re-importable anywhere via Import all"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Export all
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900 text-xs text-zinc-200">
            <DropdownMenuItem className="gap-1.5" onClick={() => downloadGridSetupBundle(buildGridSetupBundle(grids))}>
              <Download className="h-3 w-3" aria-hidden /> Download bundle .json
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-1.5" onClick={() => void copyAllSetups()}>
              <Copy className="h-3 w-3" aria-hidden /> Copy bundle JSON
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost" size="sm"
          className="h-7 gap-1.5 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
          onClick={() => setBundleImportOpen(true)}
          title="Import a bundle of grid setups (JSON) — starts every valid setup as its own grid"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden />
          Import all
        </Button>
        <Button
          variant="ghost" size="sm"
          className="h-7 gap-1.5 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
          onClick={() => setImportDialogOpen(true)}
          title="Import a saved grid setup (JSON) — opens the config dialog with the import panel expanded"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden />
          Import setup
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-zinc-100" onClick={() => void load()} aria-label="Refresh grid trades">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-md bg-zinc-900" />
          ))}
        </div>
      )}

      {/* empty state */}
      {!loading && grids.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 p-8 text-center">
          <LayoutGrid className="h-8 w-8 text-zinc-600" aria-hidden />
          <p className="max-w-md text-sm text-zinc-400">
            No grid trades yet — open a chart, click the <span className="text-zinc-200">Grid tool</span>, then click two price levels to define the range.
          </p>
        </div>
      )}

      {/* grids list (long-list hygiene: capped + scrollable) */}
      {!loading && grids.length > 0 && (
        <div className="terminal-scroll max-h-[70vh] min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
          {grids.map((g) => {
            const isActive = g.status === 'active'
            const isPaused = g.status === 'paused'
            const openLotsG = g.stats.openLots
            return (
              <div key={g.id} className="flex flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
                  <span
                    className={cn('inline-block h-2 w-2 shrink-0 rounded-full', isActive ? 'animate-pulse bg-emerald-400' : isPaused ? 'bg-amber-400' : g.status === 'error' ? 'bg-rose-500' : 'bg-zinc-600')}
                    title={g.status}
                    aria-hidden
                  />
                  <span className="text-sm font-semibold text-zinc-100">{g.symbol}</span>
                  <Badge variant="outline" className={cn('text-[10px]', STATUS_CLS[g.status] ?? 'border-zinc-700 text-zinc-400')}>
                    {g.status}
                  </Badge>
                  {g.auto && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-violet-500/40 text-violet-400"
                      title="Created by the Auto Grid watchlist scan — see Details for the reason + end conditions"
                    >
                      AUTO
                    </Badge>
                  )}
                  <span className="font-medium tabular-nums text-zinc-300">{fmtPrice(g.lowerPrice)} – {fmtPrice(g.upperPrice)}</span>
                  <Badge variant="outline" className="text-[10px] text-zinc-500">
                    {g.gridCount} levels · {g.spacing}
                  </Badge>
                  {g.direction === 'buy' && (
                    <Badge variant="outline" className="text-[10px] text-sky-400/90" title="Buy-only ladder — buys every level as price falls, no auto-sells">
                      BUY ONLY
                    </Badge>
                  )}
                  {g.direction === 'sell' && (
                    <Badge variant="outline" className="text-[10px] text-violet-400/90" title="Sell-only ladder — sells every level as price rises; a close buys the lots back">
                      SELL ONLY
                    </Badge>
                  )}
                  <span className="tabular-nums text-zinc-500">qty {g.qtyPerGrid}/grid</span>
                  {g.maxSL != null && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-rose-400/90"
                      title={g.slBasis === 'percent' ? 'percent of the lower bound' : 'absolute price'}
                    >
                      {g.slBasis === 'percent'
                        ? `SL ${trimNum(g.maxSL)}% (≈${fmtPrice(resolveTrigger(g.lowerPrice, g.maxSL, 'sl'))})`
                        : `SL ${fmtPrice(g.maxSL)}`}
                    </Badge>
                  )}
                  {g.maxTP != null && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-emerald-400/90"
                      title={g.tpBasis === 'percent' ? 'percent of the upper bound' : 'absolute price'}
                    >
                      {g.tpBasis === 'percent'
                        ? `TP ${trimNum(g.maxTP)}% (≈${fmtPrice(resolveTrigger(g.upperPrice, g.maxTP, 'tp'))})`
                        : `TP ${fmtPrice(g.maxTP)}`}
                    </Badge>
                  )}
                  {isActive && g.stats.currentPrice != null && (
                    <span className="tabular-nums text-zinc-400" title="current price">now {fmtPrice(g.stats.currentPrice)}</span>
                  )}
                  {openLotsG > 0 && (
                    <span className="tabular-nums text-amber-400/90" title="open grid lots">
                      {openLotsG} lot{openLotsG === 1 ? '' : 's'} ({g.stats.openQty})
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums">
                    <span className="text-zinc-500">
                      fills <span className="font-semibold text-zinc-300">{g.stats.buys}B</span>/<span className="font-semibold text-zinc-300">{g.stats.sells}S</span>
                    </span>
                    <span className={pnlCls(g.realizedPnl)} title="realized P/L">R {signed(g.realizedPnl)}</span>
                    <span className={pnlCls(g.stats.unrealizedPnl)} title="unrealized P/L of open lots">U {signed(g.stats.unrealizedPnl)}</span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800/60 px-3 py-1.5 text-[11px] text-zinc-500">
                  <span title={fmtClock(g.startedAt)}>started {rel(g.startedAt)}</span>
                  <span>· running {fmtDuration(g.stats.durationSec)}</span>
                  {g.autoEndAt && (isActive || isPaused) && (
                    <span className="text-violet-400/90" title={`Planned auto end: ${fmtClock(g.autoEndAt)} — the engine stops (and closes per close-on-stop) at this time`}>
                      · ends {fmtClock(g.autoEndAt)}
                    </span>
                  )}
                  {g.stoppedAt && <span title={fmtClock(g.stoppedAt)}>· stopped {rel(g.stoppedAt)}</span>}
                  {g.stopReason && (
                    <span className={cn('flex items-start gap-1', g.status === 'error' ? 'text-rose-400' : 'text-amber-400/90')}>
                      <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      {g.stopReason}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-0.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost" size="sm"
                          className="h-6 gap-1 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                          disabled={busyId === g.id}
                          title="Export this grid's config as a reusable setup (JSON) — no runtime state, just the range/levels/size/guards"
                        >
                          <Download className="h-3 w-3" /> Export
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900 text-xs text-zinc-200">
                        <DropdownMenuItem className="gap-1.5" onClick={() => downloadGridSetup(gridSetupFromRow(g))}>
                          <Download className="h-3 w-3" aria-hidden /> Download .json
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-1.5" onClick={() => void copySetup(g)}>
                          <Copy className="h-3 w-3" aria-hidden /> Copy JSON
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {isActive && openLotsG === 0 && (
                      <Button
                        variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-zinc-400 hover:text-emerald-300"
                        disabled={busyId === g.id}
                        onClick={() => setEditTarget(g)}
                        title="Edit this grid's config — only while it holds no open lots"
                      >
                        <Pencil className="h-3 w-3" /> Edit
                      </Button>
                    )}
                    {isActive && (
                      <Button
                        variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-amber-400 hover:text-amber-300"
                        disabled={busyId === g.id}
                        onClick={() => void pauseResume(g, 'pause')}
                        title="Suspend this grid — the engine freezes it (no orders, no guard checks) until you resume"
                      >
                        {busyId === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />} Suspend
                      </Button>
                    )}
                    {isPaused && (
                      <Button
                        variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-emerald-400 hover:text-emerald-300"
                        disabled={busyId === g.id}
                        onClick={() => void pauseResume(g, 'resume')}
                        title="Resume this suspended grid — the next engine tick continues with its open lots intact"
                      >
                        {busyId === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Resume
                      </Button>
                    )}
                    {(isActive || isPaused || (g.status === 'error' && openLotsG > 0)) && (
                      <Button
                        variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-rose-400 hover:text-rose-300"
                        disabled={busyId === g.id}
                        onClick={() => setStopTarget(g)}
                        title={g.status === 'error'
                          ? 'Retry the close — the close qty is sized from the live broker balance (fees can make it smaller than the tracked lots)'
                          : 'Stop this grid (respects its close-on-stop setting)'}
                      >
                        {busyId === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />} Stop
                      </Button>
                    )}
                    {!isActive && !(g.status === 'error' && openLotsG > 0) && (
                      <Button
                        variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-zinc-500 hover:text-rose-300"
                        disabled={busyId === g.id}
                        onClick={() => void remove(g)}
                        title="Delete this grid and its fill history"
                      >
                        <Trash2 className="h-3 w-3" /> Delete
                      </Button>
                    )}
                    <Button
                      variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                      onClick={() => void openDetails(g.id)}
                      title="Statistics + fill history"
                    >
                      <Info className="h-3 w-3" /> Details
                    </Button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Task 10-l — bundle import: file/paste → per-item preview →
          POST /api/grid/bulk starts every valid setup in one call */}
      <GridBundleImportDialog
        open={bundleImportOpen}
        onOpenChange={setBundleImportOpen}
        onImported={() => void load()}
      />

      {/* Task 18 — Auto Grid: watchlist scan → per-symbol reasons → start */}
      <GridAutoDialog open={autoOpen} onOpenChange={setAutoOpen} onStarted={() => void load()} />

      {/* setup import (Task 10-f) — opens the create dialog with the import
          panel expanded; the applied setup retargets the new grid to its own
          symbol via onApplySymbol (falls back to the focused chart's symbol) */}
      {importDialogOpen && (
        <GridTradeDialog
          open
          onOpenChange={(v) => { if (!v) { setImportDialogOpen(false); setImportSymbol(null) } }}
          symbol={(importSymbol ?? chartSymbol) || 'BTC/USD'}
          lowerPrice={0}
          upperPrice={0}
          openWithImport
          onApplySymbol={(s) => setImportSymbol(s)}
          onSaved={() => void load()}
        />
      )}

      {/* edit-when-flat (Task 10-b) — reuses the create dialog in edit mode;
          the engine reconfigures the still-running grid on a successful PUT */}
      {editTarget && (
        <GridTradeDialog
          open
          onOpenChange={(v) => { if (!v) setEditTarget(null) }}
          symbol={editTarget.symbol}
          lowerPrice={editTarget.lowerPrice}
          upperPrice={editTarget.upperPrice}
          editGrid={editTarget}
          onSaved={() => void load()}
        />
      )}

      {/* stop confirmation — spell out what closeOnStop will do */}
      <AlertDialog open={stopTarget != null} onOpenChange={(o) => { if (!o) setStopTarget(null) }}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-zinc-100">Stop grid {stopTarget?.symbol}?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              {stopTarget?.closeOnStop
                ? 'Close-on-stop is ON — all open grid positions will be market-closed when the engine stops the grid.'
                : 'Close-on-stop is OFF — the engine stops but leaves the open grid positions running. Manage them manually in Positions.'}
              {stopTarget && stopTarget.stats.openLots === 0 && ' This grid currently holds no open lots.'}
              {stopTarget?.status === 'error' && ' This grid previously FAILED to close its lots — stopping retries the close with the qty sized from the live broker balance.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={() => { if (stopTarget) void stop(stopTarget) }}
            >
              Stop grid
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* details dialog — stats grid + fill history */}
      <Dialog open={detailId != null} onOpenChange={(o) => { if (!o) setDetailId(null) }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl gap-3 border-zinc-800 bg-zinc-900 p-5 text-zinc-100">
          <DialogHeader className="space-y-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <LayoutGrid className="h-4 w-4 text-emerald-400" aria-hidden />
              Grid details {detail ? <span className="text-emerald-400">{detail.grid.symbol}</span> : null}
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-400">
              {detail
                ? `${detail.grid.direction === 'buy' ? 'BUY ONLY · ' : detail.grid.direction === 'sell' ? 'SELL ONLY · ' : ''}${detail.grid.gridCount} levels · ${detail.grid.spacing} · ${fmtPrice(detail.grid.lowerPrice)}–${fmtPrice(detail.grid.upperPrice)} · qty ${detail.grid.qtyPerGrid}/grid`
                : 'Loading…'}
            </DialogDescription>
          </DialogHeader>

          {detailLoading && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded bg-zinc-900" />)}
            </div>
          )}

          {detail && (
            <>
              {/* Task 18 — auto-grid plan: why the scan started it + end conditions */}
              {detail.grid.auto && detail.grid.autoPlan && (() => {
                const ap = detail.grid.autoPlan as GridAutoPlanDto & { reason?: string; details?: string[] }
                const bt = ap.backtest
                return (
                  <div className="rounded border border-violet-500/30 bg-violet-500/5 p-2.5">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300">
                      <Sparkles className="h-3 w-3" aria-hidden /> Auto Grid — why this started
                    </p>
                    {ap.reason && <p className="mt-1 text-[11px] leading-snug text-zinc-200">{ap.reason}</p>}
                    {ap.details && ap.details.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[10px] leading-snug text-zinc-500">
                        {ap.details.map((d, i) => <li key={i}>· {d}</li>)}
                      </ul>
                    )}
                    <p className="mt-1.5 text-[10px] leading-snug text-zinc-400">
                      Ends: SL {fmtPrice(ap.slTriggerApprox)} (−{ap.maxSLPct}% below lower) · TP {fmtPrice(ap.tpTriggerApprox)} (+{ap.maxTPPct}% above upper)
                      {detail.grid.autoEndAt ? ` · or on ${fmtClock(detail.grid.autoEndAt)} (planned end)` : ''}
                      {' · '}{ap.preset} preset · {ap.windowDays}d window
                    </p>
                    {bt && (
                      <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">
                        Backtest evidence: score {bt.score} · P/L {signed(bt.totalPnl)} · max DD {bt.maxDrawdown} · {bt.fillsCount} fills · drift {ap.trendPct > 0 ? '+' : ''}{ap.trendPct}% · {ap.crossovers} midline crossings
                      </p>
                    )}
                  </div>
                )
              })()}
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Total P/L</p>
                  <p className={cn('text-sm font-semibold tabular-nums', pnlCls(detail.grid.stats.totalPnl))}>
                    {signed(detail.grid.stats.totalPnl)}
                  </p>
                </div>
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Realized</p>
                  <p className={cn('text-sm font-semibold tabular-nums', pnlCls(detail.grid.realizedPnl))}>{signed(detail.grid.realizedPnl)}</p>
                </div>
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Unrealized</p>
                  <p className={cn('text-sm font-semibold tabular-nums', pnlCls(detail.grid.stats.unrealizedPnl))}>{signed(detail.grid.stats.unrealizedPnl)}</p>
                </div>
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Sell win rate</p>
                  <p className="text-sm font-semibold tabular-nums text-zinc-200">
                    {detail.grid.stats.winRate != null ? `${detail.grid.stats.winRate.toFixed(0)}%` : '—'}
                  </p>
                </div>
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Best level</p>
                  <p className="text-sm font-semibold tabular-nums text-emerald-400">
                    {detail.grid.stats.bestLevel ? `#${detail.grid.stats.bestLevel.levelIndex + 1} ${signed(detail.grid.stats.bestLevel.pnl)}` : '—'}
                  </p>
                </div>
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Worst level</p>
                  <p className="text-sm font-semibold tabular-nums text-rose-400">
                    {detail.grid.stats.worstLevel ? `#${detail.grid.stats.worstLevel.levelIndex + 1} ${signed(detail.grid.stats.worstLevel.pnl)}` : '—'}
                  </p>
                </div>
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Fills</p>
                  <p className="text-sm font-semibold tabular-nums text-zinc-200">{detail.grid.stats.fillsCount}</p>
                </div>
                <div className="rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Open lots</p>
                  <p className="text-sm font-semibold tabular-nums text-zinc-200">
                    {detail.grid.stats.openLots}
                    {detail.grid.stats.openNotional != null && <span className="ml-1 text-[10px] font-normal text-zinc-500">{fmtPrice(detail.grid.stats.openNotional)}</span>}
                  </p>
                </div>
              </div>

              {/* fill history */}
              <div className="terminal-scroll max-h-96 overflow-y-auto rounded border border-zinc-800/70">
                <table className="w-full text-left text-[11px] tabular-nums">
                  <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Time</th>
                      <th className="px-2 py-1.5 font-medium">Side</th>
                      <th className="px-2 py-1.5 font-medium">Reason</th>
                      <th className="px-2 py-1.5 font-medium">Level</th>
                      <th className="px-2 py-1.5 text-right font-medium">Price</th>
                      <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                      <th className="px-2 py-1.5 text-right font-medium">P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.fills.length === 0 && (
                      <tr><td colSpan={7} className="px-2 py-4 text-center text-zinc-500">No fills yet — the engine buys when price crosses below a level.</td></tr>
                    )}
                    {detail.fills.map((f) => (
                      <tr key={f.id} className="border-t border-zinc-800/60 text-zinc-300">
                        <td className="px-2 py-1.5 text-zinc-500">{new Date(f.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                        <td className={cn('px-2 py-1.5 font-semibold', f.side === 'buy' ? 'text-sky-400' : 'text-violet-400')}>{f.side.toUpperCase()}</td>
                        <td className="px-2 py-1.5 text-zinc-400">{REASON_LABEL[f.reason] ?? f.reason}</td>
                        <td className="px-2 py-1.5 text-zinc-400" title={f.note ?? undefined}>
                          {f.levelIndex >= 0 ? `#${f.levelIndex + 1}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right">{fmtPrice(f.price)}</td>
                        <td className="px-2 py-1.5 text-right">{f.qty}</td>
                        <td className={cn('px-2 py-1.5 text-right', f.pnl != null ? pnlCls(f.pnl) : 'text-zinc-600')}>
                          {f.pnl != null ? signed(f.pnl) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
