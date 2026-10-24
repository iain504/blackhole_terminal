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
//   • Test all strategies (Task 87) — ONE click sweeps the whole catalog:
//     every strategy runs at its defaults PLUS an auto-built optimizer grid
//     (defaults guaranteed in-grid), and the top X rows across all strategies
//     are ranked for the user to apply (strategy + params, one click).
import { useEffect, useMemo, useState } from 'react'
import {
  FlaskConical, RefreshCw, SlidersHorizontal, TrendingUp, Table2, Wand2, Zap,
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
import type { BacktestResult, OptimizeResult, SweepResult } from '@/lib/backtest'
import { Segmented } from '@/components/terminal/tabs/Segmented'
import { type AlgoRiskBasis, type AlgoSizingMode } from '@/lib/algo-strategies'

export interface AlgoSetupCfg {
  strategy: AlgoStrategyId
  symbol: string
  timeframe: AlgoTimeframe
  params: Record<string, number>
  qty: number
  // Task 78 — Risk Money sizing (mirrors the live run config); Task 78e —
  // budget basis: 'usd' → riskMoney $ · 'pct' → riskMoneyPct % of equity
  sizingMode: AlgoSizingMode
  riskBasis: AlgoRiskBasis
  riskMoney: number | null
  riskMoneyPct: number | null
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

export default function BacktestPanel({ cfg, onApplyParams }: { cfg: AlgoSetupCfg; onApplyParams: (p: Record<string, number>, strategy?: AlgoStrategyId) => void }) {
  const { toast } = useToast()
  const [days, setDays] = useState('30')
  const [capital, setCapital] = useState('10000')
  const [minTrades, setMinTrades] = useState('8')
  // re-entry control (Task 70-c) — seeded from the run setup, editable here
  const [btCooldown, setBtCooldown] = useState('0')
  const [btFresh, setBtFresh] = useState(false)
  // Task 84 — execution-cost model (bps; 0 = frictionless, historical default)
  const [btSlip, setBtSlip] = useState('0')
  const [btFee, setBtFee] = useState('0')
  // Task 85 — bid/ask spread (bps): half is charged per market fill
  const [btSpread, setBtSpread] = useState('0')
  // Task 85 — live spread probe: the symbol's current bid/ask spread in bps,
  // surfaced next to the input so the cost model is calibrated, not guessed
  const [liveSpreadBps, setLiveSpreadBps] = useState<number | null>(null)
  // Task 87 — one-click all-strategy sweep
  const [topX, setTopX] = useState('8')
  const [sweepRes, setSweepRes] = useState<SweepResult | null>(null)
  const [optOpen, setOptOpen] = useState(false)
  const [ranges, setRanges] = useState<Record<string, RangeState>>({})
  const [busy, setBusy] = useState<null | 'run' | 'optimize' | 'sweep'>(null)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<BacktestMeta | null>(null)
  const [runRes, setRunRes] = useState<BacktestResult | null>(null)
  const [optRes, setOptRes] = useState<OptimizeResult | null>(null)
  // win/loss breakdown granularity (Task 71-2)
  const [wlGran, setWlGran] = useState<BtGran>('hour')

  const def = ALGO_STRATEGIES[cfg.strategy]

  // strategy switch → drop stale results + ranges (the SWEEP survives: it is
  // a cross-strategy artifact — applying a sweep row switches the strategy
  // and the ranked list must stay on screen)
  useEffect(() => {
    setRanges({})
    setRunRes(null)
    setOptRes(null)
    setMeta(null)
    setError(null)
  }, [cfg.strategy])

  // symbol / timeframe switch → the sweep was measured on other data
  useEffect(() => {
    setSweepRes(null)
  }, [cfg.symbol, cfg.timeframe])

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
    sizingMode: cfg.sizingMode,
    riskBasis: cfg.sizingMode === 'risk' ? cfg.riskBasis : 'usd',
    riskMoney: cfg.sizingMode === 'risk' && cfg.riskBasis !== 'pct' ? cfg.riskMoney : null,
    riskMoneyPct: cfg.sizingMode === 'risk' && cfg.riskBasis === 'pct' ? cfg.riskMoneyPct : null,
    tpMode: cfg.tpMode,
    tpValue: cfg.tpValue,
    slMode: cfg.slMode,
    slValue: cfg.slValue,
    maxTradesDay: cfg.maxTradesDay,
    rthOnly: cfg.rthOnly,
    flattenEod: cfg.flattenEod,
    cooldownMin: Math.min(240, Math.max(0, Math.round(Number(btCooldown) || 0))),
    requireNewSignal: btFresh,
    slippageBps: Math.min(500, Math.max(0, Math.round(Number(btSlip) || 0))),
    feeBps: Math.min(500, Math.max(0, Math.round(Number(btFee) || 0))),
    spreadBps: Math.min(500, Math.max(0, Math.round(Number(btSpread) || 0))),
    days: Math.max(1, Math.round(Number(days) || 30)),
    capital: Number(capital) || 10000,
  }), [cfg, days, capital, btCooldown, btFresh, btSlip, btFee, btSpread])

  // live spread probe (Task 85) — polls the quote endpoint for cfg.symbol's
  // top of book every 60s and shows "≈X.X bps live" beside the Spread input;
  // clicking it seeds the input with the observed spread (best-effort: no
  // bid/ask from the feed → the hint simply stays hidden)
  useEffect(() => {
    setLiveSpreadBps(null)
    if (!cfg.symbol) return
    let dead = false
    const probe = async () => {
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: [cfg.symbol] }),
        })
        const json = await res.json().catch(() => null)
        const q = json?.quotes?.find?.((x: { symbol: string }) => x.symbol === cfg.symbol)
        const bid = typeof q?.bid === 'number' ? q.bid : null
        const ask = typeof q?.ask === 'number' ? q.ask : null
        if (!dead && bid != null && ask != null && bid > 0 && ask > bid) {
          const bps = ((ask - bid) / ((ask + bid) / 2)) * 1e4
          // sanity gate (Task 85): IEX-only NBBO can sit percent-wide and stale
          // off-hours — only hint on books within 100bps of mid, where the
          // number is a real calibration target rather than a stale print
          if (bps > 0 && bps <= 100) setLiveSpreadBps(bps)
        }
      } catch { /* hint is best-effort */ }
    }
    void probe()
    const iv = setInterval(probe, 60_000)
    return () => { dead = true; clearInterval(iv) }
  }, [cfg.symbol])

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

  const post = async (mode: 'run' | 'optimize' | 'sweep') => {
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
            : mode === 'sweep'
              ? {
                  minTrades: Math.max(1, Math.round(Number(minTrades) || 8)),
                  topX: Math.min(20, Math.max(1, Math.round(Number(topX) || 8))),
                }
              : {}),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`)
        toast({ title: mode === 'run' ? 'Backtest failed' : mode === 'optimize' ? 'Optimizer failed' : 'Strategy sweep failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      setMeta(json.meta ?? null)
      if (mode === 'run') {
        setRunRes(json.result ?? null)
        setOptRes(null)
      } else if (mode === 'optimize') {
        setOptRes(json.optimize ?? null)
        setRunRes(null)
      } else {
        setSweepRes(json.sweep ?? null)
        setRunRes(null)
        setOptRes(null)
      }
    } catch {
      setError('Network error')
      toast({ title: 'Request failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const applyRow = (params: Record<string, number>, strategy?: AlgoStrategyId) => {
    onApplyParams(params, strategy)
    toast({
      title: strategy && strategy !== cfg.strategy ? 'Strategy + parameters applied' : 'Parameters applied',
      description: strategy && strategy !== cfg.strategy
        ? `${ALGO_STRATEGIES[strategy].name} is now the run setup — review it and start the run when ready.`
        : 'Optimizer values copied into the run setup — start the run when ready.',
    })
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

  // coherent sizing gate (Task 78): risk mode needs a positive risk budget ($
  // or % — Task 78e) AND an SL % bracket (the stop distance is the risk unit);
  // fixed needs qty > 0
  const riskBudget = cfg.sizingMode === 'risk'
    ? (cfg.riskBasis === 'pct' ? (cfg.riskMoneyPct ?? 0) : (cfg.riskMoney ?? 0))
    : 0
  const sizingOk = cfg.sizingMode === 'risk'
    ? riskBudget > 0 && cfg.slMode === 'pct' && (cfg.slValue ?? 0) > 0
    : cfg.qty > 0

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
          <div>
            <Label htmlFor="bt-slip" className="text-[10px] text-zinc-500">Slippage (bps)</Label>
            <Input
              id="bt-slip"
              value={btSlip}
              onChange={(e) => setBtSlip(e.target.value)}
              onBlur={() => setBtSlip(String(Math.min(500, Math.max(0, Math.round(Number(btSlip) || 0)))))}
              inputMode="numeric"
              className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs"
            />
            <p className="mt-0.5 text-[9px] leading-tight text-zinc-600">adverse drift beyond the quote on market/stop fills</p>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="bt-spread" className="text-[10px] text-zinc-500">Spread (bps)</Label>
              {liveSpreadBps != null && (
                <button
                  type="button"
                  onClick={() => setBtSpread(String(Math.max(1, Math.round(liveSpreadBps))))}
                  title="Use the current live bid/ask spread"
                  className="text-[9px] text-amber-400/90 hover:text-amber-300"
                >
                  ≈{liveSpreadBps < 10 ? liveSpreadBps.toFixed(1) : Math.round(liveSpreadBps)} live
                </button>
              )}
            </div>
            <Input
              id="bt-spread"
              value={btSpread}
              onChange={(e) => setBtSpread(e.target.value)}
              onBlur={() => setBtSpread(String(Math.min(500, Math.max(0, Math.round(Number(btSpread) || 0)))))}
              inputMode="numeric"
              className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs"
            />
            <p className="mt-0.5 text-[9px] leading-tight text-zinc-600">bid/ask cost — half per market fill (buy at ask, sell at bid)</p>
          </div>
          <div>
            <Label htmlFor="bt-fee" className="text-[10px] text-zinc-500">Fee (bps / fill)</Label>
            <Input
              id="bt-fee"
              value={btFee}
              onChange={(e) => setBtFee(e.target.value)}
              onBlur={() => setBtFee(String(Math.min(500, Math.max(0, Math.round(Number(btFee) || 0)))))}
              inputMode="numeric"
              className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs"
            />
            <p className="mt-0.5 text-[9px] leading-tight text-zinc-600">notional fee per fill, entry + exit — costs scale with trade count</p>
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
              Fill model: entries at next-bar open · TP/SL intrabar (stop first) · strategy exits at bar close · EOD flatten fills at the 15:45 ET gate bar's OPEN (wall-clock parity with the live 15:45:00 exit — the gate bar's brackets are preempted). Slippage bps = impact beyond the quote on market/stop fills; spread bps = the bid/ask — half is charged per market fill (buys at ask, sells at bid) so a round trip pays it in full; TP is a resting limit and fills clean either way; fee bps charges every fill. Live diverges from ANY replay: entries/exits are market orders seconds after the close, % legs anchor on the fill-side quote (ask for buys, bid for sells — not the actual fill), and bars that closed while the engine was down never produce entries (exits are replayed). The algo journal logs the live spread on every ENTRY line — mirror it here. Paper fills price off SIP while stock bars come from IEX; crypto backtests deeper than ~35d on 5m read Alpaca while live crypto reads Binance. Cooldown blocks entries on bars opening within N minutes after a close; fresh-signal fires only on a false→true cross.
              {cfg.sizingMode === 'risk' && cfg.slMode === 'pct' && riskBudget > 0 && (
                <> Sizing: <span className="text-sky-400/90">Risk Money</span> — every trade is sized to risk ≈ {cfg.riskBasis === 'pct' ? `${cfg.riskMoneyPct}% of current equity (compounds with the simulated account)` : `$${cfg.riskMoney}`} to its stop (qty = risk ÷ (open × {cfg.slValue}%)), so size breathes with volatility.</>
              )}
              {cfg.sizingMode === 'risk' && !(cfg.slMode === 'pct' && (cfg.slValue ?? 0) > 0) && (
                <> <span className="text-amber-400">Risk Money sizing needs an SL % — turn Stop loss % ON in the run setup.</span></>
              )}
            </p>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            className="h-8 gap-2 bg-sky-600 px-3 text-xs text-white hover:bg-sky-500"
            disabled={busy !== null || !cfg.symbol || !sizingOk}
            title={!sizingOk ? (cfg.sizingMode === 'risk' ? 'Risk Money needs a positive risk $ / % and SL % ON in the run setup' : 'Set a positive quantity in the run setup') : undefined}
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
          <div className="flex items-center gap-1.5">
            <Button
              className="h-8 gap-2 bg-violet-600 px-3 text-xs text-white hover:bg-violet-500"
              disabled={busy !== null || !cfg.symbol || !sizingOk}
              title={!sizingOk
                ? (cfg.sizingMode === 'risk' ? 'Risk Money needs a positive risk $ / % and SL % ON in the run setup' : 'Set a positive quantity in the run setup')
                : 'Backtest every strategy at its defaults + an auto-tuned parameter grid, then rank the top X winners'}
              onClick={() => void post('sweep')}
            >
              {busy === 'sweep' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Test all strategies
            </Button>
            <Label htmlFor="bt-topx" className="text-[10px] text-zinc-500" title="How many winning configurations to list (1–20)">Top</Label>
            <Input
              id="bt-topx"
              value={topX}
              onChange={(e) => setTopX(e.target.value)}
              onBlur={() => setTopX(String(Math.min(20, Math.max(1, Math.round(Number(topX) || 8)))))}
              inputMode="numeric"
              aria-label="Number of sweep winners to list"
              className="h-8 w-14 border-zinc-800 bg-zinc-950 text-xs"
            />
          </div>
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
                disabled={busy !== null || activeRanges.length === 0 || !cfg.symbol || !sizingOk}
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
          {busy === 'run'
            ? 'Replaying history…'
            : busy === 'optimize'
              ? 'Searching parameter grid… this can take a few seconds'
              : 'Sweeping every strategy — defaults + auto-tuned grids for each… this can take 10–30s'}
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
                <Segmented
                  ariaLabel="Win/loss bucket size"
                  size="sm"
                  value={wlGran}
                  onChange={setWlGran}
                  options={[
                    { value: 'hour', label: 'Hour of day' },
                    { value: 'weekday', label: 'Day of week' },
                    { value: 'monthyear', label: 'Month of year' },
                  ]}
                />
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

      {/* strategy sweep result (Task 87) — top X across ALL strategies */}
      {sweepRes && (
        <div className="rounded-md border border-violet-500/25 bg-zinc-900/70">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Zap className="h-3.5 w-3.5 text-violet-400" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Strategy sweep — top {sweepRes.rows.length || sweepRes.topX}</span>
            <Badge variant="outline" className="text-[10px] text-zinc-400">{sweepRes.evaluated.toLocaleString('en-US')} backtests</Badge>
            <Badge variant="outline" className="text-[10px] text-zinc-400">min {sweepRes.minTrades} trades</Badge>
            <span className="text-[10px] text-zinc-600">{(sweepRes.elapsedMs / 1000).toFixed(1)}s</span>
          </div>
          {sweepRes.perStrategy.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-2">
              {sweepRes.perStrategy.map((ps) => (
                <Badge
                  key={ps.strategy}
                  variant="outline"
                  className="text-[9px] text-zinc-400"
                  title={`${ALGO_STRATEGIES[ps.strategy].name}: auto grid ${ps.totalCombos.toLocaleString('en-US')} combos → ${ps.evaluated.toLocaleString('en-US')} sims${ps.truncated ? ' (stride-sampled to the compute budget)' : ''}, ${ps.skipped} skipped, best score ${ps.bestScore != null ? ps.bestScore.toFixed(2) : 'none scorable'}`}
                >
                  <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ALGO_STRATEGIES[ps.strategy].color }} aria-hidden />
                  {ALGO_STRATEGIES[ps.strategy].name}: {ps.scorable} scorable
                </Badge>
              ))}
            </div>
          )}
          {sweepRes.rows.length === 0 ? (
            <p className="border-t border-zinc-800/60 px-3 py-4 text-center text-xs text-zinc-500">
              No strategy cleared {sweepRes.minTrades} trades on this window — lower the min-trades gate, widen the history, or relax the session/TP-SL gates.
            </p>
          ) : (
            <div className="max-h-96 overflow-auto border-t border-zinc-800/60 terminal-scroll" aria-label="Strategy sweep result table">
              <table className="w-full min-w-[680px] text-left text-[11px]">
                <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 font-medium">Strategy</th>
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
                  {sweepRes.rows.map((row, i) => (
                    <tr
                      key={`${row.strategy}-${i}`}
                      className={cn('cursor-pointer border-t border-zinc-800/40 hover:bg-zinc-900/60', i === 0 && 'bg-violet-500/5')}
                      onClick={() => applyRow(row.params, row.strategy)}
                      title="Click to apply this strategy + parameters to the run setup"
                    >
                      <td className="px-2.5 py-1.5 tabular-nums text-zinc-500">{i + 1}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: ALGO_STRATEGIES[row.strategy].color }} aria-hidden />
                          <span className={cn('font-medium', row.strategy === cfg.strategy ? 'text-zinc-100' : 'text-zinc-300')}>{ALGO_STRATEGIES[row.strategy].name}</span>
                          {row.strategy === cfg.strategy && <span className="text-[9px] uppercase text-zinc-500">setup</span>}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-zinc-300">
                        <span className="flex flex-wrap gap-x-2">
                          {Object.entries(row.params).map(([k, v]) => (
                            <span key={k} className="whitespace-nowrap">
                              <span className="text-zinc-500">{paramLabel(row.strategy, k)}</span> <span className="tabular-nums text-zinc-200">{v}</span>
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">{row.score.toFixed(2)}</td>
                      <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlColor(row.metrics.netPct))}>{fmtPct(row.metrics.netPct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.metrics.profitFactor >= 999 ? '∞' : row.metrics.profitFactor.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.metrics.winRate.toFixed(0)}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-rose-400/80">{row.metrics.maxDrawdownPct.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{row.metrics.trades}</td>
                      <td className="px-2.5 py-1.5 text-right">
                        {i === 0 && <Badge variant="outline" className="text-[9px] uppercase text-violet-300 border-violet-500/40">best</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-zinc-800/60 px-3 py-2 text-[10px] leading-snug text-zinc-600">
            Every strategy ran at its catalog defaults plus an auto-tuned grid (up to 5 values per numeric parameter, defaults always included, compute-budget
            stride-sampled — hover the badges above for per-strategy counts). Your qty / sizing / TP-SL / session gates and cost model were held fixed; only strategy
            parameters were optimized. Click a row to apply that strategy + parameters to the run setup, then re-run a single backtest and check the drawdown before
            going live. Past performance ≠ future results.
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
