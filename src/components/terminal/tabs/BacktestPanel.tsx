'use client'

// Backtest & Optimize panel (Task 62) — second view of the Algo Trading tab.
//
// Shares the run-setup configuration with the live column (same symbol /
// timeframe / strategy / params / qty / TP-SL / session guards — the user
// tunes here, flips to "Runs" and starts with the identical config).
//
//   • Run backtest — replays the strategy over real historical bars with the
//     documented fill model (entries next-bar-open, TP/SL intrabar stop-first,
//     exits at close) and renders metrics + equity curve + trade list.
//   • Auto-tune — grid-searches user-picked parameter ranges, scores every
//     combo (Calmar-style: net% over max DD%) and lists the top results with
//     one-click "apply to run setup".
import { useEffect, useMemo, useState } from 'react'
import {
  FlaskConical, RefreshCw, SlidersHorizontal, TrendingUp, Table2, Wand2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import {
  ALGO_STRATEGIES,
  ALGO_MAX_DAYS,
  type AlgoStrategyId, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import type { BacktestResult, OptimizeResult } from '@/lib/backtest'

export interface AlgoSetupCfg {
  strategy: AlgoStrategyId
  symbol: string
  timeframe: AlgoTimeframe
  params: Record<string, number>
  qty: number
  tpMode: 'none' | 'pct'
  tpValue: number | null
  slMode: 'none' | 'pct'
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin: number
  requireNewSignal: boolean
}

interface BacktestMeta {
  symbol: string
  timeframe: string
  days: number
  bars: number
  from?: number
  to?: number
  coveredDays?: number
  source?: string
  dataCapped?: boolean
}

interface RangeState { on: boolean; min: string; max: string; step: string }

const fmtUsd = (v: number) =>
  (Math.abs(v) >= 1000 ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`)
const fmtPct = (v: number) => `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(2)}%`
const fmtPx = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4))
const fmtDay = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtDayY = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
const fmtClockT = (t: number) =>
  new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

const eqConfig = { equity: { label: 'Equity', color: '#34d399' } } satisfies ChartConfig

// Win / Loss breakdown (Task 71-2) — buckets by the EXIT bar's time in
// America/New_York (the terminal's session timezone), fixed buckets with
// zero-count bars visible (same visual language as the Performance Report).
const etHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
const etWdFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
const etMoFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short' })
const BT_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const BT_WDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const BT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
type BtGran = 'hour' | 'weekday' | 'monthyear'
const BT_GRAN_TITLES: Record<BtGran, string> = {
  hour: 'hour of day',
  weekday: 'day of week',
  monthyear: 'month of year',
}
const btWlConfig = { wins: { label: 'Wins' }, losses: { label: 'Losses' } } satisfies ChartConfig

export default function BacktestPanel({ cfg, onApplyParams }: { cfg: AlgoSetupCfg; onApplyParams: (p: Record<string, number>) => void }) {
  const { toast } = useToast()
  const [days, setDays] = useState('30')
  const [capital, setCapital] = useState('10000')
  const [minTrades, setMinTrades] = useState('8')
  // re-entry control (Task 70-c) — seeded from the run setup, editable here
  const [btCooldown, setBtCooldown] = useState('0')
  const [btFresh, setBtFresh] = useState(false)
  const [optOpen, setOptOpen] = useState(false)
  const [ranges, setRanges] = useState<Record<string, RangeState>>({})
  const [busy, setBusy] = useState<null | 'run' | 'optimize'>(null)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<BacktestMeta | null>(null)
  const [runRes, setRunRes] = useState<BacktestResult | null>(null)
  const [optRes, setOptRes] = useState<OptimizeResult | null>(null)
  // win/loss breakdown granularity (Task 71-2)
  const [wlGran, setWlGran] = useState<BtGran>('hour')

  const def = ALGO_STRATEGIES[cfg.strategy]

  // strategy switch → drop stale results + ranges
  useEffect(() => {
    setRanges({})
    setRunRes(null)
    setOptRes(null)
    setMeta(null)
    setError(null)
  }, [cfg.strategy])

  // keep the re-entry inputs in sync with the run setup they seed from
  useEffect(() => {
    setBtCooldown(String(cfg.cooldownMin ?? 0))
    setBtFresh(cfg.requireNewSignal === true)
  }, [cfg.cooldownMin, cfg.requireNewSignal])

  const payload = useMemo(() => ({
    symbol: cfg.symbol,
    timeframe: cfg.timeframe,
    strategy: cfg.strategy,
    params: cfg.params,
    qty: cfg.qty,
    tpMode: cfg.tpMode,
    tpValue: cfg.tpValue,
    slMode: cfg.slMode,
    slValue: cfg.slValue,
    maxTradesDay: cfg.maxTradesDay,
    rthOnly: cfg.rthOnly,
    flattenEod: cfg.flattenEod,
    cooldownMin: Math.min(240, Math.max(0, Math.round(Number(btCooldown) || 0))),
    requireNewSignal: btFresh,
    days: Math.max(1, Math.round(Number(days) || 30)),
    capital: Number(capital) || 10000,
  }), [cfg, days, capital, btCooldown, btFresh])

  const activeRanges = useMemo(() => {
    const out: { key: string; min: number; max: number; step: number }[] = []
    for (const p of def.params) {
      if (p.bool) continue
      const r = ranges[p.key]
      if (!r?.on) continue
      const min = Number(r.min)
      const max = Number(r.max)
      const step = Number(r.step)
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || max <= min || step <= 0) continue
      out.push({ key: p.key, min, max, step })
    }
    return out
  }, [def, ranges])

  const post = async (mode: 'run' | 'optimize') => {
    setBusy(mode)
    setError(null)
    try {
      const res = await fetch('/api/algo/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          mode,
          ...(mode === 'optimize'
            ? { ranges: activeRanges, minTrades: Math.max(1, Math.round(Number(minTrades) || 8)) }
            : {}),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`)
        toast({ title: mode === 'run' ? 'Backtest failed' : 'Optimizer failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      setMeta(json.meta ?? null)
      if (mode === 'run') {
        setRunRes(json.result ?? null)
        setOptRes(null)
      } else {
        setOptRes(json.optimize ?? null)
        setRunRes(null)
      }
    } catch {
      setError('Network error')
      toast({ title: 'Request failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const applyRow = (params: Record<string, number>) => {
    onApplyParams(params)
    toast({ title: 'Parameters applied', description: 'Optimizer values copied into the run setup — start the run when ready.' })
  }

  // downsample the equity curve for the chart
  const eqData = useMemo(() => {
    const pts = runRes?.equity ?? []
    if (pts.length <= 700) return pts
    const stride = Math.ceil(pts.length / 700)
    const out = pts.filter((_, i) => i % stride === 0)
    if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1])
    return out
  }, [runRes])

  const m = runRes?.metrics
  const pnlColor = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-300')

  // fixed win/loss buckets by EXIT time (America/New_York, Task 71-2) —
  // zero-count buckets stay visible so the shape of the day/week/year reads true
  const wlRows = useMemo(() => {
    const trades = runRes?.trades ?? []
    const order: readonly string[] = wlGran === 'hour' ? BT_HOURS : wlGran === 'weekday' ? BT_WDAYS : BT_MONTHS
    const rows: { key: string; label: string; wins: number; losses: number; pnl: number }[] =
      order.map((label) => ({ key: label, label, wins: 0, losses: 0, pnl: 0 }))
    const byKey = new Map(rows.map((r) => [r.key, r]))
    for (const t of trades) {
      const d = new Date(t.exitTime * 1000)
      if (!Number.isFinite(d.getTime())) continue
      const key = wlGran === 'hour' ? etHourFmt.format(d) : wlGran === 'weekday' ? etWdFmt.format(d) : etMoFmt.format(d)
      const row = byKey.get(key)
      if (!row) continue
      row.pnl += t.pnl
      if (t.pnl > 0) row.wins++
      else if (t.pnl < 0) row.losses++
    }
    return rows
  }, [runRes, wlGran])

  return (
    <div className="flex flex-col gap-2">
      {/* ---- run configuration (shared) + backtest period ---- */}
      <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <FlaskConical className="h-4 w-4 text-violet-400" aria-hidden />
          <span className="text-sm font-semibold text-zinc-100">Backtest</span>
          <Badge variant="outline" className="text-[10px] text-zinc-400">
            {def.name} · {cfg.symbol || '—'} {cfg.timeframe}
          </Badge>
          <span className="ml-auto text-[11px] text-zinc-500">same config as the run setup on the left</span>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <Label htmlFor="bt-days" className="text-[10px] text-zinc-500">
              History (calendar days)
              <span className="ml-1 text-zinc-600">· max {ALGO_MAX_DAYS[cfg.timeframe as AlgoTimeframe]} for {cfg.timeframe}</span>
            </Label>
            <Input
              id="bt-days"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              onBlur={() => {
                const n = Math.round(Number(days) || 30)
                const max = ALGO_MAX_DAYS[cfg.timeframe as AlgoTimeframe] ?? 730
                setDays(String(Math.min(max, Math.max(1, n))))
              }}
              inputMode="numeric"
              className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs"
            />
            {cfg.symbol.includes('/') && (
              <p className="mt-0.5 text-[9px] leading-tight text-zinc-600">crypto feeds serve ≈104d on 15m / 35d on 5m — deeper windows use the Alpaca crypto feed</p>
            )}
          </div>
          <div>
            <Label htmlFor="bt-capital" className="text-[10px] text-zinc-500">Starting capital $</Label>
            <Input id="bt-capital" value={capital} onChange={(e) => setCapital(e.target.value)} inputMode="decimal" className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs" />
          </div>
          <div>
            <Label htmlFor="bt-cooldown" className="text-[10px] text-zinc-500">Cooldown after close (min)</Label>
            <Input
              id="bt-cooldown"
              value={btCooldown}
              onChange={(e) => setBtCooldown(e.target.value)}
              onBlur={() => setBtCooldown(String(Math.min(240, Math.max(0, Math.round(Number(btCooldown) || 0)))))}
              inputMode="numeric"
              className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs"
            />
          </div>
          <div className="flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="bt-fresh" className="text-[10px] leading-tight text-zinc-500">Require fresh signal</Label>
              <Switch id="bt-fresh" checked={btFresh} onCheckedChange={setBtFresh} className="scale-90" />
            </div>
            <p className="text-[9px] leading-tight text-zinc-600">edge-triggered re-entry — wait for a new cross</p>
          </div>
          <div className="col-span-2 flex items-end sm:col-span-4">
            <p className="text-[10px] leading-snug text-zinc-500">
              Fill model: entries at next-bar open · TP/SL intrabar (stop first) · strategy exits at bar close · no slippage/fees. Cooldown blocks entries on bars opening within N minutes after a close; fresh-signal fires only on a false→true cross.
            </p>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            className="h-8 gap-2 bg-sky-600 px-3 text-xs text-white hover:bg-sky-500"
            disabled={busy !== null || !cfg.symbol || !(cfg.qty > 0)}
            onClick={() => void post('run')}
          >
            {busy === 'run' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <TrendingUp className="h-3.5 w-3.5" />}
            Run backtest
          </Button>
          <Button
            variant="outline"
            className="h-8 gap-2 border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800"
            onClick={() => setOptOpen((v) => !v)}
            aria-expanded={optOpen}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Auto-tune parameters {optOpen ? '▲' : '▼'}
          </Button>
        </div>

        {/* ---- optimizer ranges ---- */}
        {optOpen && (
          <div className="mt-3 rounded border border-zinc-800/70 bg-zinc-950/60 p-2.5">
            <p className="text-[11px] font-semibold text-zinc-300">Grid search — tick the parameters to optimize</p>
            <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">
              Unticked parameters stay at the setup values. Each combo replays the full period; the grid is capped at ~
              {' '}800 sampled combos (evenly stride-sampled if larger). Score = net return % ÷ max drawdown % (Calmar-style),
              runs with fewer than the min trades score −∞.
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              {def.params.filter((p) => !p.bool).map((p) => {
                const r = ranges[p.key] ?? { on: false, min: String(p.min), max: String(p.max), step: String(p.step) }
                const toggle = (on: boolean) =>
                  setRanges((rs) => ({ ...rs, [p.key]: { ...r, on, min: r.min || String(p.min), max: r.max || String(p.max), step: r.step || String(p.step) } }))
                const patch = (part: Partial<RangeState>) => setRanges((rs) => ({ ...rs, [p.key]: { ...r, ...part } }))
                return (
                  <div key={p.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-1.5 py-1 hover:bg-zinc-900/60">
                    <Switch checked={r.on} onCheckedChange={toggle} className="scale-90" aria-label={`Optimize ${p.label}`} />
                    <span className="min-w-28 text-[11px] text-zinc-300">{p.label}</span>
                    <span className="text-[10px] text-zinc-600">setup {paramsStr(cfg.params[p.key])}</span>
                    {r.on && (
                      <span className="ml-auto flex items-center gap-1">
                        <NumIn value={r.min} onChange={(v) => patch({ min: v })} label={`${p.label} min`} />
                        <span className="text-[10px] text-zinc-600">→</span>
                        <NumIn value={r.max} onChange={(v) => patch({ max: v })} label={`${p.label} max`} />
                        <span className="text-[10px] text-zinc-600">step</span>
                        <NumIn value={r.step} onChange={(v) => patch({ step: v })} label={`${p.label} step`} />
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="bt-mintrades" className="text-[10px] text-zinc-500">Min trades to score</Label>
                <Input id="bt-mintrades" value={minTrades} onChange={(e) => setMinTrades(e.target.value)} inputMode="numeric" className="h-7 w-16 border-zinc-800 bg-zinc-950 text-xs" />
              </div>
              <span className="text-[10px] text-zinc-600">{activeRanges.length === 0 ? 'tick at least one parameter' : `${activeRanges.length} parameter${activeRanges.length === 1 ? '' : 's'} selected`}</span>
              <Button
                className="ml-auto h-8 gap-2 bg-amber-600 px-3 text-xs text-white hover:bg-amber-500"
                disabled={busy !== null || activeRanges.length === 0 || !cfg.symbol || !(cfg.qty > 0)}
                onClick={() => void post('optimize')}
              >
                {busy === 'optimize' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                Run optimizer
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-2 rounded border border-rose-500/30 bg-rose-500/5 px-2.5 py-1.5 text-[11px] text-rose-300" role="alert">{error}</p>
        )}
      </div>

      {/* ---- results ---- */}
      {meta && (
        <div className="flex flex-col gap-1 px-1">
          <p className="text-[11px] text-zinc-500">
            {meta.symbol} · {meta.timeframe} · data {meta.from != null && meta.to != null ? <>{fmtDayY(meta.from)} → {fmtDayY(meta.to)} ({meta.coveredDays ?? '—'}d)</> : <>last {meta.days} days</>}
            {' '}· {meta.bars.toLocaleString('en-US')} closed bars{meta.source ? <> · feed: {meta.source}</> : null}
            {runRes && <> · trades {fmtDayY(runRes.metrics.from)} → {fmtDayY(runRes.metrics.to)}</>}
          </p>
          {meta.dataCapped && meta.coveredDays != null && (
            <p className="rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-300" role="note">
              Requested {meta.days}d, but the data feed only returned {meta.coveredDays}d of history for {meta.symbol} {meta.timeframe} (feed lookback cap) —
              the backtest replayed {meta.from != null ? fmtDayY(meta.from) : '—'} → {meta.to != null ? fmtDayY(meta.to) : '—'} instead of the full window.
            </p>
          )}
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-6 text-xs text-zinc-400" role="status">
          <RefreshCw className="h-4 w-4 animate-spin text-zinc-500" aria-hidden />
          {busy === 'run' ? 'Replaying history…' : 'Searching parameter grid… this can take a few seconds'}
        </div>
      )}

      {/* single-run result */}
      {runRes && m && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Net P&L" value={fmtUsd(m.netPnl)} sub={fmtPct(m.netPct)} cls={pnlColor(m.netPnl)} />
            <Metric label="Win rate" value={`${m.winRate.toFixed(1)}%`} sub={`${m.wins}W / ${m.losses}L`} cls="text-zinc-100" />
            <Metric label="Profit factor" value={m.profitFactor >= 999 ? '∞' : m.profitFactor.toFixed(2)} sub={`${fmtUsd(m.grossWin)} / ${fmtUsd(m.grossLoss)}`} cls={m.profitFactor >= 1 ? 'text-emerald-400' : 'text-rose-400'} />
            <Metric label="Max drawdown" value={fmtPct(-m.maxDrawdownPct)} sub={fmtUsd(-m.maxDrawdown)} cls="text-rose-400" />
            <Metric label="Trades" value={String(m.trades)} sub={`${m.longs}L · ${m.shorts}S${m.openAtEnd ? ' · 1 open' : ''}`} cls="text-zinc-100" />
            <Metric label="Expectancy" value={fmtUsd(m.expectancy)} sub="per trade" cls={pnlColor(m.expectancy)} />
            <Metric label="Avg hold" value={`${m.avgHoldMin < 90 ? `${Math.round(m.avgHoldMin)}m` : `${(m.avgHoldMin / 60).toFixed(1)}h`}`} sub={`${m.tradesPerWeek.toFixed(1)} trades/wk`} cls="text-zinc-100" />
            <Metric label="Final equity" value={fmtUsd(m.finalEquity)} sub={m.suppressed > 0 ? `${m.suppressed} signals gated` : 'gates: none hit'} cls="text-zinc-100" />
          </div>

          <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Equity curve (realized)</p>
            <ChartContainer config={eqConfig} className="h-40 w-full" aria-label="Backtest equity curve">
              <AreaChart data={eqData} margin={{ left: 2, right: 8, top: 6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis dataKey="t" tickFormatter={fmtDay} minTickGap={48} stroke="#52525b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis domain={['auto', 'auto']} tickFormatter={(v: number) => fmtUsd(v)} stroke="#52525b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={58} />
                <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(l) => fmtClockT(Number(l))} formatter={(v) => [fmtUsd(Number(v)), 'Equity']} />} />
                <Area type="monotone" dataKey="equity" stroke="#34d399" fill="#34d399" fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
              </AreaChart>
            </ChartContainer>
          </div>

          {runRes.trades.length > 0 && (
            <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Win / Loss breakdown</p>
                <span className="flex items-center gap-0.5 rounded border border-zinc-800 bg-zinc-950 p-0.5" role="tablist" aria-label="Win/loss bucket size">
                  {(['hour', 'weekday', 'monthyear'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      role="tab"
                      aria-selected={wlGran === g}
                      onClick={() => setWlGran(g)}
                      className={cn(
                        'h-6 rounded px-2 text-[11px] font-medium',
                        wlGran === g ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                      )}
                    >
                      {g === 'hour' ? 'Hour of day' : g === 'weekday' ? 'Day of week' : 'Month of year'}
                    </button>
                  ))}
                </span>
                <span className="ml-auto flex items-center gap-3 text-[10px] text-zinc-500">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: '#10b981' }} aria-hidden />Wins</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: '#f43f5e' }} aria-hidden />Losses</span>
                </span>
              </div>
              <ChartContainer config={btWlConfig} className="mt-1 h-52 w-full" aria-label={`Backtest win/loss by ${BT_GRAN_TITLES[wlGran]}`}>
                <BarChart data={wlRows} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#27272a" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} minTickGap={10} tick={{ fontSize: 10, fill: '#71717a' }} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={34} tick={{ fontSize: 10, fill: '#71717a' }} />
                  <ChartTooltip
                    cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                    content={
                      <ChartTooltipContent
                        labelFormatter={(label, payload) => {
                          const row = payload?.[0]?.payload as { pnl?: number } | undefined
                          const net = row && typeof row.pnl === 'number' && Number.isFinite(row.pnl) && row.pnl !== 0 ? ` · net ${fmtUsd(row.pnl)}` : ''
                          return `${String(label)}${net}`
                        }}
                      />
                    }
                  />
                  <Bar dataKey="wins" stackId="wl" fill="#10b981" />
                  <Bar dataKey="losses" stackId="wl" fill="#f43f5e" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ChartContainer>
              <p className="mt-1 text-[11px] text-zinc-500">
                By exit time in America/New_York · fixed {wlGran === 'hour' ? '00–23 hours' : wlGran === 'weekday' ? 'Mon–Sun' : 'Jan–Dec'} · zero-count buckets included · all {runRes.trades.length} trade{runRes.trades.length === 1 ? '' : 's'}
              </p>
            </div>
          )}

          {runRes.trades.length > 0 && (
            <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70">
              <div className="flex items-center gap-2 px-3 py-2">
                <Table2 className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Trades ({runRes.trades.length})</span>
                <span className="ml-auto text-[10px] text-zinc-600">newest first</span>
              </div>
              <div className="max-h-64 overflow-auto border-t border-zinc-800/60 terminal-scroll" aria-label="Backtest trade list">
                <table className="w-full min-w-[560px] text-left text-[11px]">
                  <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                    <tr>
                      <th className="px-2.5 py-1.5 font-medium">Exit time</th>
                      <th className="px-2 py-1.5 font-medium">Side</th>
                      <th className="px-2 py-1.5 font-medium text-right">Qty</th>
                      <th className="px-2 py-1.5 font-medium text-right">Entry</th>
                      <th className="px-2 py-1.5 font-medium text-right">Exit</th>
                      <th className="px-2 py-1.5 font-medium text-right">P&L $</th>
                      <th className="px-2 py-1.5 font-medium text-right">P&L %</th>
                      <th className="px-2 py-1.5 font-medium text-right">Hold</th>
                      <th className="px-2.5 py-1.5 font-medium">Exit reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...runRes.trades].reverse().slice(0, 200).map((t, i) => (
                      <tr key={i} className="border-t border-zinc-800/40 hover:bg-zinc-900/50">
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-zinc-400">{fmtClockT(t.exitTime)}</td>
                        <td className={cn('px-2 py-1.5 font-semibold', t.side === 'long' ? 'text-emerald-400' : 'text-rose-400')}>{t.side}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{t.qty}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{fmtPx(t.entryPx)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{fmtPx(t.exitPx)}</td>
                        <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlColor(t.pnl))}>{fmtUsd(t.pnl)}</td>
                        <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlColor(t.pnl))}>{fmtPct(t.pnlPct)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-zinc-500">{t.holdMin < 90 ? `${Math.round(t.holdMin)}m` : `${(t.holdMin / 60).toFixed(1)}h`}</td>
                        <td className="whitespace-nowrap px-2.5 py-1.5 text-zinc-500">{t.exitReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {runRes.trades.length === 0 && (
            <p className="rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 px-3 py-4 text-center text-xs text-zinc-500">
              No trades fired with this configuration — try wider TP/SL, a higher daily cap, different parameters or a longer period.
            </p>
          )}
        </>
      )}

      {/* optimizer result */}
      {optRes && (
        <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Wand2 className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Optimizer results</span>
            <Badge variant="outline" className="text-[10px] text-zinc-400">{optRes.evaluated} combos evaluated</Badge>
            {optRes.truncated && (
              <Badge variant="outline" className="text-[10px] text-amber-400/80" title="The grid exceeded the compute budget — evenly stride-sampled">
                sampled {optRes.evaluated}/{optRes.totalCombos}
              </Badge>
            )}
            {optRes.skipped > 0 && <Badge variant="outline" className="text-[10px] text-zinc-500">{optRes.skipped} skipped (invalid)</Badge>}
            <span className="text-[10px] text-zinc-600">{(optRes.elapsedMs / 1000).toFixed(1)}s</span>
            {optRes.best && (
              <Button
                size="sm"
                className="ml-auto h-7 gap-1.5 bg-emerald-600 px-2.5 text-[11px] text-white hover:bg-emerald-500"
                onClick={() => applyRow(optRes.best!.params)}
              >
                <Wand2 className="h-3 w-3" /> Apply best to run setup
              </Button>
            )}
          </div>
          {optRes.results.length === 0 ? (
            <p className="border-t border-zinc-800/60 px-3 py-4 text-center text-xs text-zinc-500">No combination produced a scorable result.</p>
          ) : (
            <div className="max-h-80 overflow-auto border-t border-zinc-800/60 terminal-scroll" aria-label="Optimizer result table">
              <table className="w-full min-w-[620px] text-left text-[11px]">
                <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 font-medium">Parameters</th>
                    <th className="px-2 py-1.5 font-medium text-right">Score</th>
                    <th className="px-2 py-1.5 font-medium text-right">Net %</th>
                    <th className="px-2 py-1.5 font-medium text-right">PF</th>
                    <th className="px-2 py-1.5 font-medium text-right">Win %</th>
                    <th className="px-2 py-1.5 font-medium text-right">Max DD %</th>
                    <th className="px-2 py-1.5 font-medium text-right">Trades</th>
                    <th className="px-2.5 py-1.5 font-medium" aria-label="Apply" />
                  </tr>
                </thead>
                <tbody>
                  {optRes.results.slice(0, 25).map((row, i) => (
                    <tr
                      key={i}
                      className={cn('cursor-pointer border-t border-zinc-800/40 hover:bg-zinc-900/60', i === 0 && 'bg-emerald-500/5')}
                      onClick={() => applyRow(row.params)}
                      title="Click to apply these parameters to the run setup"
                    >
                      <td className="px-2.5 py-1.5 tabular-nums text-zinc-500">{i + 1}</td>
                      <td className="px-2 py-1.5 text-zinc-300">
                        <span className="flex flex-wrap gap-x-2">
                          {Object.entries(row.params).map(([k, v]) => (
                            <span key={k} className="whitespace-nowrap">
                              <span className="text-zinc-500">{paramLabel(cfg.strategy, k)}</span> <span className="tabular-nums text-zinc-200">{v}</span>
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">{row.score === -Infinity ? '—' : row.score.toFixed(2)}</td>
                      <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlColor(row.metrics.netPct))}>{fmtPct(row.metrics.netPct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.metrics.profitFactor >= 999 ? '∞' : row.metrics.profitFactor.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.metrics.winRate.toFixed(0)}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-rose-400/80">{row.metrics.maxDrawdownPct.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.metrics.trades}</td>
                      <td className="px-2.5 py-1.5 text-right">
                        {i === 0 && <Badge variant="outline" className="text-[9px] uppercase text-emerald-400 border-emerald-500/40">best</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-zinc-800/60 px-3 py-2 text-[10px] leading-snug text-zinc-600">
            Click any row to apply those parameters to the run setup (unticked parameters keep their setup values). Past performance ≠ future results — re-run the
            backtest on the tuned parameters and check the drawdown before going live.
          </p>
        </div>
      )}
    </div>
  )
}

function paramsStr(v: number | undefined): string {
  return v == null ? '—' : String(v)
}

function paramLabel(strategy: AlgoStrategyId, key: string): string {
  return ALGO_STRATEGIES[strategy].params.find((p) => p.key === key)?.label ?? key
}

function NumIn({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode="decimal"
      aria-label={label}
      className="h-7 w-16 border-zinc-800 bg-zinc-950 text-xs"
    />
  )
}

function Metric({ label, value, sub, cls }: { label: string; value: string; sub: string; cls: string }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={cn('mt-0.5 text-lg font-semibold leading-tight tabular-nums', cls)}>{value}</p>
      <p className="text-[10px] text-zinc-500">{sub}</p>
    </div>
  )
}
