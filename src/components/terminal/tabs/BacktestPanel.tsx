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
  FlaskConical, RefreshCw, TrendingDown, Table2, Wand2, ChevronDown, ChevronUp, Check, Dices, ShieldCheck, Zap, Repeat, Sparkles, TriangleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  ALGO_STRATEGIES,
  ALGO_REGIME_PRESETS,
  MTF_TREND_TF,
  MTF_MID_TF,
  algoMaxDays,
  applyRegimePreset,
  isSwingTf,
  normalizeAlgoParams,
  strategyLane,
  type AlgoRegimePresetId,
  type AlgoStrategyId, type AlgoTimeframe,
} from '@/lib/algo-strategies'
import type { BacktestResult, BacktestMetrics, OptimizeResult, SweepResult, WalkForwardResult } from '@/lib/backtest'
import type { MonteCarloResult, RegimeGateStats } from '@/lib/algo-regime'
// v1.99.1 — pipeline flow chart: blinking yellow phase → green done → golden result
import { BacktestFlowChart, type BtFlowMode } from '@/components/terminal/tabs/BacktestFlowChart'
// v2.2.0 — BACKTEST STUDIO: the 5-step wizard + its shared state contract
// (StudioState is OWNED here and feeds the POST body — one source of truth)
import BacktestStudio from './backtest/BacktestStudio'
import {
  LEVEL_META, makeStudioState, suggestCosts, tradeMtf,
  type BtBusy, type BtLevel, type RangeState, type StudioState,
} from './backtest/studio-state'
// v1.99.0 — trust layer: per-trade significance + plain-language verdicts
import { trustVerdict, TRUST_LEVEL_STYLE, type SignificanceStats, type TrustVerdict } from '@/lib/backtest-stats'
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
  tpMode: 'none' | 'pct' | 'atr'
  tpValue: number | null
  slMode: 'none' | 'pct' | 'atr'
  slValue: number | null
  /** v1.96.0 — ATR(14) timeframes when the mode is 'atr' */
  tpTf?: string | null
  slTf?: string | null
  // v1.97.0 — trailing exit (mirrors the live run config); required so the
  // shared setup stays structurally an AlpoRunConfig for config export
  trailMode: 'off' | 'pct'
  trailArmPct: number | null
  trailGivePct: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin: number
  requireNewSignal: boolean
  /** v2.0.0 — the shared setup's live-run Kronos gate (backtests ignore it —
   * the backtest-side Kronos feature is the separate kronos-ab validation
   * level; carrying the field keeps setupCfg structurally an AlpoRunConfig
   * for config export). */
  kronosGate: boolean
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
  // v2.2.0 — swing lane: the resolved MTF ladder + aggregated HTF bar/level counts
  mtf?: { trendTf: string; midTf: string; trendBars: number; midBars: number; levels: number } | null
}

// v2.2.0 — RangeState / BtLevel / LEVEL_META live in ./backtest/studio-state
// (shared with the wizard); BtLevel is re-exported for backward compatibility.
export type { BtLevel } from './backtest/studio-state'

const fmtUsd = (v: number) =>
  (Math.abs(v) >= 1000 ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`)
const fmtPct = (v: number) => `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(2)}%`
const fmtPx = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4))
const fmtDayY = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
const fmtClockT = (t: number) =>
  new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
// v1.80.1 — scores travel as JSON: the engine scores below-minTrades rows as
// -Infinity, which JSON.stringify coerces to `null` on the wire — so a raw
// `.toFixed(2)` crashed the whole panel ("Cannot read properties of null")
// whenever an optimizer table contained a non-scorable row. Render null /
// non-finite as '—' (not scorable) at every score cell instead.
const fmtScore = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2))

// Task 88 — market-typical execution costs moved to ./backtest/studio-state
// (suggestCosts) so the wizard and the panel share one cost-seeding source.

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

// v1.99.0 — normalize a wire-traveled SignificanceStats: jsonSafe turns every
// NaN into null, so every numeric field must be re-validated before math/format
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN
}

/**
 * v1.99.0 — THE TRUST STRIP. The Backtest panel used to render point
 * estimates only (net%, PF, WR) and the user had to guess whether 21 trades
 * of +23 bps meant anything. This card turns the per-trade distribution into
 * a plain-language verdict — SIGNIFICANT / PROMISING / WITHIN NOISE / NO EDGE
 * / UNTESTABLE — with the numbers that back it (t, two-sided p, day-block
 * bootstrap 95% CI, trades still needed) and the honest caveats (in-sample
 * winner's curse, frictionless runs, out-of-sample purity).
 */
function TrustStrip({ label, sig: sigRaw, verdict, compact = false }: { label: string; sig: SignificanceStats | null | undefined; verdict: TrustVerdict | null | undefined; compact?: boolean }) {
  if (!verdict) return null
  const st = TRUST_LEVEL_STYLE[verdict.level]
  const sig = sigRaw
    ? {
        n: num(sigRaw.n),
        meanBps: num(sigRaw.meanBps),
        sdBps: num(sigRaw.sdBps),
        t: num(sigRaw.t),
        p: num(sigRaw.p),
        ciLo: num(sigRaw.ciLo),
        ciHi: num(sigRaw.ciHi),
        tradesNeeded: num(sigRaw.tradesNeeded),
        costBps: num(sigRaw.costBps),
      }
    : null
  return (
    <div className={cn('rounded-md border bg-zinc-900/70 px-3 py-2.5', st.border)} role="status" aria-label={`Trust verdict: ${verdict.title}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className={cn('h-3.5 w-3.5 shrink-0', st.text)} aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
        <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', st.border, st.text)}>
          <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} aria-hidden />
          {st.label}
        </span>
        <span className={cn('text-[11px] font-semibold', st.text)}>{verdict.title}</span>
        {sig && Number.isFinite(sig.tradesNeeded) && (
          <Badge variant="outline" className="ml-auto text-[10px] tabular-nums text-zinc-400" title="Trades needed for t ≈ 2 (95% confidence) at the observed edge/σ ratio — collect them forward, don't re-tune the same window">
            ≈{sig.tradesNeeded} trades to confirm
          </Badge>
        )}
      </div>
      <p className={cn('mt-1 leading-snug text-zinc-400', compact ? 'text-[9px]' : 'text-[10px]')}>{verdict.detail}</p>
      {sig && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] tabular-nums text-zinc-500">
          <span>n <span className="text-zinc-300">{Number.isFinite(sig.n) ? sig.n : '—'}</span></span>
          <span>edge <span className={cn(Number.isFinite(sig.meanBps) ? (sig.meanBps > 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-300')}>
            {Number.isFinite(sig.meanBps) ? `${sig.meanBps >= 0 ? '+' : ''}${sig.meanBps.toFixed(1)} bps/trd` : '—'}
          </span></span>
          <span>95% CI <span className={cn(Number.isFinite(sig.ciLo) && sig.ciLo > 0 ? 'text-emerald-400' : 'text-zinc-300')}>
            {Number.isFinite(sig.ciLo) ? `[${sig.ciLo.toFixed(1)}, ${sig.ciHi.toFixed(1)}]` : '—'}
          </span></span>
          <span>t <span className="text-zinc-300">{Number.isFinite(sig.t) ? sig.t.toFixed(2) : '—'}</span></span>
          <span>p <span className="text-zinc-300">{Number.isFinite(sig.p) ? (sig.p < 0.0001 ? '<0.0001' : sig.p.toFixed(4)) : '—'}</span></span>
          <span>σ <span className="text-zinc-300">{Number.isFinite(sig.sdBps) ? `${sig.sdBps.toFixed(0)} bps` : '—'}</span></span>
          <span>costs <span className="text-zinc-300">{sig.costBps > 0 ? `${sig.costBps} bps RT` : 'frictionless'}</span></span>
        </div>
      )}
    </div>
  )
}

export default function BacktestPanel({ cfg, onApplyParams, onApplySetup }: { cfg: AlgoSetupCfg; onApplyParams: (p: Record<string, number>, strategy?: AlgoStrategyId) => void; onApplySetup?: (s: AlgoApplySetup) => void }) {
  const { toast } = useToast()
  // v2.2.0 — BACKTEST STUDIO: the wizard's single source of truth (spec §2.1).
  // Seeded from the shared run setup on mount; the POST body below is built
  // from it, and day-lane strategy/param edits mirror back via onApplyParams.
  const [studio, setStudio] = useState<StudioState>(() => makeStudioState(cfg))
  const patchStudio = (p: Partial<StudioState>) => setStudio((s) => ({ ...s, ...p }))
  const [minTrades, setMinTrades] = useState('8')
  // re-entry control (Task 70-c) — seeded from the run setup, editable in
  // wizard step ④ (day lane only — swing forces them off server-side)
  const [btCooldown, setBtCooldown] = useState('0')
  const [btFresh, setBtFresh] = useState(false)
  // Task 12 — walk-forward optimization (P0): folds, IS share, anchored mode,
  // pure hold-out fraction + the result card
  const [wfFolds, setWfFolds] = useState('3')
  const [wfIsPct, setWfIsPct] = useState('70')
  const [wfHoldout, setWfHoldout] = useState('20')
  const [wfAnchored, setWfAnchored] = useState(false)
  const [wfRes, setWfRes] = useState<WalkForwardResult | null>(null)
  // v2.0.0 — Kronos gate A/B result (ungated baseline vs model-gated replay)
  interface KronosAbSide { trades: number; netPct: number; winRate: number; pf: number; expectancy: number; maxDDPct: number }
  interface KronosAbResult { base: KronosAbSide; gated: KronosAbSide; gateVetoed: number; forecasts: number; forecastFailed: number; origins: number; horizon: number; windowBars: number; model: string; avgUpProb: number | null; elapsedSec: number; windowFrom: number; windowTo: number }
  const [krAbRes, setKrAbRes] = useState<KronosAbResult | null>(null)
  const [mcRes, setMcRes] = useState<MonteCarloResult | null>(null)
  // v1.99.0 — TRUST verdict for the plain run / optimizer best row (computed
  // server-side on the actual per-trade P&L). Walk-forward verdicts are
  // derived client-side from wfRes.aggregate.oosSig / wfRes.holdout.sig.
  const [trustRes, setTrustRes] = useState<{ basis: 'plain' | 'in-sample'; sig: SignificanceStats | null; verdict: TrustVerdict | null } | null>(null)
  // Task 4-a — leverage-honest sizing: max position notional = capital × Lev
  // (route clamps 0.1..10; default 1 = cash-only, matching the baked reco runs)
  const [btLev, setBtLev] = useState('1')
  // Task 85 — live spread probe: the symbol's current bid/ask spread in bps,
  // surfaced next to the input so the cost model is calibrated, not guessed
  const [liveSpreadBps, setLiveSpreadBps] = useState<number | null>(null)
  // Task 88 — per-market slippage/fee suggestion, pre-seeded per symbol and
  // re-clickable via the chips beside each input
  const sugSlip = suggestCosts(studio.symbol).slip
  const sugFee = suggestCosts(studio.symbol).fee
  const sugRef = useRef<{ slip: number; fee: number } | null>(null)
  useEffect(() => {
    const prev = sugRef.current
    sugRef.current = { slip: sugSlip, fee: sugFee }
    // roll the suggestion forward only while a field still holds the previous
    // suggestion (or its untouched 0 default) — never stomp a customized value
    setStudio((s) => ({
      ...s,
      slippageBps: prev == null || Math.round(Number(s.slippageBps) || 0) === prev.slip ? String(sugSlip) : s.slippageBps,
      feeBps: prev == null || Math.round(Number(s.feeBps) || 0) === prev.fee ? String(sugFee) : s.feeBps,
    }))
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
  const [busy, setBusy] = useState<null | 'run' | 'optimize' | 'sweep' | 'walkforward' | 'kronos-ab'>(null)
  const [error, setError] = useState<string | null>(null)
  // Task 15 — live progress of a background optimizer job (heavy modes run
  // detached server-side; this mirrors the GET ?job= poll stream).
  // v1.99.1 — `phase` is the structured pipeline phase for the flow chart.
  const [job, setJob] = useState<{ frac: number; stage: string; phase?: string; elapsedSec: number } | null>(null)
  // v1.99.1 — flow chart: which pipeline is drawn + its outcome. It stays on
  // screen after completion (all green + golden result) until the next run.
  const [flowMode, setFlowMode] = useState<BtFlowMode | null>(null)
  const [flowDone, setFlowDone] = useState(false)
  const [flowError, setFlowError] = useState(false)
  // inline 'run' has no job poll — a lightweight client-side estimate walks
  // fetch → prepare → replay while the request is in flight; the real
  // response finalizes the chart (all green + golden) on arrival.
  const [runHint, setRunHint] = useState<'fetch' | 'prepare' | 'replay'>('fetch')
  const runHintTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  // v1.99.1 — last REAL phase seen from the server (heavy modes). On failure
  // the job record is gone but the chart must still paint the node that was
  // executing red — so remember it here.
  const lastPhaseRef = useRef<string>('fetch')
  const startRunHint = () => {
    runHintTimers.current.forEach(clearTimeout)
    setRunHint('fetch')
    runHintTimers.current = [
      setTimeout(() => setRunHint('prepare'), 1100),
      setTimeout(() => setRunHint('replay'), 2400),
    ]
  }
  const stopRunHint = () => {
    runHintTimers.current.forEach(clearTimeout)
    runHintTimers.current = []
  }
  useEffect(() => stopRunHint, [])
  const [meta, setMeta] = useState<BacktestMeta | null>(null)
  const [runRes, setRunRes] = useState<BacktestResult | null>(null)
  const [optRes, setOptRes] = useState<OptimizeResult | null>(null)
  // Review P0 #4 — gates-off A/B: re-runs the SAME config with every regime
  // gate forced off so the gated run can be quantified against its raw baseline
  const [abRes, setAbRes] = useState<{ netPct: number; trades: number; profitFactor: number; winRate: number } | null>(null)
  const [abBusy, setAbBusy] = useState(false)
  // v1.98.0 — trailing PROOF A/B: re-runs the SAME config with the trail forced
  // off (the pre-1.97 exit behavior) so the trail's impact on THIS window is
  // measured, not guessed. Only meaningful when the run setup has the trail on.
  const [trailAbRes, setTrailAbRes] = useState<BacktestMetrics | null>(null)
  const [trailAbBusy, setTrailAbBusy] = useState(false)
  // win/loss breakdown granularity (Task 71-2)
  const [wlGran, setWlGran] = useState<BtGran>('hour')

  // v2.1.0 — BACKTEST STUDIO rewiring: one guided pipeline instead of five
  // sibling buttons. `level` is the step-⑤ choice; the CTA posts its mode;
  // the flow chart is always on stage (idle → blinking → golden).
  const [level, setLevel] = useState<BtLevel>('wf')
  const [recosOpen, setRecosOpen] = useState(false)
  // v2.2.0 — the wizard owns its own step refs/scrolling; the panel anchors
  // only the results region (success scroll) and the CTA (failure scroll).
  const resRef = useRef<HTMLDivElement | null>(null)
  const ctaRef = useRef<HTMLDivElement | null>(null)
  const scrollRes = () => resRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // v2.2.0 — the wizard's strategy def drives the optimizer grid + labels
  const def = ALGO_STRATEGIES[studio.strategy]

  // strategy switch (run setup OR wizard-local swing edit) → drop stale
  // results + ranges (the SWEEP survives: it is a cross-strategy artifact —
  // applying a sweep row switches the strategy and the ranked list must stay
  // on screen)
  useEffect(() => {
    setRanges({})
    setRunRes(null)
    setOptRes(null)
    setMeta(null)
    setError(null)
    setMcRes(null)
    setAbRes(null)
    setKrAbRes(null)
    setFlowMode(null) // v1.99.1 — the old pipeline belongs to the old strategy
  }, [cfg.strategy, studio.strategy])

  // symbol / timeframe switch (either surface) → the sweep was measured on other data
  useEffect(() => {
    setSweepRes(null)
    setWfRes(null)
    setAbRes(null)
    setKrAbRes(null)
  }, [cfg.symbol, cfg.timeframe, studio.symbol, studio.entryTf])

  // v2.2.0 — spec §2.1 sync rules: the wizard's symbol FOLLOWS the shared run
  // setup when it changes externally (reco apply, header symbol switch…).
  // Wizard-local edits flow the other way only for day-lane strategy/params.
  useEffect(() => {
    setStudio((s) => (s.symbol === cfg.symbol || !cfg.symbol ? s : { ...s, symbol: cfg.symbol }))
  }, [cfg.symbol])

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

  // v2.2.0 — the POST body is built from the WIZARD state (StudioState).
  // Field-by-field source map (contract §1.2 keeps validating every field):
  //   symbol/timeframe/strategy/params · sizing/brackets/trail · session guards
  //   ← studio (seeded from cfg, editable in steps ①–④)
  //   cooldown/fresh ← panel state (day lane only — swing sends them off)
  //   mtf ← derived from MTF_TREND_TF/MTF_MID_TF for swing (server also
  //   derives it if omitted); day lane omits the field entirely.
  const payload = useMemo(() => {
    const swing = studio.lane === 'swing'
    const riskOn = studio.sizingMode === 'risk'
    return {
      symbol: studio.symbol,
      timeframe: studio.entryTf,
      strategy: studio.strategy,
      params: studio.params,
      // the route requires qty > 0 even in risk mode (where the engine ignores
      // it) — floor at 1 so Risk-Money runs never 400 on a blank qty field
      qty: Math.max(Number(studio.qty) || 0, riskOn ? 1 : 0),
      sizingMode: studio.sizingMode,
      riskBasis: riskOn ? studio.riskBasis : 'usd',
      riskMoney: riskOn && studio.riskBasis !== 'pct' ? (Number(studio.riskMoney) > 0 ? Number(studio.riskMoney) : null) : null,
      riskMoneyPct: riskOn && studio.riskBasis === 'pct' ? (Number(studio.riskMoneyPct) > 0 ? Number(studio.riskMoneyPct) : null) : null,
      tpMode: studio.tpOn ? studio.tpUnit : 'none',
      tpValue: studio.tpOn && Number(studio.tpPct) > 0 ? Number(studio.tpPct) : null,
      tpTf: studio.tpOn && studio.tpUnit === 'atr' ? (studio.tpTf ?? null) : null,
      slMode: studio.slOn ? studio.slUnit : 'none',
      slValue: studio.slOn && Number(studio.slPct) > 0 ? Number(studio.slPct) : null,
      slTf: studio.slOn && studio.slUnit === 'atr' ? (studio.slTf ?? null) : null,
      trailMode: studio.trailOn ? 'pct' : 'off',
      trailArmPct: studio.trailOn && Number(studio.trailArm) > 0 ? Number(studio.trailArm) : null,
      trailGivePct: studio.trailOn && Number(studio.trailGive) > 0 ? Number(studio.trailGive) : null,
      // swing lane: the server forces these off regardless (§1.2) — mirror it
      maxTradesDay: swing ? 0 : Math.max(0, Math.round(Number(studio.maxTradesDay) || 0)),
      rthOnly: swing ? false : studio.rthOnly,
      flattenEod: swing ? false : studio.flattenEod,
      cooldownMin: swing ? 0 : Math.min(240, Math.max(0, Math.round(Number(btCooldown) || 0))),
      requireNewSignal: swing ? false : btFresh,
      slippageBps: Math.min(500, Math.max(0, Math.round(Number(studio.slippageBps) || 0))),
      feeBps: Math.min(500, Math.max(0, Math.round(Number(studio.feeBps) || 0))),
      spreadBps: Math.min(500, Math.max(0, Math.round(Number(studio.spreadBps) || 0))),
      // Task 12 — vol-scaled slippage (ATR% × impact, clamped 0.5–3×)
      dynSlip: studio.dynSlip,
      // Task 4-a — leverage-honest sizing cap (0.1..10; 1 = notional ≤ capital)
      maxNotionalX: Number(studio.lev) > 0 ? Math.min(10, Math.max(0.1, Number(studio.lev))) : 1,
      days: Math.max(1, Math.round(Number(studio.days) || 30)),
      capital: Number(studio.capital) || 10000,
      // v2.2.0 — swing lane tells the engine which HTFs confirm (§1.4)
      ...(swing && isSwingTf(studio.entryTf)
        ? { mtf: { trendTf: MTF_TREND_TF[studio.entryTf], midTf: MTF_MID_TF[studio.entryTf] } }
        : {}),
    }
  }, [studio, btCooldown, btFresh])

  // live spread probe (Task 85) — polls the quote endpoint for the WIZARD
  // symbol's top of book every 60s and shows "≈X.X bps live" beside the Spread
  // input; clicking it seeds the input with the observed spread (best-effort:
  // no bid/ask from the feed → the hint simply stays hidden)
  useEffect(() => {
    setLiveSpreadBps(null)
    if (!studio.symbol) return
    let dead = false
    const probe = async () => {
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: [studio.symbol] }),
        })
        const json = await res.json().catch(() => null)
        const q = json?.quotes?.find?.((x: { symbol: string }) => x.symbol === studio.symbol)
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
  }, [studio.symbol])

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
    // Task 19 — the virtual TP/SL % dims ride the same range state and are
    // sent as ordinary ranges (the engine lifts them onto the config brackets)
    for (const key of ['tpValue', 'slValue'] as const) {
      const r = ranges[key]
      if (!r?.on) continue
      const min = Number(r.min)
      const max = Number(r.max)
      const step = Number(r.step)
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || max <= min || step <= 0) continue
      out.push({ key, min, max, step })
    }
    return out
  }, [def, ranges])

  const failToast = (mode: 'run' | 'optimize' | 'sweep' | 'walkforward' | 'kronos-ab', description: string) => {
    toast({
      title: mode === 'run' ? 'Backtest failed' : mode === 'optimize' ? 'Optimizer failed' : mode === 'walkforward' ? 'Walk-forward failed' : mode === 'kronos-ab' ? 'Kronos gate A/B failed' : 'Strategy sweep failed',
      description,
      variant: 'destructive',
    })
  }

  // Task 15 — one result-application path shared by the inline response and
  // the background-job poll (the wire shapes are identical)
  const applyResult = (mode: 'run' | 'optimize' | 'sweep' | 'walkforward' | 'kronos-ab', json: unknown) => {
    const j = (json ?? {}) as {
      meta?: BacktestMeta | null
      result?: BacktestResult | null
      mc?: MonteCarloResult | null
      optimize?: OptimizeResult | null
      walkforward?: WalkForwardResult | null
      sweep?: SweepResult | null
      kronosAb?: KronosAbResult | null
      trust?: { sig: SignificanceStats | null; verdict: TrustVerdict | null } | null
    }
    setMeta(j.meta ?? null)
    // v2.2.1 — every branch clears EVERY other validation panel: the results
    // header promises 'each validation replaces the previous view', but sweep
    // used to leave the previous walk-forward (and vice versa) rendered below.
    if (mode === 'run') {
      setRunRes(j.result ?? null)
      setMcRes(j.mc ?? null)
      setTrustRes({ basis: 'plain', sig: j.trust?.sig ?? null, verdict: j.trust?.verdict ?? null })
      setOptRes(null)
      setAbRes(null) // a fresh baseline invalidates the gates-off A/B
      setTrailAbRes(null) // a fresh run invalidates the trail-proof A/B
      setWfRes(null)
      setSweepRes(null)
      setKrAbRes(null)
    } else if (mode === 'optimize') {
      setOptRes(j.optimize ?? null)
      setTrustRes({ basis: 'in-sample', sig: j.trust?.sig ?? null, verdict: j.trust?.verdict ?? null })
      setRunRes(null)
      setMcRes(null)
      setWfRes(null)
      setSweepRes(null)
      setKrAbRes(null)
    } else if (mode === 'walkforward') {
      setWfRes(j.walkforward ?? null)
      setTrustRes(null)
      setRunRes(null)
      setOptRes(null)
      setMcRes(null)
      setSweepRes(null)
      setKrAbRes(null)
    } else if (mode === 'kronos-ab') {
      setKrAbRes(j.kronosAb ?? null)
      setRunRes(null)
      setOptRes(null)
      setMcRes(null)
      setTrustRes(null)
      setWfRes(null)
      setSweepRes(null)
    } else {
      setSweepRes(j.sweep ?? null)
      setTrustRes(null)
      setRunRes(null)
      setOptRes(null)
      setMcRes(null)
      setWfRes(null)
      setKrAbRes(null)
    }
  }

  // Task 15 — poll a background optimizer job to completion. Heavy modes
  // (optimize/sweep/walkforward) return 202 {jobId} and run DETACHED
  // server-side, so no HTTP request lives long enough to be killed by proxy
  // timeouts (Render's edge ≈100s) or pod churn — no more 502-with-no-result.
  // v1.99.1 — resolves true when a result landed (flow chart → golden),
  // false on any failure/timeout (flow chart → red node).
  const pollJob = async (mode: 'optimize' | 'sweep' | 'walkforward' | 'kronos-ab', jobId: string): Promise<boolean> => {
    const deadline = Date.now() + 20 * 60_000
    for (;;) {
      if (Date.now() > deadline) {
        setError('Job still running after 20 minutes')
        failToast(mode, 'Still running after 20 minutes — try a shorter period')
        return false
      }
      await new Promise((r) => setTimeout(r, 1500))
      let res: Response
      try {
        res = await fetch(`/api/algo/backtest?job=${encodeURIComponent(jobId)}`, { cache: 'no-store' })
      } catch {
        setError('Network error')
        failToast(mode, 'Network error while polling the optimizer job')
        return false
      }
      const pj = (await res.json().catch(() => null)) as {
        status?: string; mode?: string; phase?: string; frac?: number; stage?: string; elapsedSec?: number; error?: string
      } | null
      if (!res.ok) {
        const msg = pj?.error || `HTTP ${res.status}`
        setError(msg)
        failToast(mode, msg)
        return false
      }
      if (pj?.status === 'running') {
        if (pj.phase) lastPhaseRef.current = String(pj.phase)
        setJob({
          frac: Number(pj.frac) || 0,
          stage: String(pj.stage || ''),
          phase: pj.phase ? String(pj.phase) : undefined,
          elapsedSec: Number(pj.elapsedSec) || 0,
        })
        continue
      }
      setJob(null)
      if (pj?.status === 'error') {
        const msg = pj.error || 'Optimizer failed'
        setError(msg)
        failToast(mode, msg)
        return false
      }
      applyResult(mode, pj)
      return true
    }
  }

  const post = async (mode: 'run' | 'optimize' | 'sweep' | 'walkforward' | 'kronos-ab') => {
    setBusy(mode)
    setError(null)
    setJob(null)
    // v1.99.1 — draw the pipeline for THIS run: reset to a fresh chart and,
    // for the inline run, start the client-side phase estimate
    setFlowMode(mode)
    setFlowDone(false)
    setFlowError(false)
    lastPhaseRef.current = 'fetch'
    if (mode === 'run') startRunHint()
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
      // Task 15 — heavy modes come back as 202 {jobId}: poll to completion
      if (res.status === 202 && json?.jobId) {
        // mode === 'run' can never 202 (the route runs it inline) — narrow for pollJob
        const ok = mode === 'run' ? false : await pollJob(mode, String(json.jobId))
        if (ok) {
          setFlowDone(true)
          // v2.1.0 — head-to-end: when the pipeline lands, take the user to it
          setTimeout(scrollRes, 400)
        } else {
          setFlowError(true)
          setTimeout(() => ctaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400)
        }
        return
      }
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`)
        failToast(mode, json?.error || `HTTP ${res.status}`)
        setFlowError(true)
        return
      }
      applyResult(mode, json)
      setFlowDone(true)
      // v2.1.0 — head-to-end: land on the result when the run completes
      setTimeout(scrollRes, 400)
    } catch {
      setError('Network error')
      setFlowError(true)
      toast({ title: 'Request failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusy(null)
      setJob(null)
      stopRunHint()
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

  // Task 89 — apply a baked-in recommendation: costs/window/lev land in the
  // WIZARD state (the suggestion-seeding effect only rolls fields still
  // holding a previous suggestion, so these stick), then the run-setup slice
  // (symbol · tf · strategy · params) flows through onApplySetup as before
  const applyRec = (rec: AlgoRecommendation) => {
    setStudio((s) => ({
      ...s,
      symbol: rec.symbol,
      entryTf: rec.timeframe,
      lane: strategyLane(rec.strategy),
      strategy: rec.strategy,
      params: normalizeAlgoParams(rec.strategy, rec.params),
      // widen the history to the window the setup was MEASURED on (capped per
      // TF/asset — stocks 1m reach 180d, crypto 1m 45d) — otherwise a 30d
      // re-run would not reproduce the baked-in numbers
      days: String(Math.min(algoMaxDays(rec.timeframe, rec.symbol.includes('/')), Math.max(1, Math.round(rec.coveredDays)))),
      slippageBps: String(rec.slipBps),
      feeBps: String(rec.feeBps),
      spreadBps: String(rec.spreadBps),
      lev: '1', // Task 4-a — baked setups were measured with the honest 1× capital cap
    }))
    onApplySetup?.({ symbol: rec.symbol, timeframe: rec.timeframe, strategy: rec.strategy, params: rec.params })
    toast({
      title: 'Recommended setup applied',
      description: `${rec.symbol} ${rec.timeframe} · ${ALGO_STRATEGIES[rec.strategy].name} — costs seeded ${rec.slipBps}/${rec.feeBps}/${rec.spreadBps} bps. Hit "Run backtest" to verify on fresh bars.`,
    })
  }

  // Review P0 #4 — quantified gates-off A/B: the exact same run config with
  // every regime gate forced to 0. One inline request (fast single sim, the
  // 2-min bar cache makes it cheap) whose summary lands beside the gated run:
  // "gates removed X% net / N trades" is the honest measure of what the
  // filters cost — the review's immediate step 3, one click.
  const runGateAb = async () => {
    setAbBusy(true)
    try {
      const res = await fetch('/api/algo/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          mode: 'run',
          params: { ...studio.params, regimeTrend: 0, regimeAdx: 0, hlGate: 0 },
        }),
      })
      const json = await res.json().catch(() => null)
      const mm = (json as { result?: { metrics?: { netPct?: number; trades?: number; profitFactor?: number; winRate?: number } } } | null)?.result?.metrics
      if (!res.ok || !mm) {
        toast({ title: 'A/B run failed', description: (json as { error?: string } | null)?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      setAbRes({ netPct: mm.netPct ?? 0, trades: mm.trades ?? 0, profitFactor: mm.profitFactor ?? 0, winRate: mm.winRate ?? 0 })
    } catch {
      toast({ title: 'A/B run failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setAbBusy(false)
    }
  }

  // v1.98.0 — trailing PROOF A/B ("prove the performance before and after
  // trailing applied"): replays the EXACT same window/config with trailMode
  // forced off — the pre-trailing engine — and keeps its metrics so the card
  // below can render BEFORE vs AFTER side by side. Same inline-request pattern
  // as the gates A/B: one fast sim on the 2-min-cached bars.
  const runTrailAb = async () => {
    setTrailAbBusy(true)
    try {
      const res = await fetch('/api/algo/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, mode: 'run', trailMode: 'off', trailArmPct: null, trailGivePct: null }),
      })
      const json = await res.json().catch(() => null)
      const mm = (json as { result?: { metrics?: BacktestMetrics } } | null)?.result?.metrics
      if (!res.ok || !mm) {
        toast({ title: 'Trail A/B run failed', description: (json as { error?: string } | null)?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      setTrailAbRes(mm)
    } catch {
      toast({ title: 'Trail A/B run failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setTrailAbBusy(false)
    }
  }

  // Review P0 #2 / P1 #6 — one-click regime presets: Research flips every
  // gate off + frictionless costs (raw rule edge); Live Candidate arms the
  // full gate package (strategy-aware — RSI-2 keeps its own trend filter,
  // ORB gets only the momentum gate) + realistic costs, per timeframe.
  // v2.2.0 — presets target the WIZARD config: day lane mirrors the gate
  // package into the run setup (existing parity), swing lane keeps it
  // wizard-local (applyRegimePreset no-ops the gates for swing strategies).
  const applyPreset = (id: AlgoRegimePresetId) => {
    const p = ALGO_REGIME_PRESETS[id]
    const presetParams = normalizeAlgoParams(studio.strategy, applyRegimePreset(id, studio.strategy, studio.entryTf, studio.params))
    setStudio((s) => ({
      ...s,
      params: presetParams,
      regimePreset: id,
      slippageBps: String(p.costs.slippageBps),
      feeBps: String(p.costs.feeBps),
      spreadBps: String(p.costs.spreadBps),
      dynSlip: p.costs.dynSlip,
    }))
    if (studio.lane === 'day') onApplyParams(presetParams, studio.strategy)
    toast({ title: `${p.label} preset applied`, description: p.blurb })
  }

  // v2.1.0 — one-click default grid: tick every numeric strategy parameter at
  // its native min→max:step so Walk-forward is runnable straight from the
  // studio CTA without a detour through Auto-tune (gate-inert dims are still
  // sent; the engine drops them and the UI flags them inline).
  const useDefaultGrid = () => {
    const next: Record<string, RangeState> = {}
    for (const p of def.params) {
      if (p.bool) continue
      next[p.key] = { on: true, min: String(p.min), max: String(p.max), step: String(p.step) }
    }
    setRanges(next)
    toast({ title: 'Default grid armed', description: `${Object.keys(next).length} parameters will be re-optimized on every walk-forward fold — narrow them in Auto-tune if you want a smaller search.` })
  }

  // v2.2.0 — "Reset to defaults" (step ⑤ ghost button): re-seed the wizard
  // from the run setup, keep the chosen lane, drop stale results.
  const resetDefaults = () => {
    setStudio((s) => makeStudioState(cfg, s.lane, { symbol: s.symbol, capital: s.capital }))
    setRanges({})
    setMinTrades('8')
    setTopX('8')
    setWfFolds('3')
    setWfIsPct('70')
    setWfHoldout('20')
    setWfAnchored(false)
    setBtCooldown(String(cfg.cooldownMin ?? 0))
    setBtFresh(cfg.requireNewSignal === true)
    setRunRes(null)
    setOptRes(null)
    setSweepRes(null)
    setWfRes(null)
    setKrAbRes(null)
    setMcRes(null)
    setAbRes(null)
    setTrailAbRes(null)
    setTrustRes(null)
    setMeta(null)
    setError(null)
    setFlowMode(null)
    setFlowDone(false)
    setFlowError(false)
    toast({ title: 'Backtest Studio reset', description: 'Steps re-seeded from the run setup defaults — market-typical costs, fresh window, walk-forward armed.' })
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
  // v2.2.0 — swing results carry per-trade MTF context (§1.4); the trades
  // table grows a "Context" column only when the payload actually has it
  const showMtfCol = (runRes?.trades ?? []).some((t) => tradeMtf(t) != null)

  // v2.1.0/2.2.0 — flow-chart wiring (semantics unchanged): the chart draws
  // the chosen level's pipeline; while running it blinks the live phase
  // (server job poll, or the inline-run client estimate), then all green.
  const flow = {
    mode: flowMode ?? LEVEL_META[level].flow,
    activePhase: !flowMode && busy === null
      ? null
      : flowDone
        ? null
        : busy === 'run'
          ? runHint
          : flowError
            ? lastPhaseRef.current
            : (job?.phase ?? 'fetch'),
    finished: flowDone,
    failed: flowError,
    frac: !flowMode && busy === null ? undefined : busy === 'run' ? undefined : (job?.frac ?? 0.02),
    stage: !flowMode && busy === null
      ? undefined
      : busy === 'run'
        ? (runHint === 'fetch' ? 'fetching bars…' : runHint === 'prepare' ? 'preparing series…' : 'replaying strategy over history…')
        : job?.stage,
    elapsedSec: !flowMode && busy === null ? undefined : busy === 'run' ? undefined : job?.elapsedSec,
  }

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
      {/* ==== v2.2.0 BACKTEST STUDIO — 5-step wizard, one guided pipeline ====
          ① Trading style (day/swing) → ② Market & data → ③ Strategy →
          ④ Risk & costs → ⑤ Validate & run. The wizard renders from
          StudioState (owned above — it feeds the POST body); results render
          beneath, unchanged, and the CTA scrolls to them. */}
      <BacktestStudio
        cfg={cfg}
        studio={studio}
        patch={patchStudio}
        level={level} setLevel={setLevel}
        minTrades={minTrades} setMinTrades={setMinTrades}
        topX={topX} setTopX={setTopX}
        wfFolds={wfFolds} setWfFolds={setWfFolds}
        wfIsPct={wfIsPct} setWfIsPct={setWfIsPct}
        wfHoldout={wfHoldout} setWfHoldout={setWfHoldout}
        wfAnchored={wfAnchored} setWfAnchored={setWfAnchored}
        btCooldown={btCooldown} setBtCooldown={setBtCooldown}
        btFresh={btFresh} setBtFresh={setBtFresh}
        ranges={ranges} setRanges={setRanges} activeRanges={activeRanges}
        busy={busy}
        flow={flow}
        error={error}
        onRun={(mode) => void post(mode)}
        onOptimize={() => void post('optimize')}
        onPushParams={onApplyParams}
        onApplyPreset={applyPreset}
        onArmDefaultGrid={useDefaultGrid}
        onResetDefaults={resetDefaults}
        ctaRef={ctaRef}
      />

      {/* ---- results (v2.1.0 — anchored region the CTA scrolls to) ---- */}
      {(meta || runRes || optRes || sweepRes || wfRes || krAbRes) && (
        <div ref={resRef} className="scroll-mt-20">
          <div className="flex flex-wrap items-center gap-2 px-1">
            <Table2 className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Results</span>
            <span className="text-[10px] text-zinc-600">each validation replaces the previous view — the newest run wins</span>
          </div>
        </div>
      )}
      {meta && (
        <div className="flex flex-col gap-1 px-1">
          <p className="text-[11px] text-zinc-500">
            {meta.symbol} · {meta.timeframe} · data {meta.from != null && meta.to != null ? <>{fmtDayY(meta.from)} → {fmtDayY(meta.to)} ({meta.coveredDays ?? '—'}d)</> : <>last {meta.days} days</>}
            {' '}· {meta.bars.toLocaleString('en-US')} closed bars{meta.source ? <> · feed: {meta.source}</> : null}
            {runRes && <> · trades {fmtDayY(runRes.metrics.from)} → {fmtDayY(runRes.metrics.to)}</>}
            {meta.mtf && (
              <span className="text-purple-300/90" title={`Aggregated ${meta.mtf.trendBars.toLocaleString('en-US')} trend bars + ${meta.mtf.midBars.toLocaleString('en-US')} confirm bars · ${meta.mtf.levels} confirmed S/R pivots`}>
                {' '}· MTF: {meta.mtf.trendTf} trend + {meta.mtf.midTf} confirm · {meta.mtf.levels} levels
              </span>
            )}
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

      {/* v1.99.1 — the flow chart above now carries the busy status live
          (phase nodes + stage text), so the old static "busy" card is gone. */}

      {/* single-run result */}
      {runRes && m && (
        <>
          {/* v2.2.2 — zero-trade honesty: the engine attributes WHY a run
              closed no trades (warmup starvation / no aligned signal / every
              signal filtered). Rendered verbatim so 0 trades is always an
              actionable diagnosis, never a silent shrug. */}
          {m.zeroTrade && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5" role="alert">
              <div className="flex flex-wrap items-center gap-2">
                <TriangleAlert className="h-4 w-4 text-amber-400" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                  0 trades — {m.zeroTrade.code === 'warmup' ? 'history window too short' : m.zeroTrade.code === 'no-signal' ? 'entry conditions never aligned' : 'every signal was filtered'}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-zinc-300">{m.zeroTrade.message}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Net P&L" value={fmtUsd(m.netPnl)} sub={fmtPct(m.netPct)} cls={pnlColor(m.netPnl)} />
            <Metric label="Win rate" value={`${m.winRate.toFixed(1)}%`} sub={`${m.wins}W / ${m.losses}L`} cls="text-zinc-100" />
            <Metric label="Profit factor" value={m.profitFactor >= 999 ? '∞' : m.profitFactor.toFixed(2)} sub={`${fmtUsd(m.grossWin)} / ${fmtUsd(m.grossLoss)}`} cls={m.profitFactor >= 1 ? 'text-emerald-400' : 'text-rose-400'} />
            <Metric label="Max drawdown (MTM)" value={fmtPct(-m.maxDrawdownPct)} sub={fmtUsd(-m.maxDrawdown)} cls="text-rose-400" />
            <Metric label="Trades" value={String(m.trades)} sub={`${m.longs}L · ${m.shorts}S${m.openAtEnd ? ' · 1 open' : ''}`} cls="text-zinc-100" />
            <Metric label="Expectancy" value={fmtUsd(m.expectancy)} sub="per trade" cls={pnlColor(m.expectancy)} />
            <Metric label="Avg hold" value={`${m.avgHoldMin < 90 ? `${Math.round(m.avgHoldMin)}m` : `${(m.avgHoldMin / 60).toFixed(1)}h`}`} sub={`${m.tradesPerWeek.toFixed(1)} trades/wk`} cls="text-zinc-100" />
            <Metric label="Final equity" value={fmtUsd(m.finalEquity)} sub={m.suppressed > 0 ? `${m.suppressed} signals gated` : 'gates: none hit'} cls="text-zinc-100" />
            {(m.avgFillCostBps ?? 0) > 0 && (
              <Metric
                label="Avg cost / fill"
                value={`${m.avgFillCostBps!.toFixed(1)} bps`}
                sub={`≈ ${(m.avgFillCostBps! * 2).toFixed(1)} bps round trip`}
                cls="text-zinc-100"
              />
            )}
          </div>

          {/* Review P0 #3/#4 — regime gate effectiveness: how many raw entry
              signals each gate blocked, plus a one-click gates-off A/B so the
              filters' cost is quantified, not guessed. */}
          {m.regime && (() => {
            const rs: RegimeGateStats = m.regime
            const share = (n: number) => (rs.signals > 0 ? (n / rs.signals) * 100 : 0)
            const gatesActive = (studio.params.regimeTrend ?? 0) >= 1 || (studio.params.regimeAdx ?? 0) >= 1 || (studio.params.hlGate ?? 0) >= 1
            const blockedTotal = rs.vetoedByTrend + rs.vetoedByAdx + rs.vetoedByHalfLife
            const gateChip = (label: string, blocked: number) => (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 tabular-nums',
                  blocked > 0 ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-zinc-700/60 bg-zinc-900 text-zinc-500',
                )}
              >
                {label} blocked <span className="font-semibold">{blocked.toLocaleString('en-US')}</span>
                <span className="text-[9px] opacity-80">({share(blocked).toFixed(0)}%)</span>
              </span>
            )
            return (
              <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 text-sky-400" aria-hidden />
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Regime gates</span>
                  <Badge variant="outline" className="text-[10px] text-zinc-400" title="Every raw entry signal the strategy produced on a decided bar — the denominator of the blocked shares">
                    {rs.signals.toLocaleString('en-US')} entry signals
                  </Badge>
                  {!gatesActive && (
                    <Badge variant="outline" className="text-[10px] text-zinc-500" title="regimeTrend / regimeAdx / hlGate are all 0 in the run setup">
                      gates off — nothing filtered
                    </Badge>
                  )}
                  {gatesActive && blockedTotal === 0 && (
                    <Badge variant="outline" className="text-[10px] text-emerald-400/90">every signal passed the gates</Badge>
                  )}
                  {gatesActive && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto h-6 gap-1 border-zinc-700 px-2 text-[10px] text-zinc-300 hover:bg-zinc-800"
                      disabled={abBusy || busy !== null}
                      title="Re-run the EXACT same config with every regime gate forced off — the honest baseline that quantifies what the gates removed"
                      onClick={() => void runGateAb()}
                    >
                      {abBusy ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden /> : <FlaskConical className="h-3 w-3" aria-hidden />}
                      A/B: gates off
                    </Button>
                  )}
                </div>
                {gatesActive && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                    {gateChip('Trend 200-SMA', rs.vetoedByTrend)}
                    {gateChip('ADX chop', rs.vetoedByAdx)}
                    {gateChip('Half-life', rs.vetoedByHalfLife)}
                    <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 tabular-nums text-emerald-300">
                      passed <span className="font-semibold">{rs.passedRegime.toLocaleString('en-US')}</span>
                      <span className="text-[9px] opacity-80">({share(rs.passedRegime).toFixed(0)}%)</span>
                    </span>
                  </div>
                )}
                {abRes && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-zinc-800/60 bg-zinc-950/60 px-2 py-1.5 text-[11px] tabular-nums">
                    <span className="text-zinc-400">
                      gates ON <span className={cn('font-semibold', pnlColor(m.netPct))}>{fmtPct(m.netPct)}</span> · {m.trades} trades · PF {m.profitFactor >= 999 ? '∞' : m.profitFactor.toFixed(2)}
                    </span>
                    <span className="text-zinc-400">
                      gates OFF <span className={cn('font-semibold', pnlColor(abRes.netPct))}>{fmtPct(abRes.netPct)}</span> · {abRes.trades} trades · PF {abRes.profitFactor >= 999 ? '∞' : abRes.profitFactor.toFixed(2)}
                    </span>
                    <span className={cn('font-semibold', pnlColor(m.netPct - abRes.netPct))}>
                      gates delta {fmtPct(m.netPct - abRes.netPct)}
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {abRes.trades > m.trades
                        ? `${(abRes.trades - m.trades).toLocaleString('en-US')} trades removed by the gates`
                        : abRes.trades === m.trades
                          ? 'same trade count'
                          : 'trade count differs (gates also shift re-entry timing)'}
                    </span>
                  </div>
                )}
                <p className="mt-1 text-[9px] leading-snug text-zinc-600">
                  Share of RAW entry signals each gate vetoed (first matching gate wins the attribution). A gate blocking most signals is either saving you from
                  bad trades or strangling the strategy — the A/B row tells you which: keep a gate only when the gates-ON delta is the smaller loss.
                </p>
              </div>
            )
          })()}

          {/* v1.98.0 — trailing exit PROOF ("prove the performance before and
              after trailing applied"): BEFORE = the same window replayed with
              the trail off (the pre-1.97 engine); AFTER = this run's trail-on
              result. Same bars, same strategy, same SL — the ONLY difference
              is the trailing exit, so the delta IS the trail's effect. */}
          {studio.trailOn && (Number(studio.trailArm) || 0) > 0 && (Number(studio.trailGive) || 0) > 0 && (
            <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <TrendingDown className="h-3.5 w-3.5 text-cyan-400" aria-hidden />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Trailing exit proof</span>
                <Badge
                  variant="outline"
                  className="text-[10px] text-cyan-300/90"
                  title="Arms once a close is in profit ≥ arm% from entry, then market-closes on a give-back % from the best price since (engine-managed every 15s)"
                >
                  arm {studio.trailArm}% · give {studio.trailGive}%
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto h-6 gap-1 border-zinc-700 px-2 text-[10px] text-zinc-300 hover:bg-zinc-800"
                  disabled={trailAbBusy || busy !== null}
                  title="Replay the EXACT same window with the trailing exit forced off — the honest 'before' that quantifies what the trail changed"
                  onClick={() => void runTrailAb()}
                >
                  {trailAbBusy ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden /> : <FlaskConical className="h-3 w-3" aria-hidden />}
                  A/B: trail off
                </Button>
              </div>
              {trailAbRes && m && (() => {
                const trailTrades = (runRes?.trades ?? []).filter((t) => t.exitReason === 'trailing stop')
                const trailAvg = trailTrades.length ? trailTrades.reduce((s, t) => s + t.pnlPct, 0) / trailTrades.length : 0
                const b = trailAbRes
                const row = (label: string, offV: string, onV: string, d: number | null, fmt: (v: number) => string, better: 'up' | 'down' | 'none') => (
                  <div key={label} className="contents">
                    <span className="text-zinc-500">{label}</span>
                    <span className="tabular-nums text-zinc-300">{offV}</span>
                    <span className="font-medium tabular-nums text-zinc-100">{onV}</span>
                    <span className={cn('tabular-nums', d == null || d === 0 ? 'text-zinc-500' : better === 'up' ? (d > 0 ? 'text-emerald-400' : 'text-rose-400') : better === 'down' ? (d < 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500')}>
                      {d == null ? '—' : fmt(d)}
                    </span>
                  </div>
                )
                const holdF = (min: number) => (min < 90 ? `${Math.round(min)}m` : `${(min / 60).toFixed(1)}h`)
                return (
                  <>
                    <div className="mt-2 grid grid-cols-[minmax(5rem,auto)_1fr_1fr_1fr] gap-x-3 gap-y-1 text-[11px]">
                      <span />
                      <span className="text-[10px] uppercase tracking-wider text-zinc-500">before · trail off</span>
                      <span className="text-[10px] uppercase tracking-wider text-cyan-300/90">after · trail on</span>
                      <span className="text-[10px] uppercase tracking-wider text-zinc-500">Δ</span>
                      {row('Net P&L', fmtPct(b.netPct), fmtPct(m.netPct), m.netPct - b.netPct, fmtPct, 'up')}
                      {row('Trades', String(b.trades), String(m.trades), m.trades - b.trades, (v) => (v > 0 ? `+${v}` : String(v)), 'none')}
                      {row('Win rate', `${b.winRate.toFixed(0)}%`, `${m.winRate.toFixed(0)}%`, m.winRate - b.winRate, (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}pp`, 'up')}
                      {row('Profit factor', b.profitFactor >= 999 ? '∞' : b.profitFactor.toFixed(2), m.profitFactor >= 999 ? '∞' : m.profitFactor.toFixed(2), m.profitFactor - b.profitFactor, (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`, 'up')}
                      {row('Max drawdown', fmtPct(-b.maxDrawdownPct), fmtPct(-m.maxDrawdownPct), m.maxDrawdownPct - b.maxDrawdownPct, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}pp`, 'down')}
                      {row('Expectancy', fmtUsd(b.expectancy), fmtUsd(m.expectancy), m.expectancy - b.expectancy, (v) => `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`, 'up')}
                      {row('Avg hold', holdF(b.avgHoldMin), holdF(m.avgHoldMin), null, () => '', 'none')}
                    </div>
                    <p className="mt-1.5 text-[10px] leading-snug text-zinc-400">
                      {trailTrades.length === 0
                        ? 'The trail never armed on this window — the strategy\'s own exits resolved before the arm threshold, so before/after are identical by construction. Tighten the arm % if you want the trail to take over.'
                        : `${trailTrades.length} trade${trailTrades.length === 1 ? '' : 's'} closed by the trail (avg ${fmtPct(trailAvg)} each). ${
                            m.trades > b.trades + 2
                              ? 'Banking winners sooner frees the slot for fresh entries — the trade count rose, so on a weak-edge window net P&L can fall even while every per-trade metric improves; judge the trail by expectancy and drawdown.'
                              : 'Winners are banked on the way down instead of handed back to the market.'
                          }`}
                    </p>
                  </>
                )
              })()}
              {!trailAbRes && (
                <p className="mt-1 text-[9px] leading-snug text-zinc-600">
                  Click to replay this exact window with the trail off — the "before" baseline. Same bars, same strategy, same SL bracket: the ONLY difference is the trailing exit, so every delta in the table is the trail's doing.
                </p>
              )}
            </div>
          )}

          {/* v1.99.0 — TRUST CHECK: the plain-language significance verdict on
              this run's per-trade P&L, before any other honesty overlays */}
          {trustRes?.basis === 'plain' && (
            <TrustStrip label="Trust check — is this edge real?" sig={trustRes.sig} verdict={trustRes.verdict} />
          )}

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
                <table className={cn('w-full text-left text-[11px]', showMtfCol ? 'min-w-[760px]' : 'min-w-[560px]')}>
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
                      {showMtfCol && (
                        <ThTip
                          label="Context"
                          tip="Higher-timeframe backdrop at entry (swing lane): HTF trend direction, confirm-TF RSI, and the distance to the triggering S/R level"
                        />
                      )}
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
                        {showMtfCol && (
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-[10px] text-purple-300/90">
                            {(() => {
                              const c = tradeMtf(t)
                              if (!c) return <span className="text-zinc-600">—</span>
                              const midTf = meta?.mtf?.midTf
                              return (
                                <>
                                  {c.trend}
                                  {midTf ? ` · ${midTf} RSI ${Math.round(c.midRsi)}` : ''}
                                  {c.levelPct != null ? ` · ${c.levelPct.toFixed(1)}% off level` : ''}
                                </>
                              )
                            })()}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {/* v2.2.2 — only the generic fallback when the engine had no more
              specific reason to give (zeroTrade banner above covers the
              attributed cases: warmup starvation / no signal / all filtered) */}
          {runRes.trades.length === 0 && !m.zeroTrade && (
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
          {/* v1.99.0 — in-sample trust verdict on the optimizer's best row:
              explicitly winner's-curse-labeled, capped at 'suggestive' */}
          {trustRes?.basis === 'in-sample' && (
            <div className="border-t border-zinc-800/60 px-3 py-2">
              <TrustStrip label="Best-row trust (in-sample)" sig={trustRes.sig} verdict={trustRes.verdict} compact />
            </div>
          )}
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
                              <span className="text-zinc-500">{paramLabel(studio.strategy, k)}</span> <span className="tabular-nums text-zinc-200">{v}</span>
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">{fmtScore(row.score)}</td>
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
          {optRes.sensitivity && optRes.sensitivity.length > 0 && optRes.best && Number.isFinite(optRes.best.score) && (
            <div className="border-t border-zinc-800/60 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Best-row sensitivity (±1 grid step)</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {optRes.sensitivity.map((s) => (
                  <Badge
                    key={s.key}
                    variant="outline"
                    className="text-[10px] tabular-nums text-zinc-400"
                    title={`Re-running the winner with ${paramLabel(studio.strategy, s.key)} one grid step lower/higher scores ${s.down ?? '—'} / ${s.up ?? '—'} (best ${fmtScore(optRes.best?.score)}). Null = the step falls outside the grid.`}
                  >
                    {paramLabel(studio.strategy, s.key)}: {s.down == null ? '—' : s.down.toFixed(2)} / {s.up == null ? '—' : s.up.toFixed(2)}
                  </Badge>
                ))}
                {optRes.plateau && (
                  <Badge
                    variant="outline"
                    className={optRes.plateau.ok ? 'border-emerald-500/40 text-[10px] text-emerald-400' : 'border-amber-500/40 text-[10px] text-amber-400'}
                    title={`Mean neighbor score ${fmtScore(optRes.plateau.meanNeighborScore)} = ${(optRes.plateau.ratio * 100).toFixed(0)}% of the winner. ≥70% = broad plateau (robust), below = fragile peak (likely overfit).`}
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
                          <span className={cn('font-medium', row.strategy === studio.strategy ? 'text-zinc-100' : 'text-zinc-300')}>{ALGO_STRATEGIES[row.strategy].name}</span>
                          {row.strategy === studio.strategy && <span className="text-[9px] uppercase text-zinc-500">setup</span>}
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
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">{fmtScore(row.score)}</td>
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
            {/* v1.99.0 — hold-out significance chip: the purest number the
                walk-forward produces, labeled in plain language */}
            {wfRes.holdout?.sig && wfRes.holdout.sig.n > 0 && (() => {
              const hv = trustVerdict(wfRes.holdout!.sig, 'oos')
              const hst = TRUST_LEVEL_STYLE[hv.level]
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className={cn('inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide', hst.border, hst.text)}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', hst.dot)} aria-hidden />
                      hold-out {hst.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-80 border-zinc-700 bg-zinc-800 text-zinc-100">
                    <p className="font-semibold">{hv.title}</p>
                    <p className="mt-1 leading-snug">{hv.detail}</p>
                  </TooltipContent>
                </Tooltip>
              )
            })()}
            {/* Review P1 #7 — gate contribution on the pure hold-out window */}
            {wfRes.holdout?.regime && wfRes.holdout.regime.signals > 0 && (
              <span
                className="text-zinc-500"
                title="How many of the raw entry signals each regime gate vetoed inside the pure hold-out — the filters' contribution in the one window no tuning ever saw"
              >
                hold-out gates{' '}
                <span className="tabular-nums text-zinc-300">
                  trend −{wfRes.holdout.regime.vetoedByTrend} · adx −{wfRes.holdout.regime.vetoedByAdx} · hl −{wfRes.holdout.regime.vetoedByHalfLife}
                </span>{' '}
                <span className="text-zinc-600">of {wfRes.holdout.regime.signals} signals</span>
              </span>
            )}
          </div>
          {/* v1.99.0 — POOLED OUT-OF-SAMPLE verdict: every fold's OOS trade in
              one day-block significance test — the honest headline number */}
          {wfRes.aggregate.oosSig && wfRes.aggregate.oosSig.n > 0 && (
            <div className="px-3 pb-2">
              <TrustStrip label="Pooled out-of-sample verdict" sig={wfRes.aggregate.oosSig} verdict={trustVerdict(wfRes.aggregate.oosSig, 'oos')} compact />
            </div>
          )}
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
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-300">{fmtScore(f.isScore)}</td>
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
                              <span className="text-zinc-500">{paramLabel(studio.strategy, k)}</span> <span className="tabular-nums text-zinc-200">{v}</span>
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

      {/* ---- v2.0.0 — Kronos gate A/B card: does the AI gate help or hurt? ---- */}
      {krAbRes && (
        <div className="rounded-md border border-amber-500/30 bg-zinc-900/70">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Kronos gate A/B — AI veto vs free entries</span>
            <Badge variant="outline" className="text-[10px] text-zinc-400">{krAbRes.model}</Badge>
            <Badge variant="outline" className="text-[10px] text-zinc-400">{krAbRes.forecasts}/{krAbRes.origins} walk-forward forecasts</Badge>
            {krAbRes.forecastFailed > 0 && (
              <Badge variant="outline" className="border-rose-500/40 text-[10px] text-rose-400">{krAbRes.forecastFailed} failed (bars ungated)</Badge>
            )}
            <span className="ml-auto text-[10px] tabular-nums text-zinc-600">
              {krAbRes.windowBars}-bar window · {new Date(krAbRes.windowFrom * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → {new Date(krAbRes.windowTo * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {krAbRes.elapsedSec}s
            </span>
          </div>
          <div className="overflow-x-auto px-3 pb-2">
            <table className="w-full min-w-[520px] text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1.5 pr-2 font-medium">variant</th>
                  <th className="py-1.5 pr-2 text-right font-medium">trades</th>
                  <th className="py-1.5 pr-2 text-right font-medium">net %</th>
                  <th className="py-1.5 pr-2 text-right font-medium">win rate</th>
                  <th className="py-1.5 pr-2 text-right font-medium">PF</th>
                  <th className="py-1.5 pr-2 text-right font-medium">expectancy</th>
                  <th className="py-1.5 text-right font-medium">max DD</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                <tr className="border-b border-zinc-800/60">
                  <td className="py-1.5 pr-2 text-zinc-300">A · ungated (baseline)</td>
                  <td className="py-1.5 pr-2 text-right text-zinc-300">{krAbRes.base.trades}</td>
                  <td className={`py-1.5 pr-2 text-right font-semibold ${krAbRes.base.netPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{krAbRes.base.netPct.toFixed(2)}%</td>
                  <td className="py-1.5 pr-2 text-right text-zinc-400">{krAbRes.base.winRate.toFixed(0)}%</td>
                  <td className="py-1.5 pr-2 text-right text-zinc-400">{krAbRes.base.pf.toFixed(2)}</td>
                  <td className={`py-1.5 pr-2 text-right ${krAbRes.base.expectancy >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>${krAbRes.base.expectancy.toFixed(2)}</td>
                  <td className="py-1.5 text-right text-zinc-500">{krAbRes.base.maxDDPct.toFixed(1)}%</td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-2 font-semibold text-amber-300">B · Kronos-gated</td>
                  <td className="py-1.5 pr-2 text-right text-zinc-300">
                    {krAbRes.gated.trades}
                    {krAbRes.gateVetoed > 0 && <span className="ml-1 text-[10px] text-amber-400/80" title="Entry signals the model vetoed">−{krAbRes.gateVetoed} vetoed</span>}
                  </td>
                  <td className={`py-1.5 pr-2 text-right font-semibold ${krAbRes.gated.netPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{krAbRes.gated.netPct.toFixed(2)}%</td>
                  <td className="py-1.5 pr-2 text-right text-zinc-400">{krAbRes.gated.winRate.toFixed(0)}%</td>
                  <td className="py-1.5 pr-2 text-right text-zinc-400">{krAbRes.gated.pf.toFixed(2)}</td>
                  <td className={`py-1.5 pr-2 text-right ${krAbRes.gated.expectancy >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>${krAbRes.gated.expectancy.toFixed(2)}</td>
                  <td className="py-1.5 text-right text-zinc-500">{krAbRes.gated.maxDDPct.toFixed(1)}%</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="border-t border-zinc-800/60 px-3 py-2 text-[10px] leading-snug text-zinc-600">
            Walk-forward honesty: every forecast was made at its origin bar seeing ONLY past bars (24-bar stride, no look-ahead); the gate vetoes an entry when the
            model's horizon-end P(up) disagrees (≥0.55 long / ≤0.45 short). {krAbRes.avgUpProb != null && <>Average P(up) across origins: {(krAbRes.avgUpProb * 100).toFixed(0)}%. </>}
            A gate that removes trades is only good if the REMOVED trades were the bad ones — compare net % and expectancy, not trade count. Forecasts are cached
            per window, so re-running with different TP/SL is instant. The same gate is available on LIVE runs ("Kronos AI gate" in the run setup).
          </p>
        </div>
      )}

      {/* recommended setups (Task 89/90) — full-catalog sweep winners.
          v2.1.0 — collapsed by default (declutter); the count + sweep progress
          stay visible on the collapsed chip. */}
      {recos.length > 0 && !recosOpen && (
        <button
          type="button"
          onClick={() => setRecosOpen(true)}
          aria-expanded={false}
          className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/25 bg-zinc-900/70 px-3 py-2 text-left transition-colors hover:bg-zinc-900"
        >
          <Sparkles className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Recommended setups</span>
          <Badge variant="outline" className="text-[10px] text-zinc-400">{recos.length} configs</Badge>
          {recoJob?.running && (
            <span className="text-[10px] text-emerald-300">sweeping {recoJob.done}/{recoJob.total}…</span>
          )}
          <ChevronDown className="ml-auto h-3.5 w-3.5 text-zinc-500" aria-hidden />
        </button>
      )}
      {recos.length > 0 && recosOpen && (
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
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                onClick={() => setRecosOpen(false)}
                aria-label="Collapse recommended setups"
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden />
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
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">{fmtScore(rec.score)}</td>
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

function paramLabel(strategy: AlgoStrategyId, key: string): string {
  // Task 19 — the virtual TP/SL optimizer dims are not strategy params
  if (key === 'tpValue') return 'TP %'
  if (key === 'slValue') return 'SL %'
  return ALGO_STRATEGIES[strategy].params.find((p) => p.key === key)?.label ?? key
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
