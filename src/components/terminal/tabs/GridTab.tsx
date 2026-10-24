'use client'

// Grid Trading tab (Task 9-q) — tracks every grid trade: live status, total
// realized/unrealized P&L, grid start time and per-fill history. Grids are
// created from the chart's two-click "Grid" range tool; this tab is the
// mission control (stop / inspect / delete). Polls every 5s like the Algo tab.
import { useCallback, useEffect, useState } from 'react'
import {
  LayoutGrid, RefreshCw, Square, Trash2, Info, Loader2, CircleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmtPrice } from '@/lib/market-types'
import type { GridTradeDto, GridFillDto } from '@/app/api/grid/route'

const STATUS_CLS: Record<string, string> = {
  active: 'border-emerald-500/40 text-emerald-400',
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
}

interface GridData {
  grids: GridTradeDto[]
}

export default function GridTab() {
  const { toast } = useToast()
  const [data, setData] = useState<GridData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [stopTarget, setStopTarget] = useState<GridTradeDto | null>(null)
  // details dialog: the grid id + its fetched fills
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ grid: GridTradeDto; fills: GridFillDto[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

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

  const stop = async (grid: GridTradeDto) => {
    setBusyId(grid.id)
    try {
      const res = await fetch(`/api/grid/${grid.id}/stop`, { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: `Grid stopped — ${grid.symbol}`, description: json?.grid?.stopReason || undefined })
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

  const remove = async (grid: GridTradeDto) => {
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
            const openLotsG = g.stats.openLots
            return (
              <div key={g.id} className="flex flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
                  <span
                    className={cn('inline-block h-2 w-2 shrink-0 rounded-full', isActive ? 'animate-pulse bg-emerald-400' : g.status === 'error' ? 'bg-rose-500' : 'bg-zinc-600')}
                    title={g.status}
                    aria-hidden
                  />
                  <span className="text-sm font-semibold text-zinc-100">{g.symbol}</span>
                  <Badge variant="outline" className={cn('text-[10px]', STATUS_CLS[g.status] ?? 'border-zinc-700 text-zinc-400')}>
                    {g.status}
                  </Badge>
                  <span className="font-medium tabular-nums text-zinc-300">{fmtPrice(g.lowerPrice)} – {fmtPrice(g.upperPrice)}</span>
                  <Badge variant="outline" className="text-[10px] text-zinc-500">
                    {g.gridCount} levels · {g.spacing}
                  </Badge>
                  <span className="tabular-nums text-zinc-500">qty {g.qtyPerGrid}/grid</span>
                  {g.maxSL != null && <Badge variant="outline" className="text-[10px] text-rose-400/90">SL {fmtPrice(g.maxSL)}</Badge>}
                  {g.maxTP != null && <Badge variant="outline" className="text-[10px] text-emerald-400/90">TP {fmtPrice(g.maxTP)}</Badge>}
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
                  {g.stoppedAt && <span title={fmtClock(g.stoppedAt)}>· stopped {rel(g.stoppedAt)}</span>}
                  {g.stopReason && (
                    <span className={cn('flex items-start gap-1', g.status === 'error' ? 'text-rose-400' : 'text-amber-400/90')}>
                      <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      {g.stopReason}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-0.5">
                    {isActive && (
                      <Button
                        variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-rose-400 hover:text-rose-300"
                        disabled={busyId === g.id}
                        onClick={() => setStopTarget(g)}
                        title="Stop this grid (respects its close-on-stop setting)"
                      >
                        {busyId === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />} Stop
                      </Button>
                    )}
                    {!isActive && (
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
                ? `${detail.grid.gridCount} levels · ${detail.grid.spacing} · ${fmtPrice(detail.grid.lowerPrice)}–${fmtPrice(detail.grid.upperPrice)} · qty ${detail.grid.qtyPerGrid}/grid`
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
