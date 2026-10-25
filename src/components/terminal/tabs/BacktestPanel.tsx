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
//   • Cost suggestions (Task 88) — slippage/fee pre-seeded per market
//     (crypto majors 3/10, altcoins 10/10, US equities 2/0) with "suggested N"
//     chips to restore; a customized value is never stomped.
//   • Honesty surfacing (Task 4-a) — sweep/recommendation rows show their
//     walk-forward out-of-sample (OOS) re-run and grid-boundary flags, sizing
//     is leverage-honest (Lev = maxNotionalX), crypto short-skips are reported
//     as meta, and recharts moved behind next/dynamic (BacktestCharts.tsx).
import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  FlaskConical, RefreshCw, SlidersHorizontal, TrendingUp, Table2, Wand2, Zap, Sparkles, Check, Repeat, Dices,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  ALGO_STRATEGIES,
  ALGO_MAX_DAYS,
  type AlgoStrategyId, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import type { BacktestResult, OptimizeResult, SweepResult, WalkForwardResult } from '@/lib/backtest'
import type { MonteCarloResult } from '@/lib/algo-regime'
import { type AlgoRiskBasis, type AlgoSizingMode } from '@/lib/algo-strategies'
import { ALGO_RECOMMENDATIONS, ALGO_RECO_META, type AlgoRecommendation } from '@/lib/algo-recommendations'

// Task 89 — a recommendation loads the WHOLE run setup in one click
export interface AlgoApplySetup {
  symbol?: string
  timeframe?: AlgoTimeframe
  strategy?: AlgoStrategyId
  params?: Record<string, number>
}

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
  // Task 3-d accuracy meta — surfaced by the UI (Task 4-a)
  mtmDD?: boolean
  skippedShorts?: number
}

interface RangeState { on: boolean; min: string; max: string; step: string }

const fmtUsd = (v: number) =>
  (Math.abs(v) >= 1000 ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`)
const fmtPct = (v: number) => `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(2)}%`
const fmtPx = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4))
const fmtDayY = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
const fmtClockT = (t: number) =>
  new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

// Task 88 — market-typical execution costs (bps) so the cost model starts
// honest instead of frictionless:
//   crypto majors (BTC/ETH) — deep Binance books, ~3 bps slippage; Binance
//     spot taker fee is 0.1% = 10 bps per fill
//   altcoins — thinner books slip harder (10 bps), same 10 bps taker fee
//   US equities (Alpaca) — commission-free, ~2 bps slippage on large caps
const suggestCosts = (symbol: string): { slip: number; fee: number } => {
  if (symbol.includes('/')) {
    const base = symbol.split('/')[0]?.toUpperCase() ?? ''
    return base === 'BTC' || base === 'ETH' ? { slip: 3, fee: 10 } : { slip: 10, fee: 10 }
  }
  return { slip: 2, fee: 0 }
}

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

// Task 4-a — recharts (and @/components/ui/chart, which imports it) leave the
// main bundle: the equity + win/loss charts live in BacktestCharts.tsx and are
// loaded client-side only, with a matching skeleton while the chunk streams in.
const EquityChart = dynamic(() => import('./BacktestCharts').then((m) => m.EquityChart), {
  ssr: false,
  loading: () => (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3" aria-hidden>
      <Skeleton className="h-40 w-full bg-zinc-800/60" />
    </div>
  ),
})
const WlChart = dynamic(() => import('./BacktestCharts').then((m) => m.WlChart), {
  ssr: false,
  loading: () => (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3" aria-hidden>
      <Skeleton className="h-52 w-full bg-zinc-800/60" />
    </div>
  ),
})

export default function BacktestPanel({ cfg, onApplyParams, onApplySetup }: { cfg: AlgoSetupCfg; onApplyParams: (p: Record<string, number>, strategy?: AlgoStrategyId) => void; onApplySetup?: (s: AlgoApplySetup) => void }) {
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
  // Task 12 — vol-scaled slippage (improvement plan P1): scale the impact
  // component by THIS bar's ATR% vs the dataset average (clamped 0.5–3×).
  // No effect while slippage = 0; off = the constant-fill model.
  const [btDynSlip, setBtDynSlip] = useState(true)
  // Task 12 — walk-forward optimization (P0): folds, IS share, anchored mode,
  // pure hold-out fraction + the result card
  const [wfFolds, setWfFolds] = useState('3')
  const [wfIsPct, setWfIsPct] = useState('70')
  const [wfHoldout, setWfHoldout] = useState('20')
  const [wfAnchored, setWfAnchored] = useState(false)
  const [wfRes, setWfRes] = useState<WalkForwardResult | null>(null)
  const [mcRes, setMcRes] = useState<MonteCarloResult | null>(null)
  // Task 4-a — leverage-honest sizing: max position notional = capital × Lev
  // (route clamps 0.1..10; default 1 = cash-only, matching the baked reco runs)
  const [btLev, setBtLev] = useState('1')
  // Task 85 — live spread probe: the symbol's current bid/ask spread in bps,
  // surfaced next to the input so the cost model is calibrated, not guessed
  const [liveSpreadBps, setLiveSpreadBps] = useState<number | null>(null)
  // Task 88 — per-market slippage/fee suggestion, pre-seeded per symbol and
  // re-clickable via the chips beside each input
  const sugSlip = suggestCosts(cfg.symbol).slip
  const sugFee = suggestCosts(cfg.symbol).fee
  const sugRef = useRef<{ slip: number; fee: number } | null>(null)
  useEffect(() => {
    const prev = sugRef.current
    sugRef.current = { slip: sugSlip, fee: sugFee }
    // roll the suggestion forward only while a field still holds the previous
    // suggestion (or its untouched 0 default) — never stomp a customized value
    setBtSlip((p) => (prev == null || Math.round(Number(p) || 0) === prev.slip ? String(sugSlip) : p))
    setBtFee((p) => (prev == null || Math.round(Number(p) || 0) === prev.fee ? String(sugFee) : p))
  }, [sugSlip, sugFee])
  // Task 87 — one-click all-strategy sweep
  const [topX, setTopX] = useState('8')
  const [sweepRes, setSweepRes] = useState<SweepResult | null>(null)
  // Task 90 — live recommendations: painted instantly from the baked-in list,
  // then swapped for the persisted (DB) feed; a refresh POST re-sweeps the
  // whole matrix server-side and the table updates in place via polling
  const [recos, setRecos] = useState<AlgoRecommendation[]>(ALGO_RECOMMENDATIONS)
  const [recoMeta, setRecoMeta] = useState<{ generatedAt: string; method: string }>({
    generatedAt: ALGO_RECO_META.generatedAt,
    method: ALGO_RECO_META.method,
  })
  const [recoJob, setRecoJob] = useState<{ running: boolean; done: number; total: number } | null>(null)
  // Task 9-m — the sweep universe for THIS account (their watchlist symbols,
  // capped server-side); shown in the section header so the refresh target is explicit
  const [recoSymbols, setRecoSymbols] = useState<string[]>([])
  const [optOpen, setOptOpen] = useState(false)
  const [ranges, setRanges] = useState<Record<string, RangeState>>({})
  const [busy, setBusy] = useState<null | 'run' | 'optimize' | 'sweep' | 'walkforward'>(null)
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
    setMcRes(null)
  }, [cfg.strategy])

  // symbol / timeframe switch → the sweep was measured on other data
  useEffect(() => {
    setSweepRes(null)
    setWfRes(null)
  }, [cfg.symbol, cfg.timeframe])

  // Task 90 — pick up the persisted recommendations feed (and any refresh job
  // another tab may have started) once on mount
  useEffect(() => {
    let dead = false
    void (async () => {
      try {
        const res = await fetch('/api/algo/recommendations', { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        if (dead) return
        if (Array.isArray(j.rows) && j.rows.length > 0) {
          setRecos(j.rows)
          if (j.generatedAt) setRecoMeta({ generatedAt: j.generatedAt, method: j.method ?? ALGO_RECO_META.method })
        }
        if (Array.isArray(j.symbols)) setRecoSymbols(j.symbols)
        setRecoJob(j.running ? { running: true, done: j.done ?? 0, total: j.total ?? 21 } : null)
      } catch {
        /* recommendations stay baked-in */
      }
    })()
    return () => {
      dead = true
    }
  }, [])

  // Task 90 — while a refresh job runs, poll its progress and swap the list in
  // when the fresh sweep lands
  useEffect(() => {
    if (!recoJob?.running) return
    let dead = false
    const iv = setInterval(async () => {
      try {
        const res = await fetch('/api/algo/recommendations', { cache: 'no-store' })
        if (!res.ok) return
        const j = await res.json()
        if (dead) return
        if (Array.isArray(j.rows) && j.rows.length > 0) setRecos(j.rows)
        if (j.generatedAt) setRecoMeta((prev) => ({ generatedAt: j.generatedAt, method: j.method ?? prev.method }))
        if (Array.isArray(j.symbols)) setRecoSymbols(j.symbols)
        setRecoJob(j.running ? { running: true, done: j.done ?? 0, total: j.total ?? 21 } : null)
        if (!j.running) {
          if (j.lastError) {
            // Task 9-m — honesty: a mid-matrix abort (heap guard, feed outage)
            // must say so — the old list is still on screen, unchanged.
            toast({ title: 'Sweep stopped early', description: String(j.lastError).slice(0, 200), variant: 'destructive' })
          } else {
            toast({ title: 'Recommendations refreshed', description: `${Array.isArray(j.rows) ? j.rows.length : 0} setups re-swept on fresh bars — the list is updated.` })
          }
        }
      } catch {
        /* keep polling */
      }
    }, 3000)
    return () => {
      dead = true
      clearInterval(iv)
    }
  }, [recoJob?.running, toast])

  const refreshRecos = async () => {
    try {
      const res = await fetch('/api/algo/recommendations', { method: 'POST' })
      const j = await res.json().catch(() => null)
      if (!res.ok) {
        if (res.status === 409 && j?.running) {
          // someone (another tab) already started one — just follow it
          setRecoJob({ running: true, done: j.done ?? 0, total: j.total ?? 21 })
          return
        }
        toast({ title: 'Refresh failed', description: j?.error ?? `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      setRecoJob({ running: true, done: j.done ?? 0, total: j.total ?? 21 })
      if (Array.isArray(j.symbols)) setRecoSymbols(j.symbols)
      const symList = Array.isArray(j.symbols) ? (j.symbols as string[]) : []
      const symPreview = symList.length > 0 ? ` — ${symList.slice(0, 5).join(', ')}${symList.length > 5 ? ` +${symList.length - 5} more` : ''}` : ''
      toast({
        title: 'Sweep started',
        description: `Re-running ${j.total ?? 21} symbol × timeframe sweeps over your watchlist${symPreview} on fresh bars — the list updates when it finishes (a few minutes).`,
      })
    } catch {
      toast({ title: 'Request failed', description: 'Network error', variant: 'destructive' })
    }
  }

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
    // Task 12 — vol-scaled slippage (ATR% × impact, clamped 0.5–3×)
    dynSlip: btDynSlip,
    // Task 4-a — leverage-honest sizing cap (0.1..10; 1 = notional ≤ capital)
    maxNotionalX: Number(btLev) > 0 ? Math.min(10, Math.max(0.1, Number(btLev))) : 1,
    days: Math.max(1, Math.round(Number(days) || 30)),
    capital: Number(capital) || 10000,
  }), [cfg, days, capital, btCooldown, btFresh, btSlip, btFee, btSpread, btLev, btDynSlip])

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

  const post = async (mode: 'run' | 'optimize' | 'sweep' | 'walkforward') => {
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
                  // Task 4-a — walk-forward on by default (parity with the reco
                  // methodology): tune on the first 70% of bars, then re-run
                  // the winners untouched on the last 30% → rows carry oos/boundary
                  oosFraction: 0.3,
                }
              : mode === 'walkforward'
                ? {
                    // Task 12 — full walk-forward optimization: re-optimize on
                    // every fold's in-sample window, verify on its OOS segment,
                    // stress the survivor on a pure hold-out tail
                    ranges: activeRanges,
                    minTrades: Math.max(1, Math.round(Number(minTrades) || 8)),
                    folds: Math.min(6, Math.max(2, Math.round(Number(wfFolds) || 3))),
                    isFraction: Math.min(0.9, Math.max(0.5, (Number(wfIsPct) || 70) / 100)),
                    holdoutFraction: Math.min(0.4, Math.max(0, (Number(wfHoldout) || 0) / 100)),
                    anchored: wfAnchored,
                  }
                : {}),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`)
        toast({ title: mode === 'run' ? 'Backtest failed' : mode === 'optimize' ? 'Optimizer failed' : mode === 'walkforward' ? 'Walk-forward failed' : 'Strategy sweep failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      setMeta(json.meta ?? null)
      if (mode === 'run') {
        setRunRes(json.result ?? null)
        setMcRes(json.mc ?? null)
        setOptRes(null)
      } else if (mode === 'optimize') {
        setOptRes(json.optimize ?? null)
        setRunRes(null)
        setMcRes(null)
      } else if (mode === 'walkforward') {
        setWfRes(json.walkforward ?? null)
        setRunRes(null)
        setOptRes(null)
        setMcRes(null)
      } else {
        setSweepRes(json.sweep ?? null)
        setRunRes(null)
        setOptRes(null)
        setMcRes(null)
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

  // Task 89 — apply a baked-in recommendation: costs first (local state — the
  // suggestion-seeding effect only rolls fields still holding a previous
  // suggestion, so these stick), then the whole setup via the parent
  const applyRec = (rec: AlgoRecommendation) => {
    setBtSlip(String(rec.slipBps))
    setBtFee(String(rec.feeBps))
    setBtSpread(String(rec.spreadBps))
    // Task 4-a — baked setups were measured with the honest 1× capital cap
    setBtLev('1')
    // widen the history to the window the setup was MEASURED on (capped per TF)
    // — otherwise a 30d re-run would not reproduce the baked-in numbers
    setDays(String(Math.min(ALGO_MAX_DAYS[rec.timeframe] ?? 30, Math.max(1, Math.round(rec.coveredDays)))))
    onApplySetup?.({ symbol: rec.symbol, timeframe: rec.timeframe, strategy: rec.strategy, params: rec.params })
    toast({
      title: 'Recommended setup applied',
      description: `${rec.symbol} ${rec.timeframe} · ${ALGO_STRATEGIES[rec.strategy].name} — costs seeded ${rec.slipBps}/${rec.feeBps}/${rec.spreadBps} bps. Hit "Run backtest" to verify on fresh bars.`,
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Label htmlFor="bt-lev" className="w-fit cursor-help text-[10px] text-zinc-500 underline decoration-dotted decoration-zinc-600 underline-offset-2">
                  Lev (× capital)
                </Label>
              </TooltipTrigger>
              <TooltipContent className="max-w-60 border-zinc-700 bg-zinc-800 text-zinc-100">
                Max position notional as × of capital. 1 = cash-only (honest). Crypto baked results use 1×.
              </TooltipContent>
            </Tooltip>
            <Input
              id="bt-lev"
              value={btLev}
              onChange={(e) => setBtLev(e.target.value)}
              onBlur={() => setBtLev(String(Number(btLev) > 0 ? Math.min(10, Math.max(0.1, Number(btLev))) : 1))}
              inputMode="decimal"
              className="h-8 mt-1 border-zinc-800 bg-zinc-950 text-xs"
            />
            <p className="mt-0.5 text-[9px] leading-tight text-zinc-600">notional cap per position — 1 = no leverage</p>
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
            <div className="flex items-center justify-between">
              <Label htmlFor="bt-slip" className="text-[10px] text-zinc-500">Slippage (bps)</Label>
              <button
                type="button"
                onClick={() => setBtSlip(String(sugSlip))}
                title={`Market-typical slippage for ${cfg.symbol || 'this market'} — click to use`}
                className="text-[9px] text-emerald-400/90 hover:text-emerald-300"
              >
                suggested {sugSlip}
              </button>
            </div>
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
            <div className="flex items-center justify-between">
              <Label htmlFor="bt-fee" className="text-[10px] text-zinc-500">Fee (bps / fill)</Label>
              <button
                type="button"
                onClick={() => setBtFee(String(sugFee))}
                title={cfg.symbol.includes('/') ? 'Binance taker fee 0.1% = 10 bps per fill — click to use' : 'Alpaca is commission-free — click to use'}
                className="text-[9px] text-emerald-400/90 hover:text-emerald-300"
              >
                suggested {sugFee}
              </button>
            </div>
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
          <div className="flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Label htmlFor="bt-dynslip" className="w-fit cursor-help text-[10px] leading-tight text-zinc-500 underline decoration-dotted decoration-zinc-600 underline-offset-2">
                    Vol-scaled slip (ATR)
                  </Label>
                </TooltipTrigger>
                <TooltipContent className="max-w-64 border-zinc-700 bg-zinc-800 text-zinc-100">
                  Slippage impact = bps × (bar ATR% ÷ dataset average), clamped 0.5–3×. Spread and fee stay flat. No effect while slippage = 0. Off = constant fills.
                </TooltipContent>
              </Tooltip>
              <Switch id="bt-dynslip" checked={btDynSlip} onCheckedChange={setBtDynSlip} className="scale-90" />
            </div>
            <p className="text-[9px] leading-tight text-zinc-600">impact breathes with volatility — high-ATR bars pay more</p>
          </div>
          <div className="col-span-2 flex items-end sm:col-span-4">
            <p className="text-[10px] leading-snug text-zinc-500">
              Fill model: entries at next-bar open · TP/SL intrabar (stop first) · strategy exits at bar close · EOD flatten fills at the 15:45 ET gate bar's OPEN (wall-clock parity with the live 15:45:00 exit — the gate bar's brackets are preempted). Slippage bps = impact beyond the quote on market/stop fills; spread bps = the bid/ask — half is charged per market fill (buys at ask, sells at bid) so a round trip pays it in full; TP is a resting limit and fills clean either way; fee bps charges every fill. Vol-scaled slip multiplies the impact by the bar's ATR% vs the dataset average (clamped 0.5–3×). Regime gates (200-SMA trend / ADX chop / half-life) veto entries that fight the regime — they live in the strategy parameters and are mirrored 1:1 by the live engine. Live diverges from ANY replay: entries/exits are market orders seconds after the close, % legs anchor on the fill-side quote (ask for buys, bid for sells — not the actual fill), and bars that closed while the engine was down never produce entries (exits are replayed). The algo journal logs the live spread on every ENTRY line — mirror it here. Paper fills price off SIP while stock bars come from IEX; crypto backtests deeper than ~35d on 5m read Alpaca while live crypto reads Binance. Cooldown blocks entries on bars opening within N minutes after a close; fresh-signal fires only on a false→true cross.
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
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              className="h-8 gap-2 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
              disabled={busy !== null || !cfg.symbol || !sizingOk || activeRanges.length === 0}
              title={!sizingOk
                ? (cfg.sizingMode === 'risk' ? 'Risk Money needs a positive risk $ / % and SL % ON in the run setup' : 'Set a positive quantity in the run setup')
                : activeRanges.length === 0
                  ? 'Tick parameters in Auto-tune first — walk-forward re-optimizes them on every fold'
                  : 'Re-optimize on every fold\'s in-sample window, verify out-of-sample per fold, then stress the survivor on a pure hold-out tail'}
              onClick={() => void post('walkforward')}
            >
              {busy === 'walkforward' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Repeat className="h-3.5 w-3.5" />}
              Walk-forward
            </Button>
            <Label className="text-[10px] text-zinc-500" htmlFor="bt-wf-folds">Folds</Label>
            <Input
              id="bt-wf-folds"
              value={wfFolds}
              onChange={(e) => setWfFolds(e.target.value)}
              onBlur={() => setWfFolds(String(Math.min(6, Math.max(2, Math.round(Number(wfFolds) || 3)))))}
              inputMode="numeric"
              aria-label="Walk-forward folds (2–6)"
              className="h-8 w-12 border-zinc-800 bg-zinc-950 text-xs"
            />
            <Label className="text-[10px] text-zinc-500" htmlFor="bt-wf-is">IS %</Label>
            <Input
              id="bt-wf-is"
              value={wfIsPct}
              onChange={(e) => setWfIsPct(e.target.value)}
              onBlur={() => setWfIsPct(String(Math.min(90, Math.max(50, Math.round(Number(wfIsPct) || 70)))))}
              inputMode="numeric"
              aria-label="Walk-forward in-sample share percent"
              className="h-8 w-12 border-zinc-800 bg-zinc-950 text-xs"
            />
            <Label className="text-[10px] text-zinc-500" htmlFor="bt-wf-ho">Hold-out %</Label>
            <Input
              id="bt-wf-ho"
              value={wfHoldout}
              onChange={(e) => setWfHoldout(e.target.value)}
              onBlur={() => setWfHoldout(String(Math.min(40, Math.max(0, Math.round(Number(wfHoldout) || 0)))))}
              inputMode="numeric"
              aria-label="Pure hold-out tail percent (0–40)"
              className="h-8 w-12 border-zinc-800 bg-zinc-950 text-xs"
            />
            <div className="flex items-center gap-1">
              <Switch id="bt-wf-anch" checked={wfAnchored} onCheckedChange={setWfAnchored} className="scale-90" aria-label="Anchored walk-forward windows" />
              <Label htmlFor="bt-wf-anch" className="text-[10px] text-zinc-500" title="Anchored = each fold tunes on everything from the start (expanding IS). Off = rolling fixed-length IS window immediately before each out-of-sample segment.">Anchored</Label>
            </div>
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
          {(meta.skippedShorts ?? 0) > 0 && (
            <p className="text-[11px] text-zinc-500" role="note">
              {(meta.skippedShorts ?? 0).toLocaleString('en-US')} crypto short signals skipped (Alpaca crypto is long-only)
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
              : busy === 'walkforward'
                ? 'Walk-forward: re-optimizing on every fold, verifying out-of-sample, stress-testing the hold-out… this can take 10–60s'
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
            <Metric label="Max drawdown (MTM)" value={fmtPct(-m.maxDrawdownPct)} sub={fmtUsd(-m.maxDrawdown)} cls="text-rose-400" />
            <Metric label="Trades" value={String(m.trades)} sub={`${m.longs}L · ${m.shorts}S${m.openAtEnd ? ' · 1 open' : ''}`} cls="text-zinc-100" />
            <Metric label="Expectancy" value={fmtUsd(m.expectancy)} sub="per trade" cls={pnlColor(m.expectancy)} />
            <Metric label="Avg hold" value={`${m.avgHoldMin < 90 ? `${Math.round(m.avgHoldMin)}m` : `${(m.avgHoldMin / 60).toFixed(1)}h`}`} sub={`${m.tradesPerWeek.toFixed(1)} trades/wk`} cls="text-zinc-100" />
            <Metric label="Final equity" value={fmtUsd(m.finalEquity)} sub={m.suppressed > 0 ? `${m.suppressed} signals gated` : 'gates: none hit'} cls="text-zinc-100" />
          </div>

          {/* Task 12 — Monte Carlo bootstrap (improvement plan P2): resample the
              realized trade sequence to estimate how much of the edge is luck */}
          {mcRes && (
            <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Dices className="h-3.5 w-3.5 text-sky-400" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Monte Carlo</span>
                <Badge variant="outline" className="text-[10px] text-zinc-400" title="Bootstrap resampling of the realized trade sequence (with replacement, seeded — deterministic)">
                  {mcRes.iters.toLocaleString('en-US')} bootstraps · {mcRes.trades} trades
                </Badge>
                <span className={cn('text-[11px] tabular-nums', mcRes.probLoss > 0.2 ? 'text-amber-400' : 'text-zinc-400')}>
                  P(loss) {(mcRes.probLoss * 100).toFixed(1)}%
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] tabular-nums text-zinc-400">
                <span>net% <span className="text-rose-400">p5 {fmtPct(mcRes.netPctP5)}</span></span>
                <span>p50 <span className="text-zinc-200">{fmtPct(mcRes.netPctP50)}</span></span>
                <span>p95 <span className="text-emerald-400">{fmtPct(mcRes.netPctP95)}</span></span>
                <span>max DD% p50 {mcRes.maxDDPctP50.toFixed(1)} · p95 {mcRes.maxDDPctP95.toFixed(1)}</span>
              </div>
              <p className="mt-1 text-[9px] leading-snug text-zinc-600">
                Sequence-risk stress: the same trades replayed in {mcRes.iters.toLocaleString('en-US')} random orders. A green backtest whose p5 lands deep negative has a
                thin edge — the order of wins/losses (and the drawdown it can produce) is luck. Use p5 / max-DD p95 as the honest sizing budget.
              </p>
            </div>
          )}

          <EquityChart data={eqData} />

          {runRes.trades.length > 0 && (
            <WlChart rows={wlRows} gran={wlGran} onGran={setWlGran} total={runRes.trades.length} />
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
                    <ThTip label="Score" tip="net% ÷ max drawdown% (Calmar-style, higher = better risk-adjusted)" right />
                    <th className="px-2 py-1.5 font-medium text-right">Net %</th>
                    <ThTip label="PF" tip="profit factor = gross profit ÷ gross loss" right />
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
          {/* Task 12 — plateau analysis on the winner (improvement plan P1) */}
          {optRes.sensitivity && optRes.sensitivity.length > 0 && optRes.best && optRes.best.score > -Infinity && (
            <div className="border-t border-zinc-800/60 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Best-row sensitivity (±1 grid step)</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {optRes.sensitivity.map((s) => (
                  <Badge
                    key={s.key}
                    variant="outline"
                    className="text-[10px] tabular-nums text-zinc-400"
                    title={`Re-running the winner with ${paramLabel(cfg.strategy, s.key)} one grid step lower/higher scores ${s.down ?? '—'} / ${s.up ?? '—'} (best ${optRes.best!.score.toFixed(2)}). Null = the step falls outside the grid.`}
                  >
                    {paramLabel(cfg.strategy, s.key)}: {s.down == null ? '—' : s.down.toFixed(2)} / {s.up == null ? '—' : s.up.toFixed(2)}
                  </Badge>
                ))}
                {optRes.plateau && (
                  <Badge
                    variant="outline"
                    className={optRes.plateau.ok ? 'border-emerald-500/40 text-[10px] text-emerald-400' : 'border-amber-500/40 text-[10px] text-amber-400'}
                    title={`Mean neighbor score ${optRes.plateau.meanNeighborScore.toFixed(2)} = ${(optRes.plateau.ratio * 100).toFixed(0)}% of the winner. ≥70% = broad plateau (robust), below = fragile peak (likely overfit).`}
                  >
                    {optRes.plateau.ok ? 'plateau ✓ stable' : '⚠ fragile peak'}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-[9px] leading-snug text-zinc-600">
                Only accept winners whose neighborhood holds up — a broad plateau survives re-optimization and regime drift; a sharp parameter peak is overfitting.
              </p>
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
            {sweepRes.oosFraction != null && sweepRes.oosFraction > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] text-emerald-400/90"
                title={`Walk-forward: tuning ran on the first ${Math.round((1 - sweepRes.oosFraction) * 100)}% of bars (in-sample) — the top rows were then re-run untouched on the last ${Math.round(sweepRes.oosFraction * 100)}% (out-of-sample → OOS column)`}
              >
                {Math.round((1 - sweepRes.oosFraction) * 100)}/{Math.round(sweepRes.oosFraction * 100)} IS/OOS
              </Badge>
            )}
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
              <table className="w-full min-w-[780px] text-left text-[11px]">
                <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">#</th>
                    <th className="px-2 py-1.5 font-medium">Strategy</th>
                    <th className="px-2 py-1.5 font-medium">Parameters</th>
                    <ThTip label="Score" tip="net% ÷ max drawdown% (Calmar-style, higher = better risk-adjusted)" right />
                    <ThTip label="OOS" tip="out-of-sample: metrics re-measured on the most recent 30% of bars, unseen by optimization" right />
                    <th className="px-2 py-1.5 font-medium text-right">Net %</th>
                    <ThTip label="PF" tip="profit factor = gross profit ÷ gross loss" right />
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
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {Object.entries(row.params).map(([k, v]) => (
                            <span key={k} className="whitespace-nowrap">
                              <span className="text-zinc-500">{paramLabel(row.strategy, k)}</span> <span className="tabular-nums text-zinc-200">{v}</span>
                            </span>
                          ))}
                          {row.boundary && <BoundaryChip />}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">{row.score.toFixed(2)}</td>
                      <OosCell oos={row.oos} />
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

      {/* walk-forward optimization result (Task 12 — improvement plan P0) */}
      {wfRes && (
        <div className="rounded-md border border-emerald-500/25 bg-zinc-900/70">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Repeat className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Walk-forward optimization</span>
            <Badge variant="outline" className="text-[10px] text-zinc-400">{wfRes.mode}</Badge>
            <Badge variant="outline" className="text-[10px] text-zinc-400">{wfRes.folds.length} fold{wfRes.folds.length === 1 ? '' : 's'} re-optimized</Badge>
            {wfRes.holdoutFraction > 0 && (
              <Badge variant="outline" className="text-[10px] text-emerald-400/90" title="The last X% of bars was carved off BEFORE any tuning — no fold ever saw it. The survivor parameter set was then re-run on it untouched.">
                {Math.round(wfRes.holdoutFraction * 100)}% pure hold-out
              </Badge>
            )}
            <span className="text-[10px] text-zinc-600">{wfRes.evaluated.toLocaleString('en-US')} sims · {(wfRes.elapsedMs / 1000).toFixed(1)}s</span>
          </div>
          {wfRes.holdoutDisabled && (
            <p className="mx-3 mb-2 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-300" role="note">{wfRes.holdoutDisabled}</p>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-3 pb-2 text-[11px]">
            <span className="text-zinc-500">
              Robustness{' '}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
                    <span className={cn('font-semibold tabular-nums', wfRes.aggregate.robustness == null ? 'text-zinc-500' : wfRes.aggregate.robustness >= 0.6 ? 'text-emerald-400' : wfRes.aggregate.robustness > 0 ? 'text-amber-400' : 'text-rose-400')}>
                      {wfRes.aggregate.robustness == null ? '—' : `${wfRes.aggregate.positiveFolds}/${wfRes.aggregate.foldsValid} (${Math.round(wfRes.aggregate.robustness * 100)}%)`}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-64 border-zinc-700 bg-zinc-800 text-zinc-100">
                  Share of folds whose out-of-sample window (re-optimized in-sample each fold, then verified untouched) stayed profitable. This is the realistic expectation for live trading.
                </TooltipContent>
              </Tooltip>
            </span>
            <span className="text-zinc-500">median OOS <span className={cn('font-semibold tabular-nums', pnlColor(wfRes.aggregate.oosNetMedian ?? 0))}>{wfRes.aggregate.oosNetMedian == null ? '—' : fmtPct(wfRes.aggregate.oosNetMedian)}</span></span>
            <span className="text-zinc-500">mean OOS <span className={cn('font-semibold tabular-nums', pnlColor(wfRes.aggregate.oosNetMean ?? 0))}>{wfRes.aggregate.oosNetMean == null ? '—' : fmtPct(wfRes.aggregate.oosNetMean)}</span></span>
            <span className="text-zinc-500">
              <span title="Share of folds whose optimizer picked the SAME parameters — high stability means a broad, trustworthy optimum; every fold picking different params is noise.">
                param stability
              </span>{' '}
              <span className="font-semibold tabular-nums text-zinc-200">{wfRes.aggregate.paramStability == null ? '—' : `${Math.round(wfRes.aggregate.paramStability * 100)}%`}</span>
            </span>
            {wfRes.holdout && (
              <span className="text-zinc-500">
                hold-out <span className={cn('font-semibold tabular-nums', pnlColor(wfRes.holdout.netPct))}>{fmtPct(wfRes.holdout.netPct)}</span>
                <span className="text-zinc-600"> · {wfRes.holdout.trades} trades · win {wfRes.holdout.winRate.toFixed(0)}% · DD {wfRes.holdout.maxDrawdownPct.toFixed(1)}%</span>
              </span>
            )}
          </div>
          {wfRes.folds.length === 0 ? (
            <p className="border-t border-zinc-800/60 px-3 py-4 text-center text-xs text-zinc-500">
              No fold produced a tunable winner — widen the history, tick more parameters in Auto-tune, or lower the min-trades gate.
            </p>
          ) : (
            <div className="max-h-96 overflow-auto border-t border-zinc-800/60 terminal-scroll" aria-label="Walk-forward fold table">
              <table className="w-full min-w-[860px] text-left text-[11px]">
                <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">Fold</th>
                    <th className="px-2 py-1.5 font-medium">In-sample window</th>
                    <th className="px-2 py-1.5 font-medium text-right">IS net %</th>
                    <th className="px-2 py-1.5 font-medium text-right">IS score</th>
                    <th className="px-2 py-1.5 font-medium">OOS window</th>
                    <ThTip label="OOS net %" tip="the fold's winner re-run untouched on bars it was never tuned on" right />
                    <th className="px-2 py-1.5 font-medium text-right">Win %</th>
                    <th className="px-2 py-1.5 font-medium text-right">PF</th>
                    <th className="px-2 py-1.5 font-medium text-right">DD %</th>
                    <th className="px-2 py-1.5 font-medium text-right">Trades</th>
                    <th className="px-2 py-1.5 font-medium">Fold winner (click to apply)</th>
                    <th className="px-2.5 py-1.5 font-medium" aria-label="Flags" />
                  </tr>
                </thead>
                <tbody>
                  {wfRes.folds.map((f) => (
                    <tr
                      key={f.fold}
                      className={cn('border-t border-zinc-800/40 hover:bg-zinc-900/60', Object.keys(f.params).length > 0 && 'cursor-pointer')}
                      onClick={() => Object.keys(f.params).length > 0 && applyRow(f.params)}
                      title={Object.keys(f.params).length > 0 ? 'Click to apply this fold\'s winning parameters to the run setup' : 'This fold produced no tunable winner'}
                    >
                      <td className="px-2.5 py-1.5 tabular-nums text-zinc-500">{f.fold}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-zinc-400">{fmtDayY(f.isFrom)} → {fmtDayY(f.isTo)}</td>
                      <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlColor(f.isNetPct))}>{f.isTrades > 0 ? fmtPct(f.isNetPct) : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{f.isScore == null ? '—' : f.isScore.toFixed(2)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-zinc-400">{fmtDayY(f.oosFrom)} → {fmtDayY(f.oosTo)}</td>
                      <td className={cn('px-2 py-1.5 text-right tabular-nums', f.oosTrades > 0 ? pnlColor(f.oosNetPct) : 'text-zinc-600')}>{f.oosTrades > 0 ? fmtPct(f.oosNetPct) : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{f.oosTrades > 0 ? `${f.oosWinRate.toFixed(0)}%` : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{f.oosTrades > 0 ? (f.oosPF >= 999 ? '∞' : f.oosPF.toFixed(2)) : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-rose-400/80">{f.oosTrades > 0 ? f.oosMaxDDPct.toFixed(2) : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{f.oosTrades > 0 ? f.oosTrades : '—'}</td>
                      <td className="px-2 py-1.5 text-zinc-300">
                        <span className="flex flex-wrap gap-x-2">
                          {Object.entries(f.params).map(([k, v]) => (
                            <span key={k} className="whitespace-nowrap">
                              <span className="text-zinc-500">{paramLabel(cfg.strategy, k)}</span> <span className="tabular-nums text-zinc-200">{v}</span>
                            </span>
                          ))}
                          {Object.keys(f.params).length === 0 && <span className="text-zinc-600">no scorable winner</span>}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5">
                        {f.boundary && <BoundaryChip />}
                        {!f.oosValid && f.oosTrades > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span tabIndex={0} className="ml-1 inline-flex cursor-help items-center rounded border border-zinc-600/40 px-1 py-px text-[9px] uppercase text-zinc-500">thin</span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-56 border-zinc-700 bg-zinc-800 text-zinc-100">OOS window produced fewer than 3 trades — not evidence either way</TooltipContent>
                          </Tooltip>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-zinc-800/60 px-3 py-2 text-[10px] leading-snug text-zinc-600">
            Each fold re-runs the full grid search on its in-sample window (rolling: a fixed window right before the OOS segment · anchored: everything from the
            start), then replays the winner untouched on its out-of-sample segment. Report the DISTRIBUTION — {wfRes.aggregate.positiveFolds}/{wfRes.aggregate.foldsValid || 0} valid folds stayed
            profitable OOS — not the best in-sample row. The pure hold-out tail was never available to any fold. Past performance ≠ future results.
          </p>
        </div>
      )}

      {/* recommended setups (Task 89/90) — full-catalog sweep winners, refreshable */}
      {recos.length > 0 && (
        <div className="rounded-md border border-emerald-500/25 bg-zinc-900/70">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Recommended setups</span>
            <Badge variant="outline" className="text-[10px] text-zinc-400">{recos.length} configs</Badge>
            <Badge variant="outline" className="text-[10px] text-zinc-400">
              swept {new Date(recoMeta.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </Badge>
            {recoSymbols.length > 0 && (
              <Badge
                variant="outline"
                className="max-w-[320px] truncate text-[10px] text-zinc-400"
                title={`Refresh sweeps YOUR watchlist symbols × 3 timeframes (1m/5m/15m): ${recoSymbols.join(', ')}`}
              >
                {recoSymbols.length} watchlist symbols
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-[10px] text-zinc-600 sm:inline">click a row to load the whole setup — symbol · TF · strategy · params · costs</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 border-emerald-500/30 bg-zinc-950 px-2 text-[10px] text-emerald-300 hover:bg-zinc-900"
                onClick={refreshRecos}
                disabled={recoJob?.running === true}
                title="Re-run the sweep matrix over your watchlist symbols × 3 timeframes on fresh bars (a few minutes) — the list updates in place when it lands"
              >
                <RefreshCw className={cn('h-3 w-3', recoJob?.running && 'animate-spin')} aria-hidden />
                {recoJob?.running ? `Sweeping ${recoJob.done}/${recoJob.total}` : 'Refresh'}
              </Button>
            </div>
          </div>
          <p className="px-3 pb-1.5 text-[11px] text-zinc-500">
            Sweeps YOUR watchlist (fallback: BTC/USD ETH/USD SOL/USD TSLA AAPL NVDA SPY) · max 1× capital per position (no leverage) · mark-to-market DD · crypto long-only · 70/30 IS/OOS walk-forward
          </p>
          <div className="max-h-96 overflow-auto border-t border-zinc-800/60 terminal-scroll" aria-label="Recommended setups table">
            <table className="w-full min-w-[860px] text-left text-[11px]">
              <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-2.5 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">Market</th>
                  <th className="px-2 py-1.5 font-medium">Strategy</th>
                  <th className="px-2 py-1.5 font-medium">Parameters</th>
                  <ThTip label="Costs bps" tip="slippage bps / fee bps / spread bps — bps = basis points, 1bp = 0.01% of price" right />
                  <ThTip label="Score" tip="net% ÷ max drawdown% (Calmar-style, higher = better risk-adjusted)" right />
                  <ThTip label="OOS" tip="out-of-sample: metrics re-measured on the most recent 30% of bars, unseen by optimization" right />
                  <th className="px-2 py-1.5 font-medium text-right">Net %</th>
                  <ThTip label="PF" tip="profit factor = gross profit ÷ gross loss" right />
                  <th className="px-2 py-1.5 font-medium text-right">Win %</th>
                  <th className="px-2 py-1.5 font-medium text-right">Max DD %</th>
                  <th className="px-2 py-1.5 font-medium text-right">Trades</th>
                  <th className="px-2.5 py-1.5 font-medium" aria-label="Apply" />
                </tr>
              </thead>
              <tbody>
                {recos.map((rec, i) => {
                  const isHere = rec.symbol === cfg.symbol && rec.timeframe === cfg.timeframe
                  return (
                    <tr
                      key={`${rec.symbol}-${rec.timeframe}-${rec.strategy}-${i}`}
                      className={cn('cursor-pointer border-t border-zinc-800/40 hover:bg-zinc-900/60', isHere && 'bg-emerald-500/5')}
                      onClick={() => applyRec(rec)}
                      title={`Apply: ${rec.symbol} ${rec.timeframe} · ${ALGO_STRATEGIES[rec.strategy].name} — measured over ${rec.coveredDays}d / ${rec.bars.toLocaleString('en-US')} bars (${rec.source}) with ${rec.slipBps}/${rec.feeBps}/${rec.spreadBps} bps costs`}
                    >
                      <td className="px-2.5 py-1.5 tabular-nums text-zinc-500">{i + 1}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-medium text-zinc-200">
                        {rec.symbol} <span className="text-zinc-500">{rec.timeframe}</span>
                        {isHere && <span className="ml-1 text-[9px] uppercase text-emerald-400">this</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: ALGO_STRATEGIES[rec.strategy].color }} aria-hidden />
                          <span className="text-zinc-300">{ALGO_STRATEGIES[rec.strategy].name}</span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-zinc-300">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {Object.entries(rec.params).map(([k, v]) => (
                            <span key={k} className="whitespace-nowrap">
                              <span className="text-zinc-500">{paramLabel(rec.strategy, k)}</span> <span className="tabular-nums text-zinc-200">{v}</span>
                            </span>
                          ))}
                          {rec.boundary && <BoundaryChip />}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-zinc-400" title="slippage / fee / spread (bps) this setup was measured with">
                        {rec.slipBps}/{rec.feeBps}/{rec.spreadBps}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">{rec.score.toFixed(2)}</td>
                      <OosCell oos={rec.oos} />
                      <td className={cn('px-2 py-1.5 text-right tabular-nums', pnlColor(rec.netPct))}>{fmtPct(rec.netPct)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{rec.pf >= 999 ? '∞' : rec.pf.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{rec.winPct.toFixed(0)}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-rose-400/80">{rec.maxDDPct.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{rec.trades}</td>
                      <td className="px-2.5 py-1.5 text-right">
                        {i === 0 && <Badge variant="outline" className="text-[9px] uppercase text-emerald-300 border-emerald-500/40">best</Badge>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-zinc-800/60 px-3 py-2 text-[10px] leading-snug text-zinc-600">
            Community sweep — {recoMeta.method}
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

// Task 4-a — table header with an explanation tooltip (shadcn Tooltip); the
// dotted underline is the affordance that the header is hoverable.
function ThTip({ label, tip, right }: { label: string; tip: string; right?: boolean }) {
  return (
    <th className={cn('px-2 py-1.5 font-medium', right && 'text-right')}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 border-zinc-700 bg-zinc-800 text-zinc-100">{tip}</TooltipContent>
      </Tooltip>
    </th>
  )
}

// Task 4-a — walk-forward OOS cell: signed net % with honest badges.
//   null      → "—" (OOS window produced < 3 trades — not evidence either way)
//   undefined → "—" (row was swept before walk-forward existed)
function OosCell({ oos }: { oos?: { netPct: number } | null }) {
  if (oos == null) {
    return (
      <td
        className="px-2 py-1.5 text-right tabular-nums text-zinc-600"
        title={oos === null ? 'insufficient out-of-sample trades' : 'no out-of-sample verification (swept before walk-forward was on)'}
      >
        —
      </td>
    )
  }
  const pos = oos.netPct > 0
  const neg = oos.netPct < 0
  return (
    <td className="px-2 py-1.5 text-right">
      <span className="inline-flex items-center justify-end gap-1">
        {pos && (
          <span className="text-emerald-400" aria-label="OOS re-run also profitable" title="OOS window (last 30% of bars) also profitable — verified">
            <Check className="h-3 w-3" aria-hidden />
          </span>
        )}
        {neg && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label="OOS window lost money — in-sample flattery"
                className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-amber-500/15 text-[9px] font-bold leading-none text-amber-400"
              >
                !
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-56 border-amber-500/30 bg-zinc-800 text-amber-200">
              Out-of-sample window (last 30% of bars) lost money — in-sample flattery
            </TooltipContent>
          </Tooltip>
        )}
        <span className={cn('tabular-nums', pos ? 'text-emerald-400' : neg ? 'text-rose-400' : 'text-zinc-300')}>
          {pos ? '+' : ''}{oos.netPct.toFixed(2)}%
        </span>
      </span>
    </td>
  )
}

// Task 4-a — "edge" chip: a tuned param sits on its search-grid min/max
// (weakest evidence — the optimum may lie beyond the searched range).
function BoundaryChip() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label="Optimized parameter on grid boundary"
          className="inline-flex cursor-help items-center whitespace-nowrap rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[9px] font-medium uppercase leading-tight text-amber-400/90"
        >
          edge
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-56 border-amber-500/30 bg-zinc-800 text-amber-200">
        Optimized param sits on the search-grid boundary — fragile optimum
      </TooltipContent>
    </Tooltip>
  )
}
