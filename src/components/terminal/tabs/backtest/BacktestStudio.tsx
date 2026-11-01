'use client'

// v2.2.0 — BACKTEST STUDIO, the 5-step wizard (Task 4-b, spec §2.2/§2.3).
//
//  ① Trading style (day/swing lane cards) → ② Market & data → ③ Strategy →
//  ④ Risk & costs → ⑤ Validate & run, with a sticky left stepper rail on md+
//  (horizontal chips on mobile). Steps ①–④ collapse to compact summary rows
//  once completed; the rail or a summary row re-expands them. The step-⑤ hero
//  CTA "Run head-to-end" runs the whole chosen pipeline (mode mapping identical
//  to the pre-studio sibling buttons) — one click from fetch to golden result.
//
//  State lives in BacktestPanel (StudioState — one source of truth that feeds
//  the POST body); this component is a pure-ish view + intent layer.
import { useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import {
  Bot, ChevronDown, Coins, Database, FlaskConical, RefreshCw, Rocket, ShieldCheck, SlidersHorizontal, Sparkles,
  Repeat, TrendingUp, Wand2, Zap, RotateCcw, type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Segmented } from '../Segmented'
import { BacktestFlowChart, type BtFlowMode } from '../BacktestFlowChart'
import { DayLaneIllo, MtfLadderIllo, RiskBracketIllo, SwingLaneIllo, ThreeScreenIllo } from './illustrations'
import { ChipButton, NextStepButton, NumIn, StepperRail, StudioStep, ToggleRow, type RailStep } from './studio-bits'
import {
  ALGO_STRATEGIES, ALGO_REGIME_PRESETS, LEVEL_META, clampParam, estimateBars, fmtBars, gridArmed,
  laneTfs, makeStudioState, resolveLadder, studioIssues, suggestCosts, swingSeedDays,
  ladderMinDays, validateLadder,
  type AlgoRegimePresetId, type AlgoStrategyId, type AlgoTimeframe, type BtBusy, type BtLevel, type RangeState, type StudioState,
} from './studio-state'
import { algoMaxDays, normalizeAlgoParams, strategyLane, MTF_TREND_TF, MTF_MID_TF } from '@/lib/algo-strategies'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import type { AlgoSetupCfg } from '../BacktestPanel'

export interface BacktestStudioProps {
  cfg: AlgoSetupCfg
  studio: StudioState
  patch: (p: Partial<StudioState>) => void
  // step ⑤ validation slice — existing panel-owned names win (spec §2.1)
  level: BtLevel
  setLevel: (l: BtLevel) => void
  minTrades: string
  setMinTrades: (v: string) => void
  topX: string
  setTopX: (v: string) => void
  wfFolds: string
  setWfFolds: (v: string) => void
  wfIsPct: string
  setWfIsPct: (v: string) => void
  wfHoldout: string
  setWfHoldout: (v: string) => void
  wfAnchored: boolean
  setWfAnchored: (v: boolean) => void
  // day-lane re-entry controls (hidden in swing — the server forces them off)
  btCooldown: string
  setBtCooldown: (v: string) => void
  btFresh: boolean
  setBtFresh: (v: boolean) => void
  // optimizer grid (advanced, step ⑤)
  ranges: Record<string, RangeState>
  setRanges: Dispatch<SetStateAction<Record<string, RangeState>>>
  activeRanges: { key: string; min: number; max: number; step: number }[]
  // run machinery
  busy: BtBusy | null
  flow: {
    mode: BtFlowMode
    activePhase: string | null
    finished: boolean
    failed: boolean
    frac?: number
    stage?: string
    elapsedSec?: number
  }
  error: string | null
  onRun: (mode: 'run' | 'walkforward' | 'sweep' | 'kronos-ab') => void
  onOptimize: () => void
  onPushParams: (p: Record<string, number>, strategy?: AlgoStrategyId) => void
  onApplyPreset: (id: AlgoRegimePresetId) => void
  onArmDefaultGrid: () => void
  onResetDefaults: () => void
  /** panel scrolls here when a run fails (the CTA lives inside the wizard) */
  ctaRef: RefObject<HTMLDivElement | null>
}

// Review P1 #5 parity — mirror of the engine's rangeInert(): a range whose
// controlling gate is OFF is silently dropped server-side; say so inline.
const rangeGateOff = (key: string, params: Record<string, number>): string | null => {
  if (key === 'hlMax' && (params.hlGate ?? 0) < 1) return 'half-life gate off'
  if (key === 'adxMax' && (params.regimeAdx ?? 0) < 1) return 'ADX gate off'
  if (key === 'trendSoftPct' && (params.regimeTrend ?? 0) < 1) return 'trend gate off'
  if ((key === 'cumBars' || key === 'cumBuy') && (params.cumMode ?? 0) < 1) return 'cumulative RSI off'
  return null
}

const paramsStr = (v: number | undefined): string => (v == null ? '—' : String(v))

const STEP_META: { icon: LucideIcon; tone: string; title: string; sub: string }[] = [
  { icon: Zap, tone: 'bg-amber-500/15 text-amber-400', title: 'Trading style', sub: 'day scalps or multi-day swings — it picks the timeframes and strategies' },
  { icon: Database, tone: 'bg-emerald-500/15 text-emerald-400', title: 'Market & data', sub: 'what to replay, how far back, how big the simulated account is' },
  { icon: Bot, tone: 'bg-pink-500/15 text-pink-400', title: 'Strategy', sub: 'the rule set and its parameters, explained in plain language' },
  { icon: Coins, tone: 'bg-orange-500/15 text-orange-400', title: 'Risk & costs', sub: 'sizing, brackets, trailing and what the market charges per fill' },
  { icon: ShieldCheck, tone: 'bg-violet-500/15 text-violet-400', title: 'Validate & run', sub: 'pick how hard to test — one button runs the whole pipeline head-to-end' },
]

export default function BacktestStudio(props: BacktestStudioProps) {
  const { cfg, studio, patch, level, setLevel, busy, flow, error, onRun, onOptimize, onPushParams, onApplyPreset, onArmDefaultGrid, onResetDefaults, ctaRef } = props
  const [open, setOpen] = useState(1)
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [fmOpen, setFmOpen] = useState(false)
  const [fineOpen, setFineOpen] = useState(false)
  const [optOpen, setOptOpen] = useState(false)
  const stepRefs = useRefArray<HTMLDivElement | null>(5)

  const def = ALGO_STRATEGIES[studio.strategy]
  const isSwing = studio.lane === 'swing'
  const isCrypto = studio.symbol.includes('/')
  const maxDays = algoMaxDays(studio.entryTf, isCrypto)
  const issues = useMemo(() => studioIssues(studio), [studio])
  const allIssues = [...issues.market, ...issues.sizing, ...issues.params]
  const daysNum = Math.round(Number(studio.days) || 0)
  const barEst = estimateBars(Math.max(0, daysNum), studio.entryTf, isCrypto)
  // v2.6.0 — the MTF ladder: frozen map (auto) or the user's custom pick.
  // Custom picks validate structurally (mid > entry, trend ≥ mid) and deep
  // trend TFs surface a history auto-bump instead of starving silently.
  const ladder = resolveLadder(studio.entryTf, studio)
  const ladderCustom = isSwing && studio.ladderMode === 'custom'
  const ladderError = isSwing ? validateLadder(studio.entryTf, studio.ladderTrend, studio.ladderMid) : null
  const ladderNeedsDays = isSwing && !ladderError ? ladderMinDays(studio.ladderTrend, isCrypto) : 0
  const ladderMidChoices = (Object.keys(TIMEFRAMES) as Timeframe[])
    .filter((tf) => TIMEFRAMES[tf].seconds > TIMEFRAMES[studio.entryTf].seconds && tf !== '1M')
  const ladderTrendChoices = (Object.keys(TIMEFRAMES) as Timeframe[])
    .filter((tf) => TIMEFRAMES[tf].seconds >= TIMEFRAMES[studio.ladderMid].seconds && tf !== '1M')
  const laneStrategies = useMemo(
    () => Object.values(ALGO_STRATEGIES).filter((d) => strategyLane(d.id) === studio.lane),
    [studio.lane],
  )
  const sug = suggestCosts(studio.symbol)
  const wfGridCount = gridArmed(props.ranges)
  const running = busy !== null

  // v2.2.1 — walk-forward headroom pre-flight: each fold span needs IS ≥ 300 +
  // OOS ≥ 60 bars server-side (walkForward foldFloor), and the hold-out takes
  // another bite of the tail — surface the shortfall in step ⑤ BEFORE the run
  // instead of a surprise 'no fold produced a tunable winner'.
  const wfHeadroom = useMemo(() => {
    if (level !== 'wf') return null
    const est = estimateBars(Math.max(0, Math.round(Number(studio.days) || 0)), studio.entryTf, studio.symbol.includes('/'))
    const foldsN = Math.min(6, Math.max(2, Math.round(Number(props.wfFolds) || 3)))
    const isF = Math.min(0.9, Math.max(0.5, (Number(props.wfIsPct) || 70) / 100))
    const hoF = Math.min(0.4, Math.max(0, (Number(props.wfHoldout) || 0) / 100))
    const floor = Math.max(Math.ceil(300 / isF), Math.ceil(60 / Math.max(1e-9, 1 - isF)), 360)
    const needed = Math.ceil((foldsN * floor) / (1 - hoF))
    return { foldsN, needed, est, short: est > 0 && est < needed }
  }, [level, props.wfFolds, props.wfIsPct, props.wfHoldout, studio.days, studio.entryTf, studio.symbol])

  // ---- intents -----------------------------------------------------------
  const go = (n: number) => {
    setOpen(n)
    // wait a tick so the newly expanded step is laid out before scrolling
    window.setTimeout(() => stepRefs.get(n - 1)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }
  const clampDays = (v: string, tf: AlgoTimeframe) => String(Math.min(algoMaxDays(tf, isCrypto), Math.max(1, Math.round(Number(v) || 30))))

  const pickLane = (lane: 'day' | 'swing') => {
    if (lane === studio.lane) return
    const next = makeStudioState(cfg, lane, {
      symbol: studio.symbol,
      capital: studio.capital,
      lev: studio.lev,
      days: studio.days,
      slippageBps: studio.slippageBps,
      feeBps: studio.feeBps,
      spreadBps: studio.spreadBps,
      dynSlip: studio.dynSlip,
      regimePreset: studio.regimePreset,
    })
    if (next.lane === 'swing') {
      // v2.2.2 — day→swing RAISES the window to the swing seed (never lowers
      // a deeper user choice): 30–200d day-lane windows starve the swing trend
      // screen on stocks (~7 hourly bars/day), which is exactly the "0 trades
      // on every symbol" report. Clamped to the feed cap.
      const seed = swingSeedDays(next.entryTf)
      const userDays = Math.round(Number(studio.days)) || 0
      next.days = String(Math.min(algoMaxDays(next.entryTf, next.symbol.includes('/')), Math.max(userDays, seed)))
    } else {
      // swing→day keeps the user's window, clamped to the day TF's feed cap
      next.days = clampDays(studio.days || next.days, next.entryTf)
    }
    patch(next)
  }
  const pickTf = (tf: AlgoTimeframe) => {
    if (tf === studio.entryTf) return
    if (studio.lane === 'swing') {
      // v2.2.2 — swing TFs need different calendar depth (1D needs ≈50 WEEKLY
      // buckets ≈ 1.4y; keeping a 1h-sized window starved the 1D lane into a
      // silent zero-trade result). Re-seed, but never below a deeper user pick.
      const userDays = Math.round(Number(studio.days)) || 0
      const seed = swingSeedDays(tf)
      // v2.6.0 — a custom ladder can become structurally invalid on a new
      // entry TF (mid no longer higher); snap back to that TF's frozen map.
      const customOk = studio.ladderMode === 'custom' && validateLadder(tf, studio.ladderTrend, studio.ladderMid) == null
      patch({
        entryTf: tf,
        days: String(Math.min(algoMaxDays(tf, isCrypto), Math.max(userDays, seed))),
        ...(customOk ? {} : { ladderMode: 'auto' as const, ladderTrend: MTF_TREND_TF[tf], ladderMid: MTF_MID_TF[tf] }),
      })
    } else {
      patch({ entryTf: tf, days: clampDays(studio.days, tf) })
    }
  }
  const pickStrategy = (id: AlgoStrategyId) => {
    if (id === studio.strategy) return
    const params = normalizeAlgoParams(id, ALGO_STRATEGIES[id].defaults)
    setParamDraft({})
    patch({ strategy: id, params })
    // day lane mirrors into the shared run setup (spec §2.1 sync rules);
    // swing lane is wizard-local — the live engine stays intraday
    if (studio.lane === 'day') onPushParams(params, id)
  }
  const commitParam = (key: string, raw: string) => {
    setParamDraft((d) => {
      const rest = { ...d }
      delete rest[key]
      return rest
    })
    const v = clampParam(studio.strategy, key, Number(raw))
    const next = { ...studio.params, [key]: v }
    patch({ params: next })
    if (studio.lane === 'day') onPushParams(next, studio.strategy)
  }
  const setBoolParam = (key: string, on: boolean) => {
    const next = { ...studio.params, [key]: on ? 1 : 0 }
    patch({ params: next })
    if (studio.lane === 'day') onPushParams(next, studio.strategy)
  }

  // ---- step completion + rail --------------------------------------------
  const c1 = true
  const c2 = studio.symbol.trim() !== '' && daysNum > 0
  const c3 = issues.params.length === 0
  const c4 = issues.sizing.length === 0
  const stepState = (n: number, done: boolean) => (open === n ? 'current' : done ? 'done' : 'pending') as RailStep['state']
  const sizingSummary = studio.sizingMode === 'risk'
    ? `risk ${studio.riskBasis === 'pct' ? `${studio.riskMoneyPct || '—'}% eq` : `$${studio.riskMoney || '—'}`} · SL ${studio.slOn ? (studio.slUnit === 'atr' ? `${studio.slPct || '—'}×ATR` : `${studio.slPct || '—'}%`) : 'off'}`
    : `qty ${studio.qty || '—'} · SL ${studio.slOn ? (studio.slUnit === 'atr' ? `${studio.slPct || '—'}×ATR` : `${studio.slPct || '—'}%`) : 'off'}`
  const railSteps: RailStep[] = [
    { n: 1, label: 'Trading style', state: stepState(1, c1), summary: isSwing ? '🌙 Swing trading' : '⚡ Day trading' },
    { n: 2, label: 'Market & data', state: stepState(2, c2), summary: `${studio.symbol || '—'} · ${studio.entryTf} · ${studio.days}d` },
    { n: 3, label: 'Strategy', state: stepState(3, c3), summary: def.name },
    { n: 4, label: 'Risk & costs', state: stepState(4, c4), summary: `${studio.slippageBps}/${studio.feeBps}/${studio.spreadBps} bps · ${sizingSummary}` },
    { n: 5, label: 'Validate & run', state: stepState(5, flow.finished), summary: LEVEL_META[level].label },
  ]

  const ctaDisabled = running || allIssues.length > 0 || (level === 'wf' && props.activeRanges.length === 0)
  const ctaBlocker = allIssues[0]
    ?? (level === 'wf' && props.activeRanges.length === 0 ? 'Walk-forward needs a parameter grid — arm the default grid below' : null)
  const phaseText = flow.finished
    ? 'Backtest complete — result below.'
    : flow.activePhase
      ? `Running: ${flow.stage || flow.activePhase}`
      : `Idle — ready to run ${LEVEL_META[level].label}.`

  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-900/70 p-3 md:p-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="h-4 w-4 text-violet-400" aria-hidden />
        <span className="text-sm font-semibold text-zinc-100">Backtest Studio</span>
        <Badge variant="outline" className={cn('text-[10px]', isSwing ? 'border-purple-500/40 text-purple-300' : 'border-sky-500/40 text-sky-300')}>
          {isSwing ? '🌙 Swing' : '⚡ Day'}
        </Badge>
        <Badge variant="outline" className="text-[10px] text-zinc-400">
          {def.name} · {studio.symbol || '—'} {studio.entryTf}
        </Badge>
        <span className="ml-auto text-[10px] text-zinc-500">
          {isSwing ? 'swing lane — wizard-local, the live run setup is untouched' : 'day lane — strategy & params mirror the run setup'}
        </span>
      </div>

      <div className="mt-3 flex items-start gap-4">
        {/* left stepper rail (md+, sticky) */}
        <div className="hidden md:sticky md:top-2 md:block md:shrink-0">
          <StepperRail vertical steps={railSteps} onSelect={go} label="Backtest steps" />
        </div>

        {/* steps column */}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {/* mobile chips */}
          <div className="md:hidden">
            <StepperRail steps={railSteps} onSelect={go} label="Backtest steps" />
          </div>

          {/* ---- STEP ① · trading style ---- */}
          <StudioStep
            id="bt-step-1" n={1} {...STEP_META[0]} expanded={open === 1} complete={c1}
            summary={railSteps[0].summary} onExpand={() => go(1)} refEl={(el) => { stepRefs.set(0, el) }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LaneCard
                selected={studio.lane === 'day'}
                onClick={() => pickLane('day')}
                title="⚡ Day Trading"
                desc="In-and-out within the session · 1m–15m charts · scalps, breakouts, fades"
                illo={<DayLaneIllo className="h-16 w-28 text-zinc-600" />}
              />
              <LaneCard
                selected={studio.lane === 'swing'}
                onClick={() => pickLane('swing')}
                title="🌙 Swing Trading"
                desc="Hold days→weeks · 1H–1D charts · higher-timeframe confirmation"
                illo={<SwingLaneIllo className="h-16 w-28 text-zinc-600" />}
              />
            </div>
            <p className="mt-2 text-[10px] leading-snug text-zinc-600">
              {isSwing
                ? 'Swing lane runs on 1H/4H/1D with multi-timeframe confirmation. Strategy edits stay here — the live run setup keeps its own intraday config.'
                : 'Day lane keeps the classic behavior: the strategy and parameters you pick here mirror straight into the run setup above.'}
            </p>
            <NextStepButton label="Market & data" onClick={() => go(2)} />
          </StudioStep>

          {/* ---- STEP ② · market & data ---- */}
          <StudioStep
            id="bt-step-2" n={2} {...STEP_META[1]} expanded={open === 2} complete={c2}
            summary={railSteps[1].summary} onExpand={() => go(2)} refEl={(el) => { stepRefs.set(1, el) }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="bt-sym" className="text-[10px] text-zinc-500">Symbol</Label>
                <Input
                  id="bt-sym" value={studio.symbol}
                  onChange={(e) => patch({ symbol: e.target.value.toUpperCase() })}
                  placeholder="AAPL · BTC/USDT"
                  aria-describedby="bt-sym-hint"
                  className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs"
                />
                <p id="bt-sym-hint" className="mt-0.5 text-[9px] leading-tight text-zinc-600">stocks: AAPL, TSLA… · crypto: BTC/USDT (24/7 bars)</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="bt-cap" className="text-[10px] text-zinc-500">Starting capital $</Label>
                  <Input id="bt-cap" value={studio.capital} onChange={(e) => patch({ capital: e.target.value })} inputMode="decimal" className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs" />
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Label htmlFor="bt-lev" className="mt-4 w-fit cursor-help text-[10px] text-zinc-500 underline decoration-dotted decoration-zinc-600 underline-offset-2">
                      Lev (× capital)
                    </Label>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-60 border-zinc-700 bg-zinc-800 text-zinc-100">
                    Max position notional as × of capital. 1 = cash-only (honest). Crypto baked results use 1×.
                  </TooltipContent>
                </Tooltip>
                <Input
                  id="bt-lev" value={studio.lev}
                  onChange={(e) => patch({ lev: e.target.value })}
                  onBlur={() => patch({ lev: String(Number(studio.lev) > 0 ? Math.min(10, Math.max(0.1, Number(studio.lev))) : 1) })}
                  inputMode="decimal" aria-label="Leverage — max notional as multiple of capital"
                  className="h-9 border-zinc-800 bg-zinc-950 text-xs"
                />
              </div>
            </div>

            <div className="mt-3">
              <Label className="text-[10px] text-zinc-500">Entry timeframe</Label>
              <div className="mt-1 flex flex-wrap items-center gap-1.5" role="group" aria-label="Entry timeframe">
                {laneTfs(studio.lane).map((tf) => (
                  <ChipButton key={tf} active={studio.entryTf === tf} onClick={() => pickTf(tf)}>
                    {tf}
                  </ChipButton>
                ))}
                {isSwing && ladder && (
                  <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-purple-500/40 bg-purple-500/10 px-2 py-1 text-[10px] text-purple-300">
                    MTF: {ladder.trendTf} trend + {ladder.midTf} confirm → {ladder.entryTf} entry
                  </span>
                )}
              </div>
            </div>

            <div className="mt-3">
              <Label htmlFor="bt-days" className="text-[10px] text-zinc-500">
                History (days)
                <span className="ml-1 text-zinc-600">· cap {maxDays}d for {studio.entryTf}{isCrypto ? ' crypto' : ''}</span>
              </Label>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {/* v2.2.2 — lane-aware chips: swing needs calendar depth (the
                    trend screen eats ≈50 higher-TF bars before the first
                    decision), so the day chips 7–200d are replaced by a
                    90d–1825d row; values beyond the feed cap are disabled. */}
                {(isSwing ? [90, 180, 365, 730, 1095, 1825] : [7, 30, 60, 90, 200]).map((d) => (
                  <ChipButton
                    key={d}
                    active={daysNum === d}
                    disabled={d > maxDays}
                    title={d > maxDays ? `beyond the ${maxDays}-day feed cap for ${studio.entryTf}` : `last ${d} days`}
                    onClick={() => patch({ days: String(d) })}
                  >
                    {d}d
                  </ChipButton>
                ))}
                <Input
                  id="bt-days" value={studio.days}
                  onChange={(e) => patch({ days: e.target.value })}
                  onBlur={() => patch({ days: clampDays(studio.days, studio.entryTf) })}
                  inputMode="numeric" aria-label="History in calendar days (custom)"
                  className="h-9 w-16 border-zinc-800 bg-zinc-950 text-xs"
                />
              </div>
              <p className="mt-1 text-[10px] tabular-nums text-zinc-500" aria-live="polite">
                ≈ {fmtBars(barEst)} bars will be replayed
                <span className="text-zinc-600"> · {isCrypto ? 'crypto trades 24/7 (≈6× stock bar count)' : 'stocks trade ≈27% of clock hours'}</span>
              </p>
              {daysNum > maxDays && (
                <p className="mt-0.5 text-[10px] text-amber-400" role="note">
                  {daysNum}d exceeds the {maxDays}-day feed cap for {studio.entryTf} — the run replays whatever the feed returns ({maxDays}d max), not the full window.
                </p>
              )}
              {isSwing && (
                <p className="mt-0.5 text-[10px] leading-snug text-purple-300/80" role="note">
                  Swing needs deep history — the {ladder?.trendTf ?? 'higher'}-TF trend screen waits for ≈{Math.round(Number(studio.params.trendSma)) || 50} closed
                  higher-TF bars before its first decision, and stocks print only ~7 hourly / ~1 daily bar per day. Each timeframe seeds its widest sane window;
                  widen further if a run still reports 0 trades.
                </p>
              )}
            </div>

            {isSwing && ladder && (
              <div className="mt-3 grid gap-3 rounded-md border border-purple-500/25 bg-purple-500/5 p-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-purple-300">Multi-timeframe confirmation ladder</p>
                    <div className="flex items-center gap-1.5" role="group" aria-label="Ladder mode">
                      <ChipButton
                        active={studio.ladderMode === 'auto'}
                        onClick={() => patch({ ladderMode: 'auto', ladderTrend: MTF_TREND_TF[studio.entryTf], ladderMid: MTF_MID_TF[studio.entryTf] })}
                      >
                        Auto
                      </ChipButton>
                      <ChipButton active={studio.ladderMode === 'custom'} onClick={() => patch({ ladderMode: 'custom' })}>
                        Custom
                      </ChipButton>
                    </div>
                  </div>
                  <p className="mt-1 text-[10px] leading-snug text-zinc-400">
                    Every entry bar is screened against two higher timeframes: the <span className="text-purple-300">{ladder.trendTf}</span> trend screen
                    decides long/short bias, the <span className="text-amber-300">{ladder.midTf}</span> confirm screen checks momentum + S/R location, and the{' '}
                    <span className="text-sky-300">{ladder.entryTf}</span> trigger times the actual entry. No look-ahead: a higher-TF bar is only used once it has closed.
                  </p>
                  {ladderCustom && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                        Trend
                        <select
                          value={studio.ladderTrend}
                          onChange={(e) => patch({ ladderTrend: e.target.value as Timeframe })}
                          aria-label="Custom trend timeframe"
                          className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200"
                        >
                          {ladderTrendChoices.map((tf) => (
                            <option key={tf} value={tf}>{tf}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                        Confirm
                        <select
                          value={studio.ladderMid}
                          onChange={(e) => patch({ ladderMid: e.target.value as Timeframe })}
                          aria-label="Custom confirm timeframe"
                          className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200"
                        >
                          {ladderMidChoices.map((tf) => (
                            <option key={tf} value={tf}>{tf}</option>
                          ))}
                        </select>
                      </label>
                      {ladderError ? (
                        <p className="text-[10px] text-rose-400" role="alert">{ladderError}</p>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
                          valid ladder
                        </span>
                      )}
                      {!ladderError && daysNum < ladderNeedsDays && (
                        <button
                          type="button"
                          onClick={() => patch({ days: String(Math.min(maxDays, ladderNeedsDays)) })}
                          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300 hover:bg-amber-500/20"
                        >
                          ⤴ trend screen needs ≈{ladderNeedsDays}d — bump history
                        </button>
                      )}
                    </div>
                  )}
                  <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
                    Step ③ adds optional confluence screens: EMA vs SMA trend, a minimum trend slope and an ADX(14) strength floor.
                  </p>
                </div>
                <MtfLadderIllo trendTf={ladder.trendTf} midTf={ladder.midTf} entryTf={ladder.entryTf} className="mx-auto h-32 w-auto" />
              </div>
            )}
            <NextStepButton label="Strategy" onClick={() => go(3)} />
          </StudioStep>

          {/* ---- STEP ③ · strategy ---- */}
          <StudioStep
            id="bt-step-3" n={3} {...STEP_META[2]} expanded={open === 3} complete={c3}
            summary={railSteps[2].summary} onExpand={() => go(3)} refEl={(el) => { stepRefs.set(2, el) }}
          >
            <div className="flex flex-col gap-2" role="group" aria-label="Strategy catalog">
              {laneStrategies.map((d) => {
                const sel = d.id === studio.strategy
                return (
                  <div key={d.id}>
                    <button
                      type="button"
                      aria-pressed={sel}
                      aria-expanded={sel}
                      onClick={() => pickStrategy(d.id)}
                      className={cn(
                        'min-h-[44px] w-full rounded-md border p-3 text-left transition-colors',
                        sel ? 'border-zinc-500 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 hover:bg-zinc-900',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color }} aria-hidden />
                        <span className={cn('text-xs font-semibold', sel ? 'text-zinc-100' : 'text-zinc-300')}>{d.name}</span>
                        {sel && <Badge variant="outline" className="px-1 py-0 text-[8px] uppercase tracking-wide text-zinc-400">selected</Badge>}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">{d.tagline}</span>
                    </button>
                    {sel && (
                      <div className="mt-1.5 rounded-md border border-zinc-800/70 bg-zinc-950/60 p-3">
                        <p className="text-[10px] leading-snug text-zinc-400"><span className="font-semibold uppercase tracking-wider text-zinc-600">Rules · </span>{d.rules}</p>
                        <p className="mt-1 text-[10px] leading-snug text-zinc-500"><span className="font-semibold uppercase tracking-wider text-zinc-600">Fit · </span>{d.fit}</p>
                        {isSwing && ladder && (
                          <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px]">
                            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                              {d.params.map((p) =>
                                p.bool ? (
                                  <ToggleRow
                                    key={p.key} id={`bt-p-${p.key}`} label={p.label}
                                    checked={(studio.params[p.key] ?? 0) >= 1}
                                    onChange={(v) => setBoolParam(p.key, v)}
                                  />
                                ) : (
                                  <div key={p.key}>
                                    <Label htmlFor={`bt-p-${p.key}`} className="text-[10px] leading-tight text-zinc-500">{p.label}</Label>
                                    <Input
                                      id={`bt-p-${p.key}`}
                                      value={paramDraft[p.key] ?? paramsStr(studio.params[p.key])}
                                      onChange={(e) => setParamDraft((dr) => ({ ...dr, [p.key]: e.target.value }))}
                                      onBlur={(e) => commitParam(p.key, e.target.value)}
                                      inputMode="decimal"
                                      className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs"
                                    />
                                    <p className="mt-0.5 text-[9px] text-zinc-600">{p.min}–{p.max} · step {p.step}</p>
                                  </div>
                                ),
                              )}
                            </div>
                            <ThreeScreenIllo trendTf={ladder.trendTf} midTf={ladder.midTf} entryTf={ladder.entryTf} className="h-auto w-full self-center text-zinc-600" />
                          </div>
                        )}
                        {!isSwing && (
                          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">
                            {d.params.map((p) =>
                              p.bool ? (
                                <ToggleRow
                                  key={p.key} id={`bt-p-${p.key}`} label={p.label}
                                  checked={(studio.params[p.key] ?? 0) >= 1}
                                  onChange={(v) => setBoolParam(p.key, v)}
                                />
                              ) : (
                                <div key={p.key}>
                                  <Label htmlFor={`bt-p-${p.key}`} className="text-[10px] leading-tight text-zinc-500">{p.label}</Label>
                                  <Input
                                    id={`bt-p-${p.key}`}
                                    value={paramDraft[p.key] ?? paramsStr(studio.params[p.key])}
                                    onChange={(e) => setParamDraft((dr) => ({ ...dr, [p.key]: e.target.value }))}
                                    onBlur={(e) => commitParam(p.key, e.target.value)}
                                    inputMode="decimal"
                                    className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs"
                                  />
                                  <p className="mt-0.5 text-[9px] text-zinc-600">{p.min}–{p.max} · step {p.step}</p>
                                </div>
                              ),
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {!c3 && issues.params.length > 0 && (
              <p className="mt-2 text-[10px] text-amber-400" role="note">{issues.params[0]} — the CTA stays disabled until every parameter is in range.</p>
            )}
            <NextStepButton label="Risk & costs" onClick={() => go(4)} />
          </StudioStep>

          {/* ---- STEP ④ · risk & costs ---- */}
          <StudioStep
            id="bt-step-4" n={4} {...STEP_META[3]} expanded={open === 4} complete={c4}
            summary={railSteps[3].summary} onExpand={() => go(4)} refEl={(el) => { stepRefs.set(3, el) }}
          >
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_170px]">
              <div className="flex min-w-0 flex-col gap-3">
                {/* sizing */}
                <div>
                  <Label className="text-[10px] text-zinc-500">Position sizing</Label>
                  <Segmented
                    ariaLabel="Position sizing mode"
                    className="mt-1"
                    size="md"
                    grow
                    value={studio.sizingMode}
                    onChange={(v) => patch({ sizingMode: v })}
                    options={[
                      { value: 'fixed', label: 'Fixed qty' },
                      { value: 'risk', label: 'Risk Money' },
                    ]}
                  />
                  {studio.sizingMode === 'fixed' ? (
                    <div className="mt-2 max-w-48">
                      <Label htmlFor="bt-qty" className="text-[10px] text-zinc-500">Quantity per trade</Label>
                      <Input id="bt-qty" value={studio.qty} onChange={(e) => patch({ qty: e.target.value })} inputMode="decimal" className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs" />
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <div>
                        <Label className="text-[10px] text-zinc-500">Risk budget</Label>
                        <Segmented
                          ariaLabel="Risk budget basis"
                          className="mt-1"
                          value={studio.riskBasis}
                          onChange={(v) => patch({ riskBasis: v })}
                          options={[
                            { value: 'usd', label: '$ per trade' },
                            { value: 'pct', label: '% of equity' },
                          ]}
                        />
                      </div>
                      {studio.riskBasis === 'usd' ? (
                        <div className="w-28">
                          <Label htmlFor="bt-risk-usd" className="text-[10px] text-zinc-500">Risk $ / trade</Label>
                          <Input id="bt-risk-usd" value={studio.riskMoney} onChange={(e) => patch({ riskMoney: e.target.value })} inputMode="decimal" className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs" />
                        </div>
                      ) : (
                        <div className="w-28">
                          <Label htmlFor="bt-risk-pct" className="text-[10px] text-zinc-500">Risk % of equity</Label>
                          <Input id="bt-risk-pct" value={studio.riskMoneyPct} onChange={(e) => patch({ riskMoneyPct: e.target.value })} inputMode="decimal" className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs" />
                        </div>
                      )}
                      {!(studio.slOn && studio.slUnit === 'pct' && (Number(studio.slPct) || 0) > 0) && (
                        <p className="text-[10px] text-amber-400" role="note">Risk-Money sizing sizes every trade to its stop — turn SL % ON below.</p>
                      )}
                    </div>
                  )}
                </div>

                {/* brackets */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <BracketCard
                    id="bt-tp" title="Take profit" on={studio.tpOn} onToggle={(v) => patch({ tpOn: v })}
                    value={studio.tpPct} onValue={(v) => patch({ tpPct: v })}
                    unit={studio.tpUnit} onUnit={(u) => patch({ tpUnit: u })}
                  />
                  <BracketCard
                    id="bt-sl" title="Stop loss" on={studio.slOn} onToggle={(v) => patch({ slOn: v })}
                    value={studio.slPct} onValue={(v) => patch({ slPct: v })}
                    unit={studio.slUnit} onUnit={(u) => patch({ slUnit: u })}
                  />
                  <div className="rounded border border-zinc-800/60 bg-zinc-900/40 p-2.5 sm:col-span-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="bt-trail" className="text-[11px] leading-tight text-zinc-300" title="Arms once a close is in profit ≥ arm% from entry, then market-closes on a give-back % from the best price since">
                        Trailing exit
                      </Label>
                      <Switch id="bt-trail" checked={studio.trailOn} onCheckedChange={(v) => patch({ trailOn: v })} className="scale-90" />
                    </div>
                    {studio.trailOn && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <Input id="bt-trail-arm" value={studio.trailArm} onChange={(e) => patch({ trailArm: e.target.value })} inputMode="decimal" aria-label="Trailing arm percent" className="h-9 w-20 border-zinc-800 bg-zinc-950 text-xs" />
                        <span className="text-[10px] text-zinc-500">% arm</span>
                        <Input id="bt-trail-give" value={studio.trailGive} onChange={(e) => patch({ trailGive: e.target.value })} inputMode="decimal" aria-label="Trailing give-back percent" className="h-9 w-20 border-zinc-800 bg-zinc-950 text-xs" />
                        <span className="text-[10px] text-zinc-500">% give-back</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* costs */}
                <div>
                  <Label className="text-[10px] text-zinc-500">Execution costs (bps)</Label>
                  <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <CostInput id="bt-slip" label="Slippage" value={studio.slippageBps} onValue={(v) => patch({ slippageBps: v })} suggest={sug.slip} suggestTitle={`Market-typical slippage for ${studio.symbol || 'this market'} — click to use`} hint="adverse drift beyond the quote on market/stop fills" />
                    <CostInput id="bt-spread" label="Spread" value={studio.spreadBps} onValue={(v) => patch({ spreadBps: v })} hint="bid/ask cost — half per market fill" />
                    <CostInput id="bt-fee" label="Fee / fill" value={studio.feeBps} onValue={(v) => patch({ feeBps: v })} suggest={sug.fee} suggestTitle={isCrypto ? 'Binance taker fee 0.1% = 10 bps per fill — click to use' : 'Alpaca is commission-free — click to use'} hint="notional fee per fill, entry + exit" />
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <ToggleRow
                      id="bt-dynslip" label="Vol-scaled slip (ATR)"
                      hint="impact breathes with volatility — high-ATR bars pay more"
                      title="Slippage impact = bps × (bar ATR% ÷ dataset average), clamped 0.5–3×. Spread and fee stay flat. No effect while slippage = 0."
                      checked={studio.dynSlip} onChange={(v) => patch({ dynSlip: v })}
                    />
                    <div>
                      <Label className="text-[10px] text-zinc-500">Regime preset</Label>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {(Object.keys(ALGO_REGIME_PRESETS) as AlgoRegimePresetId[]).map((id) => {
                          const p = ALGO_REGIME_PRESETS[id]
                          return (
                            <Tooltip key={id}>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="outline"
                                  className={cn(
                                    'h-9 gap-1.5 border-zinc-700 px-3 text-[11px]',
                                    id === 'research' ? 'text-sky-300 hover:bg-zinc-800' : 'text-amber-300 hover:bg-zinc-800',
                                    studio.regimePreset === id && 'ring-1 ring-inset ring-zinc-400/40',
                                  )}
                                  onClick={() => onApplyPreset(id)}
                                >
                                  {id === 'research' ? <FlaskConical className="h-3 w-3" aria-hidden /> : <ShieldCheck className="h-3 w-3" aria-hidden />}
                                  {p.label}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-72 border-zinc-700 bg-zinc-800 text-zinc-100">
                                <p className="font-semibold">{p.label}</p>
                                <p className="mt-0.5">{p.blurb}</p>
                                <p className="mt-1 text-zinc-400">
                                  gates: {id === 'research'
                                    ? 'all OFF'
                                    : isSwing
                                      ? 'off — the MTF screens replace the generic gates'
                                      : studio.strategy === 'rsi2-connors'
                                        ? 'off (own trend SMA is the filter)'
                                        : studio.strategy === 'orb15'
                                          ? 'momentum 200-SMA only'
                                          : 'trend ±1.5% soft · ADX 25 · half-life (TF-aware)'}
                                  {' '}· costs: {p.costs.slippageBps}/{p.costs.feeBps}/{p.costs.spreadBps} bps slip/fee/spread
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          )
                        })}
                        <span className="text-[9px] leading-tight text-zinc-600">one click sets the gate package + cost model</span>
                      </div>
                    </div>
                  </div>
                  {/* fill-model disclosure */}
                  <button
                    type="button"
                    onClick={() => setFmOpen((v) => !v)}
                    aria-expanded={fmOpen}
                    className="mt-2 flex w-full items-center gap-1.5 text-left text-[10px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', fmOpen && 'rotate-180')} aria-hidden />
                    How fills, costs & regime gates are modeled — read before trusting a number
                  </button>
                  {fmOpen && (
                    <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
                      Fill model: entries at next-bar open · TP/SL intrabar (stop first) · strategy exits at bar close · EOD flatten fills at the 15:45 ET gate bar&apos;s OPEN
                      (wall-clock parity with the live 15:45:00 exit — the gate bar&apos;s brackets are preempted). Slippage bps = impact beyond the quote on market/stop fills; spread bps =
                      the bid/ask — half is charged per market fill (buys at ask, sells at bid) so a round trip pays it in full; TP is a resting limit and fills clean either way; fee bps
                      charges every fill. Vol-scaled slip multiplies the impact by the bar&apos;s ATR% vs the dataset average (clamped 0.5–3×). Regime gates (200-SMA trend — hard or soft ±% —
                      / ADX chop / half-life) veto entries that fight the regime; they live in the strategy parameters, are mirrored 1:1 by the live engine, and every run reports how many
                      signals each gate blocked. Live diverges from ANY replay: entries/exits are market orders seconds after the close, % legs anchor on the fill-side quote (ask for buys,
                      bid for sells — not the actual fill), and bars that closed while the engine was down never produce entries (exits are replayed). The algo journal logs the live spread
                      on every ENTRY line — mirror it here. Paper fills price off SIP while stock bars come from IEX; crypto backtests deeper than ~35d on 5m read Alpaca while live crypto
                      reads Binance. Cooldown blocks entries on bars opening within N minutes after a close; fresh-signal fires only on a false→true cross.
                      {studio.sizingMode === 'risk' && studio.slOn && studio.slUnit === 'pct' && (Number(studio.slPct) || 0) > 0 && (studio.riskBasis === 'pct' ? Number(studio.riskMoneyPct) || 0 : Number(studio.riskMoney) || 0) > 0 && (
                        <> Sizing: <span className="text-sky-400/90">Risk Money</span> — every trade is sized to risk ≈ {studio.riskBasis === 'pct' ? `${studio.riskMoneyPct}% of current equity (compounds with the simulated account)` : `$${studio.riskMoney}`} to its stop, so size breathes with volatility.</>
                      )}
                    </p>
                  )}
                </div>

                {/* day-lane-only guards (swing hides them — the server forces them off, §1.2) */}
                {!isSwing && (
                  <div>
                    <Label className="text-[10px] text-zinc-500">Session guards (day trading)</Label>
                    <div className="mt-1 grid gap-2 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="bt-maxday" className="text-[10px] text-zinc-500">Max trades / day</Label>
                        <Input
                          id="bt-maxday" value={studio.maxTradesDay}
                          onChange={(e) => patch({ maxTradesDay: e.target.value })}
                          onBlur={() => patch({ maxTradesDay: String(Math.max(0, Math.round(Number(studio.maxTradesDay) || 0))) })}
                          inputMode="numeric" aria-describedby="bt-maxday-hint"
                          className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs"
                        />
                        <p id="bt-maxday-hint" className="mt-0.5 text-[9px] leading-tight text-zinc-600">0 = unlimited</p>
                      </div>
                      <div>
                        <Label htmlFor="bt-cooldown" className="text-[10px] text-zinc-500">Cooldown after close (min)</Label>
                        <Input
                          id="bt-cooldown" value={props.btCooldown}
                          onChange={(e) => props.setBtCooldown(e.target.value)}
                          onBlur={() => props.setBtCooldown(String(Math.min(240, Math.max(0, Math.round(Number(props.btCooldown) || 0)))))}
                          inputMode="numeric" aria-describedby="bt-cool-hint"
                          className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs"
                        />
                        <p id="bt-cool-hint" className="mt-0.5 text-[9px] leading-tight text-zinc-600">re-entry throttle — 0 = off</p>
                      </div>
                      <ToggleRow id="bt-fresh" label="Require fresh signal" hint="edge-triggered re-entry — wait for a new cross" checked={props.btFresh} onChange={props.setBtFresh} />
                      <ToggleRow id="bt-rth" label="RTH only" hint="skip pre/post-market bars" checked={studio.rthOnly} onChange={(v) => patch({ rthOnly: v })} />
                      <ToggleRow id="bt-eod" label="Flatten at EOD" hint="close everything at 15:45 ET" checked={studio.flattenEod} onChange={(v) => patch({ flattenEod: v })} />
                    </div>
                  </div>
                )}
                {isSwing && (
                  <p className="rounded border border-zinc-800/60 bg-zinc-900/40 px-2.5 py-2 text-[10px] leading-snug text-zinc-500">
                    Day-trading guards (max trades/day, cooldown, fresh-signal, RTH-only, EOD flatten) are hidden in the swing lane — multi-day positions don&apos;t obey the session clock,
                    and the server forces them off for swing timeframes regardless.
                  </p>
                )}
              </div>

              {/* risk bracket illustration */}
              <aside className="hidden rounded-md border border-zinc-800/70 bg-zinc-950/60 p-2 md:block" aria-hidden>
                <RiskBracketIllo className="mx-auto h-auto w-full max-w-[150px] text-zinc-500" />
                <p className="mt-1 text-center text-[9px] leading-tight text-zinc-600">
                  {studio.slOn ? `SL ${studio.slPct || '—'}${studio.slUnit === 'atr' ? '×ATR' : '%'}${studio.tpOn ? ` · TP ${studio.tpPct || '—'}${studio.tpUnit === 'atr' ? '×ATR' : '%'}` : ' · TP off'}`
                    : 'no stop set — Risk-Money sizing needs one'}
                </p>
              </aside>
            </div>
            {!c4 && issues.sizing.length > 0 && (
              <p className="mt-2 text-[10px] text-amber-400" role="note">{issues.sizing[0]} — the CTA stays disabled until sizing is coherent.</p>
            )}
            <NextStepButton label="Validate & run" onClick={() => go(5)} />
          </StudioStep>

          {/* ---- STEP ⑤ · validate & run ---- */}
          <StudioStep
            id="bt-step-5" n={5} {...STEP_META[4]} expanded last refEl={(el) => { stepRefs.set(4, el) }}
          >
            <div ref={ctaRef} className="scroll-mt-16">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Validation depth">
                <LevelTile active={level === 'quick'} icon={TrendingUp} title="Quick check" time="seconds" desc="One replay of the exact setup over the chosen window — is there an edge at all?" onClick={() => setLevel('quick')} />
                <LevelTile active={level === 'wf'} icon={Repeat} title="Walk-forward" time="minutes" badge="recommended" desc="Re-optimizes on every fold, verifies out-of-sample, then stresses a pure hold-out tail — the honest one." onClick={() => setLevel('wf')} />
                <LevelTile active={level === 'sweep'} icon={Zap} title="Sweep all strategies" time="minutes" desc={`Every ${studio.lane}-lane strategy at defaults + an auto-built grid, ranked with out-of-sample re-runs.`} onClick={() => setLevel('sweep')} />
                <LevelTile active={level === 'kronos'} icon={Sparkles} title="Kronos AI A/B" time="≈5 min first run" desc="Walk-forward AI forecasts gate the entries — ungated vs gated, measured on the same window." onClick={() => setLevel('kronos')} />
              </div>

              {level === 'wf' && props.activeRanges.length === 0 && (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-amber-400" role="note">
                  Walk-forward re-optimizes parameters on every fold — arm a grid first:
                  <Button variant="outline" className="h-9 gap-1 border-amber-500/40 px-2.5 text-[10px] text-amber-300 hover:bg-zinc-800" onClick={onArmDefaultGrid}>
                    <Wand2 className="h-3 w-3" aria-hidden />
                    Arm default grid
                  </Button>
                  <button type="button" className="text-zinc-500 underline underline-offset-2 hover:text-zinc-300" onClick={() => { setOptOpen(true); setFineOpen(true) }}>
                    or pick ranges in Auto-tune
                  </button>
                </p>
              )}

              {/* fine-tune disclosure */}
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setFineOpen((v) => !v)}
                  aria-expanded={fineOpen}
                  className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', fineOpen && 'rotate-180')} aria-hidden />
                  Fine-tune {LEVEL_META[level].label.toLowerCase()}
                </button>
                {fineOpen && (
                  <div className="mt-1.5 rounded border border-zinc-800/70 bg-zinc-950/60 p-2.5">
                    {level === 'quick' && <p className="text-[10px] leading-snug text-zinc-500">Nothing to tune — the quick check replays steps ①–④ exactly as configured.</p>}
                    {level === 'wf' && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Label className="text-[10px] text-zinc-500" htmlFor="bt-wf-folds">Folds</Label>
                        <Input id="bt-wf-folds" value={props.wfFolds} onChange={(e) => props.setWfFolds(e.target.value)} onBlur={() => props.setWfFolds(String(Math.min(6, Math.max(2, Math.round(Number(props.wfFolds) || 3)))))} inputMode="numeric" aria-label="Walk-forward folds (2–6)" className="h-8 w-12 border-zinc-800 bg-zinc-950 text-xs" />
                        <Label className="text-[10px] text-zinc-500" htmlFor="bt-wf-is">IS %</Label>
                        <Input id="bt-wf-is" value={props.wfIsPct} onChange={(e) => props.setWfIsPct(e.target.value)} onBlur={() => props.setWfIsPct(String(Math.min(90, Math.max(50, Math.round(Number(props.wfIsPct) || 70)))))} inputMode="numeric" aria-label="Walk-forward in-sample share percent" className="h-8 w-12 border-zinc-800 bg-zinc-950 text-xs" />
                        <Label className="text-[10px] text-zinc-500" htmlFor="bt-wf-ho">Hold-out %</Label>
                        <Input id="bt-wf-ho" value={props.wfHoldout} onChange={(e) => props.setWfHoldout(e.target.value)} onBlur={() => props.setWfHoldout(String(Math.min(40, Math.max(0, Math.round(Number(props.wfHoldout) || 0)))))} inputMode="numeric" aria-label="Pure hold-out tail percent (0–40)" className="h-8 w-12 border-zinc-800 bg-zinc-950 text-xs" />
                        <div className="flex items-center gap-1">
                          <Switch id="bt-wf-anch" checked={props.wfAnchored} onCheckedChange={props.setWfAnchored} className="scale-90" aria-label="Anchored walk-forward windows" />
                          <Label htmlFor="bt-wf-anch" className="text-[10px] text-zinc-500" title="Anchored = each fold tunes on everything from the start (expanding IS). Off = rolling fixed-length IS window immediately before each out-of-sample segment.">Anchored</Label>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor="bt-mintrades-wf" className="text-[10px] text-zinc-500">Min trades to score</Label>
                          <Input id="bt-mintrades-wf" value={props.minTrades} onChange={(e) => props.setMinTrades(e.target.value)} inputMode="numeric" aria-label="Minimum trades to score a combination" className="h-8 w-16 border-zinc-800 bg-zinc-950 text-xs" />
                        </div>
                      </div>
                    )}
                    {level === 'sweep' && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Label htmlFor="bt-topx" className="text-[10px] text-zinc-500" title="How many winning configurations to list (1–20)">Top</Label>
                        <Input id="bt-topx" value={props.topX} onChange={(e) => props.setTopX(e.target.value)} onBlur={() => props.setTopX(String(Math.min(20, Math.max(1, Math.round(Number(props.topX) || 8)))))} inputMode="numeric" aria-label="Number of sweep winners to list" className="h-8 w-14 border-zinc-800 bg-zinc-950 text-xs" />
                        <span className="text-[10px] text-zinc-600">setups listed</span>
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor="bt-mintrades-sw" className="text-[10px] text-zinc-500">Min trades to score</Label>
                          <Input id="bt-mintrades-sw" value={props.minTrades} onChange={(e) => props.setMinTrades(e.target.value)} inputMode="numeric" aria-label="Minimum trades to score a combination" className="h-8 w-16 border-zinc-800 bg-zinc-950 text-xs" />
                        </div>
                      </div>
                    )}
                    {level === 'kronos' && (
                      <p className="text-[10px] leading-snug text-zinc-500">
                        First run computes ~35 walk-forward forecasts (≈5 min of model CPU — each origin sees only its past bars, no look-ahead). Verdicts are cached per window, so
                        re-running with different TP/SL is instant. The same gate is available on LIVE runs (&quot;Kronos AI gate&quot; in the run setup).
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* hero CTA */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  className="h-12 gap-2 bg-gradient-to-r from-amber-500 to-yellow-500 px-6 text-sm font-bold text-zinc-950 shadow-[0_0_20px_-6px_rgb(245_158_11/0.6)] hover:from-amber-400 hover:to-yellow-400"
                  disabled={ctaDisabled}
                  aria-describedby="bt-run-phase"
                  title={ctaDisabled && ctaBlocker ? ctaBlocker : `Runs the full ${LEVEL_META[level].label} pipeline: fetch → prepare → … → golden result`}
                  onClick={() => onRun(LEVEL_META[level].mode)}
                >
                  {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  Run head-to-end
                </Button>
                <span className="text-[10px] leading-snug text-zinc-500">
                  {LEVEL_META[level].label} · {studio.symbol || '—'} {studio.entryTf} · last {studio.days}d —
                  fetch → prepare → … → <span className="text-yellow-500">golden result</span>, one click
                </span>
                {wfHeadroom?.short && (
                  <p className="w-full text-[10px] leading-snug text-amber-400" role="note">
                    Headroom: ≈{fmtBars(wfHeadroom.est)} bars from the current window vs ≈{fmtBars(wfHeadroom.needed)} needed for {wfHeadroom.foldsN} walk-forward fold(s) + hold-out — widen History (step ②) so folds don&apos;t shrink; the run degrades folds and yields the hold-out to fit.
                  </p>
                )}
              </div>
              <p id="bt-run-phase" aria-live="polite" className={cn('mt-1 text-[10px]', flow.failed ? 'text-rose-300' : running ? 'text-amber-300' : 'text-zinc-600')}>
                {phaseText}
              </p>
              {ctaDisabled && !running && ctaBlocker && (
                <p className="mt-1 text-[10px] text-amber-400" role="note">{ctaBlocker} — the CTA unlocks once steps ①–④ are valid.</p>
              )}

              {/* pipeline flow chart — always on stage */}
              <BacktestFlowChart
                mode={flow.mode}
                swing={isSwing}
                activePhase={flow.activePhase}
                finished={flow.finished}
                failed={flow.failed}
                frac={flow.frac}
                stage={flow.stage}
                elapsedSec={flow.elapsedSec}
                ladderLabel={isSwing && ladder ? `${ladder.trendTf} + ${ladder.midTf}` : undefined}
              />

              {/* advanced — auto-tune grid */}
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setOptOpen((v) => !v)}
                  aria-expanded={optOpen}
                  className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', optOpen && 'rotate-180')} aria-hidden />
                  <SlidersHorizontal className="h-3 w-3" aria-hidden />
                  Auto-tune parameter grid (advanced — tick ranges, run the optimizer)
                </button>
              </div>
              {optOpen && (
                <div className="mt-3 rounded border border-zinc-800/70 bg-zinc-950/60 p-2.5">
                  <p className="text-[11px] font-semibold text-zinc-300">Grid search — tick the parameters to optimize</p>
                  <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">
                    Unticked parameters stay at the step-③ values. Each combo replays the full period; the grid is capped at ~800 sampled combos (evenly stride-sampled if larger).
                    Score = net return % ÷ max drawdown % (Calmar-style), runs with fewer than the min trades score −∞.
                  </p>
                  <div className="mt-2 flex max-h-72 flex-col gap-1.5 overflow-y-auto terminal-scroll">
                    {def.params.filter((p) => !p.bool).map((p) => {
                      const r = props.ranges[p.key] ?? { on: false, min: String(p.min), max: String(p.max), step: String(p.step) }
                      const gateOff = rangeGateOff(p.key, studio.params)
                      const toggle = (on: boolean) =>
                        props.setRanges((rs) => ({ ...rs, [p.key]: { ...r, on, min: r.min || String(p.min), max: r.max || String(p.max), step: r.step || String(p.step) } }))
                      const patchR = (part: Partial<RangeState>) => props.setRanges((rs) => ({ ...rs, [p.key]: { ...r, ...part } }))
                      return (
                        <div key={p.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-1.5 py-1 hover:bg-zinc-900/60">
                          <Switch checked={r.on} onCheckedChange={toggle} className="scale-90" aria-label={`Optimize ${p.label}`} />
                          <span className="min-w-28 text-[11px] text-zinc-300">{p.label}</span>
                          <span className="text-[10px] text-zinc-600">setup {paramsStr(studio.params[p.key])}</span>
                          {gateOff && (
                            <span className="text-[9px] text-amber-400/80" title="The controlling gate is OFF — the engine drops this dimension (every combo would score identically). Turn it on in the strategy parameters to sweep it.">
                              ({gateOff} — inert)
                            </span>
                          )}
                          {r.on && (
                            <span className="ml-auto flex items-center gap-1">
                              <NumIn value={r.min} onChange={(v) => patchR({ min: v })} label={`${p.label} min`} />
                              <span className="text-[10px] text-zinc-600">→</span>
                              <NumIn value={r.max} onChange={(v) => patchR({ max: v })} label={`${p.label} max`} />
                              <span className="text-[10px] text-zinc-600">step</span>
                              <NumIn value={r.step} onChange={(v) => patchR({ step: v })} label={`${p.label} step`} />
                            </span>
                          )}
                        </div>
                      )
                    })}
                    {([
                      { key: 'tpValue', label: studio.tpUnit === 'atr' ? 'Take profit ×ATR' : 'Take profit %', dMin: '0.5', dMax: '4', dStep: '0.5', setup: studio.tpOn && studio.tpPct !== '' ? studio.tpPct : 'off' },
                      { key: 'slValue', label: studio.slUnit === 'atr' ? 'Stop loss ×ATR' : 'Stop loss %', dMin: '0.25', dMax: '3', dStep: '0.25', setup: studio.slOn && studio.slPct !== '' ? studio.slPct : 'off' },
                    ]).map((p) => {
                      const r = props.ranges[p.key] ?? { on: false, min: p.dMin, max: p.dMax, step: p.dStep }
                      const toggle = (on: boolean) =>
                        props.setRanges((rs) => ({ ...rs, [p.key]: { ...r, on, min: r.min || p.dMin, max: r.max || p.dMax, step: r.step || p.dStep } }))
                      const patchR = (part: Partial<RangeState>) => props.setRanges((rs) => ({ ...rs, [p.key]: { ...r, ...part } }))
                      return (
                        <div key={p.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border-t border-zinc-800/40 px-1.5 pt-1 hover:bg-zinc-900/60">
                          <Switch checked={r.on} onCheckedChange={toggle} className="scale-90" aria-label={`Optimize ${p.label}`} />
                          <span className="min-w-28 text-[11px] text-sky-300/90">{p.label}</span>
                          <span className="text-[10px] text-zinc-600">setup {p.setup}</span>
                          {r.on && (
                            <span className="ml-auto flex items-center gap-1">
                              <NumIn value={r.min} onChange={(v) => patchR({ min: v })} label={`${p.label} min`} />
                              <span className="text-[10px] text-zinc-600">→</span>
                              <NumIn value={r.max} onChange={(v) => patchR({ max: v })} label={`${p.label} max`} />
                              <span className="text-[10px] text-zinc-600">step</span>
                              <NumIn value={r.step} onChange={(v) => patchR({ step: v })} label={`${p.label} step`} />
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="bt-mintrades" className="text-[10px] text-zinc-500">Min trades to score</Label>
                      <Input id="bt-mintrades" value={props.minTrades} onChange={(e) => props.setMinTrades(e.target.value)} inputMode="numeric" className="h-8 w-16 border-zinc-800 bg-zinc-950 text-xs" />
                    </div>
                    <span className="text-[10px] text-zinc-600">
                      {props.activeRanges.length === 0 ? 'tick at least one parameter' : `${props.activeRanges.length} parameter${props.activeRanges.length === 1 ? '' : 's'} selected`}
                    </span>
                    <Button
                      className="ml-auto h-9 gap-2 bg-amber-600 px-3 text-xs text-white hover:bg-amber-500"
                      disabled={running || props.activeRanges.length === 0 || allIssues.length > 0}
                      onClick={() => onOptimize()}
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

              <div className="mt-2 flex justify-end">
                <Button variant="ghost" className="min-h-[44px] gap-1.5 px-3 text-[11px] text-zinc-400 hover:text-zinc-200" onClick={onResetDefaults}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  Reset to defaults
                </Button>
              </div>
            </div>
          </StudioStep>
        </div>
      </div>
    </div>
  )
}

// ---- local subcomponents -------------------------------------------------

/** Step ① lane card with its inline SVG illustration (spec §2.3 #1). */
function LaneCard({ selected, onClick, title, desc, illo }: { selected: boolean; onClick: () => void; title: string; desc: string; illo: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex min-h-[44px] items-center gap-3 rounded-md border p-4 text-left transition-colors',
        selected ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 hover:bg-zinc-900',
      )}
    >
      <span className="shrink-0 rounded-md border border-zinc-800/70 bg-zinc-950/70 p-1.5">{illo}</span>
      <span className="min-w-0">
        <span className={cn('block text-sm font-bold', selected ? 'text-zinc-100' : 'text-zinc-300')}>{title}</span>
        <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">{desc}</span>
      </span>
    </button>
  )
}

/** Step ④ TP/SL bracket card: switch + value + %/ATR unit segmented. */
function BracketCard({ id, title, on, onToggle, value, onValue, unit, onUnit }: {
  id: string
  title: string
  on: boolean
  onToggle: (v: boolean) => void
  value: string
  onValue: (v: string) => void
  unit: 'pct' | 'atr'
  onUnit: (u: 'pct' | 'atr') => void
}) {
  return (
    <div className={cn('rounded border p-2.5', on ? 'border-zinc-700/80 bg-zinc-900/50' : 'border-zinc-800/60 bg-zinc-900/40')}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-[11px] leading-tight text-zinc-300">{title}</Label>
        <Switch id={id} checked={on} onCheckedChange={onToggle} className="scale-90" />
      </div>
      {on && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input value={value} onChange={(e) => onValue(e.target.value)} inputMode="decimal" aria-label={`${title} value`} className="h-9 w-20 border-zinc-800 bg-zinc-950 text-xs" />
          <Segmented
            ariaLabel={`${title} unit`}
            value={unit}
            onChange={onUnit}
            options={[
              { value: 'pct', label: '%' },
              { value: 'atr', label: '×ATR' },
            ]}
          />
        </div>
      )}
    </div>
  )
}

/** Step ④ cost input with the "suggested N" chip (Task 88 parity). */
function CostInput({ id, label, value, onValue, suggest, suggestTitle, hint }: {
  id: string
  label: string
  value: string
  onValue: (v: string) => void
  suggest?: number
  suggestTitle?: string
  hint?: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-1">
        <Label htmlFor={id} className="text-[10px] text-zinc-500">{label} (bps)</Label>
        {suggest != null && (
          <button
            type="button"
            onClick={() => onValue(String(suggest))}
            title={suggestTitle}
            className="text-[9px] text-emerald-400/90 hover:text-emerald-300"
          >
            suggested {suggest}
          </button>
        )}
      </div>
      <Input
        id={id} value={value}
        onChange={(e) => onValue(e.target.value)}
        onBlur={() => onValue(String(Math.min(500, Math.max(0, Math.round(Number(value) || 0)))))}
        inputMode="numeric"
        className="mt-1 h-9 border-zinc-800 bg-zinc-950 text-xs"
      />
      {hint && <p className="mt-0.5 text-[9px] leading-tight text-zinc-600">{hint}</p>}
    </div>
  )
}

/** Validation-depth tile (step ⑤) — the pre-studio picker, touch-bumped. */
function LevelTile({ active, icon: Icon, title, time, desc, badge, onClick }: {
  active: boolean
  icon: LucideIcon
  title: string
  time: string
  desc: string
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'min-h-[44px] rounded-md border p-3 text-left transition-colors',
        active ? 'border-violet-500/60 bg-violet-500/10' : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-600 hover:bg-zinc-900',
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-violet-300' : 'text-zinc-500')} aria-hidden />
        <span className={cn('text-[11px] font-semibold', active ? 'text-zinc-100' : 'text-zinc-300')}>{title}</span>
        {badge && <Badge variant="outline" className="border-emerald-500/40 px-1 py-0 text-[8px] uppercase tracking-wide text-emerald-300">{badge}</Badge>}
        <span className="ml-auto shrink-0 text-[9px] tabular-nums text-zinc-600">{time}</span>
      </span>
      <span className={cn('mt-1 block text-[10px] leading-snug', active ? 'text-zinc-400' : 'text-zinc-500')}>{desc}</span>
    </button>
  )
}

// small helper — a fixed-size array ref with stable identity
function useRefArray<T>(size: number) {
  const ref = useMemo<{ slots: (T | null)[]; get: (i: number) => T | null; set: (i: number, v: T | null) => void }>(() => {
    const slots: (T | null)[] = new Array(size).fill(null)
    return {
      slots,
      get: (i: number) => slots[i] ?? null,
      set: (i: number, v: T | null) => { slots[i] = v },
    }
  }, [size])
  return ref
}


