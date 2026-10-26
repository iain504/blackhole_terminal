'use client'

// Task 18 — Auto Grid dialog: scan a watchlist, show the per-symbol decision
// (start/skip + reason + metrics + the exact setup + end conditions), let the
// user pick which accepted grids to start, then start them. The grid engine
// owns the rest: percent SL/TP guards + the planned autoEndAt force-stop, and
// every grid can be paused/resumed/stopped from the Grid tab at any time.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Play, ScanSearch, Sparkles, Info, CircleAlert, History } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTerminal } from '@/store/terminal'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmtPrice } from '@/lib/market-types'

// ---- wire types (mirror POST /api/grid/auto) ----
interface AutoPlan {
  center: number
  windowDays: number
  bars: number
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: string
  direction: string
  qtyPerGrid: number
  maxSLPct: number
  maxTPPct: number
  slTriggerApprox: number
  tpTriggerApprox: number
  maxEndDays: number
  preset: string
  trendPct: number
  rangePct: number
  crossovers: number
  backtest: {
    totalPnl: number
    realizedPnl: number
    openPnl: number
    maxDrawdown: number
    fillsCount: number
    openLots: number
    winRate: number | null
    score: number
  }
}

interface AutoResult {
  symbol: string
  decision: 'start' | 'skip'
  reason: string
  details: string[]
  plan: AutoPlan | null
  gridId?: string
  error?: string
}

interface AutoResponse {
  runId: string
  mode: 'scan' | 'start'
  watchlist: string
  preset: string
  presetLabel: string
  maxEndDays: number
  days: number
  timeframe: string
  results: AutoResult[]
  started: number
  skipped: number
  failed: number
}

interface AutoRunRow {
  id: string
  mode: string
  watchlist: string
  scanned: number
  started: number
  skipped: number
  failed: number
  createdAt: string
}

const PRESETS = [
  { value: 'conservative', label: 'Conservative' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'aggressive', label: 'Aggressive' },
] as const

const pnlCls = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-400')

function rel(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function GridAutoDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onStarted?: () => void
}) {
  const { toast } = useToast()
  const watchlists = useTerminal(useShallow((s) => s.watchlists))
  const loadWatchlists = useTerminal((s) => s.loadWatchlists)
  const activeWatchlistId = useTerminal((s) => s.activeWatchlistId)

  const [watchlistId, setWatchlistId] = useState<string>('')
  const [qty, setQty] = useState('1')
  const [preset, setPreset] = useState<string>('balanced')
  const [endDays, setEndDays] = useState('30')
  const [windowDays, setWindowDays] = useState('60')

  const [scanning, setScanning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [report, setReport] = useState<AutoResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [runs, setRuns] = useState<AutoRunRow[]>([])
  const [showRuns, setShowRuns] = useState(false)

  // default the picker to the active watchlist once lists are loaded
  useEffect(() => {
    if (!open) return
    if (watchlists.length === 0) void loadWatchlists()
    else if (!watchlistId) setWatchlistId(activeWatchlistId ?? watchlists[0]?.id ?? '')
  }, [open, watchlists, activeWatchlistId, watchlistId, loadWatchlists])

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/grid/auto')
      if (res.ok) setRuns(((await res.json()) as { runs: AutoRunRow[] }).runs)
    } catch { /* history is best-effort */ }
  }, [])

  useEffect(() => {
    if (open) void loadRuns()
  }, [open, loadRuns])

  const accepted = useMemo(
    () => report?.results.filter((r) => r.decision === 'start') ?? [],
    [report],
  )
  const startableCount = selected.size

  const scan = async () => {
    const q = Number(qty)
    if (!Number.isFinite(q) || q <= 0) {
      toast({ title: 'Quantity per grid must be a positive number', variant: 'destructive' })
      return
    }
    setScanning(true)
    setReport(null)
    setSelected(new Set())
    try {
      const res = await fetch('/api/grid/auto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          watchlistId,
          qtyPerGrid: q,
          preset,
          maxEndDays: Math.round(Number(endDays) || 30),
          days: Math.round(Number(windowDays) || 60),
          start: false,
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: 'Auto Grid scan failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      const data = json as AutoResponse
      setReport(data)
      setSelected(new Set(data.results.filter((r) => r.decision === 'start').map((r) => r.symbol)))
      void loadRuns()
      toast({
        title: `Scan complete — ${data.started} of ${data.results.length} symbols qualify`,
        description: data.started > 0
          ? 'Review the reasons, untick anything you disagree with, then Start.'
          : 'Every symbol was skipped — expand a row for the reason.',
      })
    } catch {
      toast({ title: 'Auto Grid scan failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setScanning(false)
    }
  }

  const startSelected = async () => {
    if (startableCount === 0 || !report) return
    setStarting(true)
    try {
      const res = await fetch('/api/grid/auto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          watchlistId,
          qtyPerGrid: Number(qty),
          preset,
          maxEndDays: Math.round(Number(endDays) || 30),
          days: Math.round(Number(windowDays) || 60),
          start: true,
          selected: [...selected],
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: 'Could not start the grids', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      const data = json as AutoResponse
      setReport(data)
      setSelected(new Set())
      void loadRuns()
      onStarted?.()
      toast({
        title: `Auto Grid started ${data.started} grid${data.started === 1 ? '' : 's'}`,
        description: data.failed > 0
          ? `${data.failed} failed — see the rows below for the reason.`
          : 'Each grid shows its reason + end conditions in the Grid tab. Pause/stop anytime.',
      })
    } catch {
      toast({ title: 'Could not start the grids', description: 'Network error', variant: 'destructive' })
    } finally {
      setStarting(false)
    }
  }

  const toggle = (sym: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sym)) next.delete(sym)
      else next.add(sym)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto terminal-scroll border-zinc-800 bg-zinc-900 text-zinc-200">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Sparkles className="h-4 w-4 text-emerald-500" aria-hidden />
            Auto Grid — scan a watchlist
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-zinc-500">
            The engine backtests a width × level sweep per symbol over real history, keeps only
            range-bound + profitable setups (risk-adjusted score &gt; 0), and starts them with
            percent SL/TP guards and a planned end. Every grid stays fully manual: pause, resume
            or stop it any time in the Grid tab.
          </DialogDescription>
        </DialogHeader>

        {/* ---- controls ---- */}
        <div className="grid grid-cols-2 gap-3 rounded-md border border-zinc-800/80 bg-zinc-950/60 p-3 sm:grid-cols-4">
          <div className="col-span-2 space-y-1.5 sm:col-span-1">
            <Label className="text-[11px] text-zinc-400">Watchlist</Label>
            <Select value={watchlistId} onValueChange={setWatchlistId}>
              <SelectTrigger className="h-8 border-zinc-800 bg-zinc-900 text-xs">
                <SelectValue placeholder={watchlists.length === 0 ? 'No watchlists' : 'Pick a list'} />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 text-xs">
                {watchlists.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name} ({w.items.length})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-zinc-400">Qty / grid level</Label>
            <Input
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="decimal"
              className="h-8 border-zinc-800 bg-zinc-900 text-xs"
              aria-label="Quantity per grid level"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-zinc-400">Guard preset</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger className="h-8 border-zinc-800 bg-zinc-900 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 text-xs">
                {PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-zinc-400">Ends (d)</Label>
              <Input
                value={endDays}
                onChange={(e) => setEndDays(e.target.value)}
                inputMode="numeric"
                className="h-8 border-zinc-800 bg-zinc-900 text-xs"
                aria-label="Planned end in days"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-zinc-400">Window (d)</Label>
              <Input
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value)}
                inputMode="numeric"
                className="h-8 border-zinc-800 bg-zinc-900 text-xs"
                aria-label="History window in days"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-500"
            onClick={() => void scan()}
            disabled={scanning || !watchlistId}
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
            {scanning ? 'Scanning…' : `Scan ${watchlists.find((w) => w.id === watchlistId)?.name ?? 'watchlist'}`}
          </Button>
          {report && (
            <span className="text-[11px] text-zinc-500">
              {report.days}d {report.timeframe} window · {report.presetLabel} · ends after {report.maxEndDays}d
            </span>
          )}
        </div>

        {/* ---- per-symbol report ---- */}
        {report && (
          <div className="space-y-2">
            {report.results.length === 0 && (
              <p className="rounded-md border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
                The watchlist has no scannable symbols.
              </p>
            )}
            {report.results.map((r) => {
              const isStart = r.decision === 'start'
              const startedNow = r.gridId != null
              return (
                <div
                  key={r.symbol}
                  className={cn(
                    'rounded-md border p-3',
                    startedNow ? 'border-emerald-500/30 bg-emerald-500/5'
                      : isStart ? 'border-zinc-800 bg-zinc-950/60'
                      : 'border-zinc-800/60 bg-zinc-950/30',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {isStart && !startedNow ? (
                      <Checkbox
                        checked={selected.has(r.symbol)}
                        onCheckedChange={() => toggle(r.symbol)}
                        aria-label={`Include ${r.symbol} in the auto start`}
                        className="border-zinc-600 data-[state=checked]:border-emerald-500 data-[state=checked]:bg-emerald-600"
                      />
                    ) : startedNow ? (
                      <Play className="h-3.5 w-3.5 text-emerald-400" aria-label="grid started" />
                    ) : (
                      <CircleAlert className="h-3.5 w-3.5 text-zinc-600" aria-hidden />
                    )}
                    <span className="text-sm font-semibold text-zinc-100">{r.symbol}</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px]',
                        startedNow ? 'border-emerald-500/40 text-emerald-400'
                          : isStart ? 'border-emerald-500/40 text-emerald-400'
                          : 'border-zinc-700 text-zinc-500',
                      )}
                    >
                      {startedNow ? 'STARTED' : isStart ? 'START' : 'SKIP'}
                    </Badge>
                    {r.plan && (
                      <Badge variant="outline" className={cn('text-[10px] tabular-nums', pnlCls(r.plan.backtest.score))}>
                        score {r.plan.backtest.score}
                      </Badge>
                    )}
                    {r.plan && (
                      <span className="text-[11px] tabular-nums text-zinc-500">
                        {fmtPrice(r.plan.lowerPrice)}–{fmtPrice(r.plan.upperPrice)} · {r.plan.gridCount} lvl · {r.plan.backtest.fillsCount} fills ·{' '}
                        <span className={pnlCls(r.plan.backtest.totalPnl)}>P/L {r.plan.backtest.totalPnl}</span> · DD {r.plan.backtest.maxDrawdown}
                      </span>
                    )}
                  </div>
                  <p className={cn('mt-1.5 text-[11px] leading-snug', r.error ? 'text-rose-400' : isStart ? 'text-zinc-300' : 'text-zinc-400')}>
                    {r.reason}
                  </p>
                  {r.details.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[10px] leading-snug text-zinc-600">
                      {r.details.map((d, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <Info className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden />
                          {d}
                        </li>
                      ))}
                    </ul>
                  )}
                  {startedNow && (
                    <p className="mt-1 text-[10px] text-emerald-500/80">
                      Grid running — guards + planned end armed; pause/stop it in the Grid tab.
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ---- start action ---- */}
        {report && report.mode === 'scan' && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/60 p-3">
            <p className="text-[11px] text-zinc-500">
              {startableCount > 0
                ? `${startableCount} of ${accepted.length} qualified symbol${accepted.length === 1 ? '' : 's'} selected — each starts with the shown setup + end conditions.`
                : accepted.length === 0
                  ? 'Nothing qualified on this window — try a longer window or another watchlist.'
                  : 'Select at least one symbol to start.'}
            </p>
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-500"
              onClick={() => void startSelected()}
              disabled={starting || startableCount === 0}
            >
              {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Start {startableCount || ''} grid{startableCount === 1 ? '' : 's'}
            </Button>
          </div>
        )}

        {/* ---- recent runs ---- */}
        {runs.length > 0 && (
          <div className="rounded-md border border-zinc-800/70">
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-[11px] font-medium text-zinc-400 hover:text-zinc-200"
              onClick={() => setShowRuns((v) => !v)}
              aria-expanded={showRuns}
            >
              <History className="h-3.5 w-3.5" aria-hidden />
              Past runs ({runs.length})
              <span className="ml-auto text-zinc-600">{showRuns ? 'hide' : 'show'}</span>
            </button>
            {showRuns && (
              <ul className="space-y-1 border-t border-zinc-800/70 px-3 py-2 text-[10px] text-zinc-500">
                {runs.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-2">
                    <Badge variant="outline" className={cn('text-[9px]', r.mode === 'start' ? 'border-emerald-500/30 text-emerald-400' : 'border-zinc-700 text-zinc-500')}>
                      {r.mode}
                    </Badge>
                    <span className="text-zinc-400">{r.watchlist}</span>
                    <span className="tabular-nums">
                      {r.started} started · {r.skipped} skipped{r.failed > 0 ? ` · ${r.failed} failed` : ''}
                    </span>
                    <span className="ml-auto">{rel(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
