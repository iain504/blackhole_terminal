'use client'

// v2.2.0 — Backtest Studio shared state contract (Task 4-b).
//
// The wizard's single source of truth: BacktestPanel OWNS the StudioState
// object (it feeds the POST body), BacktestStudio renders it. Everything the
// five steps need that is pure/stateless lives here too — lane logic, the
// validation-depth picker metadata, bar estimates and the seed/normalize
// helpers — so the panel and the wizard can never drift apart.
//
// Imports from `@/lib/algo-strategies` per the frozen contract (§1.1):
// SWING_TFS / DAY_TFS / isSwingTf / strategyLane / MTF_TREND_TF / MTF_MID_TF
// are landed by the backend agent in parallel — temporary type errors on
// those named exports are expected and resolved by the integrator.
import {
  ALGO_STRATEGIES,
  ALGO_REGIME_PRESETS,
  DAY_TFS,
  SWING_TFS,
  MTF_TREND_TF,
  MTF_MID_TF,
  algoMaxDays,
  isSwingTf,
  normalizeAlgoParams,
  strategyLane,
  type AlgoRegimePresetId,
  type AlgoStrategyId,
  type AlgoTimeframe,
} from '@/lib/algo-strategies'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import type { BtFlowMode } from '../BacktestFlowChart'
import type { AlgoSetupCfg } from '../BacktestPanel'

// v2.1.0 (kept) — the validation depth picked in step ⑤. ONE CTA runs the
// whole pipeline for the chosen level head-to-end.
export type BtLevel = 'quick' | 'wf' | 'sweep' | 'kronos'

export const LEVEL_META: Record<BtLevel, { mode: 'run' | 'walkforward' | 'sweep' | 'kronos-ab'; flow: BtFlowMode; label: string; time: string }> = {
  quick: { mode: 'run', flow: 'run', label: 'Quick check', time: 'seconds' },
  wf: { mode: 'walkforward', flow: 'walkforward', label: 'Walk-forward', time: 'minutes' },
  sweep: { mode: 'sweep', flow: 'sweep', label: 'Sweep all strategies', time: 'minutes' },
  kronos: { mode: 'kronos-ab', flow: 'kronos-ab', label: 'Kronos AI A/B', time: '≈5 min first run' },
}

/** The five sibling run buttons collapse into this union (busy marker). */
export type BtBusy = 'run' | 'optimize' | 'sweep' | 'walkforward' | 'kronos-ab'

/** Optimizer grid dimension (existing shape — the wizard re-uses it 1:1). */
export interface RangeState { on: boolean; min: string; max: string; step: string }

/**
 * v2.2.0 — the wizard state (spec §2.1). Owned by BacktestPanel, passed down
 * as props. Day lane mirrors strategy/params back into the shared run setup
 * via onApplyParams; swing lane is entirely wizard-local.
 */
export interface StudioState {
  /** ① Trading style */
  lane: 'day' | 'swing'
  /** ② Market & data — seeded from cfg.symbol, follows external changes */
  symbol: string
  /** day: 1m|5m|15m · swing: 1h|4h|1D */
  entryTf: AlgoTimeframe
  /** ③ Strategy + params (normalized per strategy) */
  strategy: AlgoStrategyId
  params: Record<string, number>
  /** history window (chips + custom), clamped by algoMaxDays */
  days: string
  capital: string
  /** maxNotionalX (× capital) */
  lev: string
  /** ④ Risk & costs — seeded from cfg, editable here */
  sizingMode: 'fixed' | 'risk'
  qty: string
  riskBasis: 'usd' | 'pct'
  riskMoney: string
  riskMoneyPct: string
  tpOn: boolean
  tpPct: string
  tpUnit: 'pct' | 'atr'
  slOn: boolean
  slPct: string
  slUnit: 'pct' | 'atr'
  trailOn: boolean
  trailArm: string
  trailGive: string
  /** execution costs (bps) + vol-scaled slippage */
  slippageBps: string
  feeBps: string
  spreadBps: string
  dynSlip: boolean
  /** last-clicked regime preset (research = frictionless discovery) */
  regimePreset: AlgoRegimePresetId
  /** v2.6.0 — swing MTF ladder: 'auto' = the frozen per-entry map,
   *  'custom' = the user's trend/mid pick (validated by validateLadder).
   *  Typed as Timeframe (not AlgoTimeframe) so a 1D entry can ride 1W. */
  ladderMode: 'auto' | 'custom'
  ladderTrend: Timeframe
  ladderMid: Timeframe
  /** day-lane-only session guards (swing hides them; server forces them off) */
  maxTradesDay: string
  rthOnly: boolean
  flattenEod: boolean
  /** hidden ATR-timeframe seeds carried over from the run setup (day lane) */
  tpTf?: string | null
  slTf?: string | null
}

// Task 88 — market-typical execution costs (bps) so the cost model starts
// honest instead of frictionless (crypto majors 3/10, altcoins 10/10, US 2/0).
export const suggestCosts = (symbol: string): { slip: number; fee: number } => {
  if (symbol.includes('/')) {
    const base = symbol.split('/')[0]?.toUpperCase() ?? ''
    return base === 'BTC' || base === 'ETH' ? { slip: 3, fee: 10 } : { slip: 10, fee: 10 }
  }
  return { slip: 2, fee: 0 }
}

/** Entry-TF chips for a lane (day: 1m/5m/15m · swing: 1h/4h/1D). */
export const laneTfs = (lane: 'day' | 'swing'): readonly AlgoTimeframe[] =>
  lane === 'swing' ? SWING_TFS : DAY_TFS

const tfSec = (tf: AlgoTimeframe): number => TIMEFRAMES[tf]?.seconds ?? 900

/** Spec §2.2 — live "≈ N bars" hint. Stocks: intraday TFs print ≈27% of clock
 *  hours (RTH 6.5h/24h ≈ 0.27); 1D prints ≈5 bars per 7 calendar days. Crypto
 *  trades 24/7 so the full clock ratio applies. (v2.2.2 — the 1D stock branch:
 *  the old 0.27× clock formula said 0.27 bars/day where reality is ~0.71 —
 *  the hint understated a 5-year daily window by 2.6×.) */
export const estimateBars = (days: number, tf: AlgoTimeframe, isCrypto: boolean): number => {
  if (tf === '1D' && !isCrypto) return Math.max(0, Math.round(days * (5 / 7)))
  return Math.max(0, Math.round(days * (86400 / tfSec(tf)) * (isCrypto ? 1 : 0.27)))
}
export const fmtBars = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString('en-US'))

/** Resolved MTF ladder labels for a swing entry TF (FROZEN maps, §1.1). */
export const mtfLadder = (entryTf: AlgoTimeframe): { trendTf: string; midTf: string; entryTf: string } | null => {
  if (!isSwingTf(entryTf)) return null
  return { trendTf: MTF_TREND_TF[entryTf], midTf: MTF_MID_TF[entryTf], entryTf }
}

/** v2.6.0 — resolved ladder honoring a custom pick (falls back to frozen). */
export const resolveLadder = (
  entryTf: AlgoTimeframe,
  ladder?: { ladderMode: 'auto' | 'custom'; ladderTrend: Timeframe; ladderMid: Timeframe },
): { trendTf: string; midTf: string; entryTf: string } | null => {
  const base = mtfLadder(entryTf)
  if (base == null || ladder?.ladderMode !== 'custom') return base
  return { trendTf: ladder.ladderTrend, midTf: ladder.ladderMid, entryTf }
}

/**
 * v2.6.0 — structural ladder validation (mirrors the API route): mid must be
 * a STRICTLY higher TF than the entry, trend ≥ mid, both real TIMEFRAMES.
 * Returns the error text or null when the ladder is valid.
 */
export const validateLadder = (
  entryTf: AlgoTimeframe,
  trendTf: Timeframe,
  midTf: Timeframe,
): string | null => {
  const sec = (tf: Timeframe): number => TIMEFRAMES[tf]?.seconds ?? 0
  const entrySec = sec(entryTf)
  const midSec = sec(midTf)
  const trendSec = sec(trendTf)
  if (!(midSec > entrySec)) return `Confirm TF (${midTf}) must be strictly higher than the ${entryTf} entry`
  if (!(trendSec >= midSec)) return `Trend TF (${trendTf}) must be ≥ the confirm TF (${midTf})`
  return null
}

/**
 * v2.6.0 — calendar days the TREND screen needs (trendSma 50 + slope/ADX
 * headroom, stock calendars widened ×7/5) so a deep custom ladder (1W trend)
 * can auto-bump the history window instead of starving silently.
 */
export const ladderMinDays = (trendTf: Timeframe, isCrypto: boolean): number => {
  const trendSec = TIMEFRAMES[trendTf]?.seconds ?? 86400
  const needBuckets = 50 + 30 // trendSma default + slope/ADX headroom
  const raw = Math.ceil((needBuckets * trendSec) / 86400)
  return isCrypto ? raw : Math.ceil((raw * 7) / 5)
}

// The lane TF sets + MTF maps re-exported for the wizard's illustrations.
export { DAY_TFS, SWING_TFS, MTF_TREND_TF, MTF_MID_TF }

// Swing-lane risk seed — a sane starting point for multi-day holds: Risk-Money
// sizing (which needs an SL % bracket), 2% stop / 4% target, no trail.
const SWING_RISK_SEED = {
  sizingMode: 'risk' as const,
  riskBasis: 'usd' as const,
  riskMoney: '200',
  riskMoneyPct: '2',
  qty: '10',
  tpOn: true,
  tpPct: '4',
  tpUnit: 'pct' as const,
  slOn: true,
  slPct: '2',
  slUnit: 'pct' as const,
  trailOn: false,
  trailArm: '6',
  trailGive: '2',
}

/**
 * v2.2.2 — recommended history window per swing entry TF (calendar days).
 * The swing trend screen is an SMA(50) on the AGGREGATED daily/weekly series,
 * and stocks print only ~7 hourly / ~2 four-hourly / 1 daily bar per day — a
 * 180-day window (the v2.2.0 seed) carries ~900 hourly bars on TSLA but the
 * trend screen needs ≈50 CLOSED daily buckets, and the 1D entry lane needs
 * ≈50 WEEKLY buckets ≈ 1.4 years. These seeds keep a healthy evaluable
 * window on BOTH asset classes (crypto prints 24 bars/day and is never
 * starved) and all fit the step-② days-chip row:
 *   1h → 365d (stocks ≈1.8k bars) · 4h → 730d (≈1.0k) · 1D → 1825d (≈1.3k)
 * All are ≤ algoMaxDays caps (500 / 1095 / 1825), so the route never clamps.
 */
export const swingSeedDays = (entryTf: AlgoTimeframe): number =>
  entryTf === '1D' ? 1825 : entryTf === '4h' ? 730 : 365

/**
 * Seed the wizard from the shared run setup (spec §2.1 sync rules).
 * `lane` overrides the lane (used by "Reset to defaults" to keep the lane);
 * `keep` preserves user-entered fields across a lane reset (symbol, capital…).
 */
export function makeStudioState(cfg: AlgoSetupCfg, lane?: 'day' | 'swing', keep?: Partial<StudioState>): StudioState {
  const wantSwing = lane === 'swing' || (lane == null && isSwingTf(cfg.timeframe))
  const symbol = keep?.symbol ?? cfg.symbol
  const costs = suggestCosts(symbol)
  if (wantSwing) {
    const entryTf: AlgoTimeframe = '1h'
    const strategy: AlgoStrategyId = 'swing-pullback'
    return {
      lane: 'swing',
      symbol,
      entryTf,
      strategy,
      params: normalizeAlgoParams(strategy, ALGO_STRATEGIES[strategy].defaults),
      // v2.2.2 — deep per-TF seed (was a flat 180d, which starved stocks:
      // ~7 hourly bars/day meant the trend screen never finished its warmup)
      days: String(swingSeedDays(entryTf)),
      capital: keep?.capital ?? '10000',
      lev: keep?.lev ?? '1',
      ...SWING_RISK_SEED,
      slippageBps: keep?.slippageBps ?? String(costs.slip),
      feeBps: keep?.feeBps ?? String(costs.fee),
      spreadBps: keep?.spreadBps ?? '0',
      dynSlip: keep?.dynSlip ?? true,
      regimePreset: keep?.regimePreset ?? 'live',
      // v2.6.0 — ladder seed: frozen map for the seeded entry TF (1h here)
      ladderMode: keep?.ladderMode ?? 'auto',
      ladderTrend: keep?.ladderTrend ?? MTF_TREND_TF[entryTf],
      ladderMid: keep?.ladderMid ?? MTF_MID_TF[entryTf],
      // swing lane: the server forces these off regardless (spec §1.2)
      maxTradesDay: '0',
      rthOnly: false,
      flattenEod: false,
      // no ATR-TF seed in swing — brackets anchor on the entry TF
      tpTf: null,
      slTf: null,
    }
  }
  const strategy: AlgoStrategyId = strategyLane(cfg.strategy) === 'day' ? cfg.strategy : 'bb-reversion'
  return {
    lane: 'day',
    symbol,
    entryTf: isSwingTf(cfg.timeframe) ? '5m' : cfg.timeframe,
    strategy,
    params: normalizeAlgoParams(strategy, strategy === cfg.strategy ? cfg.params : ALGO_STRATEGIES[strategy].defaults),
    days: keep?.days ?? '30',
    capital: keep?.capital ?? '10000',
    lev: keep?.lev ?? '1',
    sizingMode: cfg.sizingMode,
    qty: String(cfg.qty ?? ''),
    riskBasis: cfg.riskBasis,
    riskMoney: cfg.riskMoney != null ? String(cfg.riskMoney) : '',
    riskMoneyPct: cfg.riskMoneyPct != null ? String(cfg.riskMoneyPct) : '',
    tpOn: cfg.tpMode !== 'none',
    tpPct: cfg.tpValue != null ? String(cfg.tpValue) : '',
    tpUnit: cfg.tpMode === 'atr' ? 'atr' : 'pct',
    slOn: cfg.slMode !== 'none',
    slPct: cfg.slValue != null ? String(cfg.slValue) : '',
    slUnit: cfg.slMode === 'atr' ? 'atr' : 'pct',
    trailOn: cfg.trailMode === 'pct',
    trailArm: cfg.trailArmPct != null ? String(cfg.trailArmPct) : '',
    trailGive: cfg.trailGivePct != null ? String(cfg.trailGivePct) : '',
    slippageBps: keep?.slippageBps ?? String(costs.slip),
    feeBps: keep?.feeBps ?? String(costs.fee),
    spreadBps: keep?.spreadBps ?? '0',
    dynSlip: keep?.dynSlip ?? true,
    regimePreset: keep?.regimePreset ?? 'live',
    // v2.6.0 — inert on the day lane (the ladder UI only renders for swing);
    // seeded to the 1h frozen map so a lane flip starts from a valid ladder
    ladderMode: keep?.ladderMode ?? 'auto',
    ladderTrend: keep?.ladderTrend ?? '1D',
    ladderMid: keep?.ladderMid ?? '4h',
    maxTradesDay: String(cfg.maxTradesDay ?? 0),
    rthOnly: cfg.rthOnly,
    flattenEod: cfg.flattenEod,
    tpTf: cfg.tpTf ?? null,
    slTf: cfg.slTf ?? null,
  }
}

const numOr = (v: string, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** A numeric strategy param inside its def range (bools are always fine). */
export function paramInRange(strategy: AlgoStrategyId, key: string, value: number): boolean {
  const p = ALGO_STRATEGIES[strategy].params.find((x) => x.key === key)
  if (!p || p.bool) return true
  return Number.isFinite(value) && value >= p.min && value <= p.max
}

/** Clamp a numeric param into its def range (step-aware). */
export function clampParam(strategy: AlgoStrategyId, key: string, value: number): number {
  const p = ALGO_STRATEGIES[strategy].params.find((x) => x.key === key)
  if (!p || p.bool || !Number.isFinite(value)) return value
  const stepped = Math.round(value / p.step) * p.step
  return Math.min(p.max, Math.max(p.min, Number(stepped.toFixed(6))))
}

/**
 * CTA gating (spec §2.2 step ⑤): disabled until steps ①–④ are valid.
 * Returns blockers bucketed by the step that owns them (empty arrays = ready).
 */
export interface StudioIssues { market: string[]; sizing: string[]; params: string[] }
export function studioIssues(s: StudioState): StudioIssues {
  const market: string[] = []
  const sizing: string[] = []
  const params: string[] = []
  if (!s.symbol.trim()) market.push('Pick a symbol in step ②')
  const days = Math.round(numOr(s.days, 0))
  if (!(days > 0)) market.push('Set a history window in step ②')
  // v2.6.0 — a structurally-invalid CUSTOM ladder blocks the run CTA with the
  // same copy the API would 400 on (mid > entry, trend ≥ mid)
  if (s.lane === 'swing' && s.ladderMode === 'custom') {
    const ladderErr = validateLadder(s.entryTf, s.ladderTrend, s.ladderMid)
    if (ladderErr != null) market.push(`Fix the MTF ladder in step ② — ${ladderErr.toLowerCase()}`)
  }
  const riskBudget = s.sizingMode === 'risk' ? (s.riskBasis === 'pct' ? numOr(s.riskMoneyPct) : numOr(s.riskMoney)) : 0
  if (s.sizingMode === 'fixed') {
    if (!(numOr(s.qty) > 0)) sizing.push('Set a positive quantity in step ④')
  } else {
    if (!(riskBudget > 0)) sizing.push('Risk-Money sizing needs a positive risk budget in step ④')
    if (!(s.slOn && s.slUnit === 'pct' && numOr(s.slPct) > 0)) sizing.push('Risk-Money sizing needs SL % turned on in step ④')
  }
  for (const p of ALGO_STRATEGIES[s.strategy].params) {
    if (p.bool) continue
    if (!paramInRange(s.strategy, p.key, numOr(String(s.params[p.key] ?? ''), NaN))) params.push(`${p.label} is out of range (${p.min}–${p.max})`)
  }
  return { market, sizing, params }
}

export const issueCount = (i: StudioIssues): number => i.market.length + i.sizing.length + i.params.length

/** Count armed walk-forward grid dimensions. */
export const gridArmed = (ranges: Record<string, RangeState>): number =>
  Object.values(ranges).filter((r) => r.on && Number(r.max) > Number(r.min) && Number(r.step) > 0).length

/**
 * v2.2.0 — per-trade MTF context (spec §1.4/§2.2). The backend agent adds the
 * optional `mtf` field to BacktestTrade in parallel; read it structurally so
 * the wizard compiles (and renders nothing) before it lands.
 */
export interface TradeMtfCtx { trend: 'up' | 'down'; midRsi: number; levelPct: number | null }
export function tradeMtf(t: unknown): TradeMtfCtx | null {
  const m = (t as { mtf?: unknown } | null | undefined)?.mtf
  if (!m || typeof m !== 'object') return null
  const r = m as { trend?: unknown; midRsi?: unknown; levelPct?: unknown }
  if (r.trend !== 'up' && r.trend !== 'down') return null
  if (typeof r.midRsi !== 'number' || !Number.isFinite(r.midRsi)) return null
  return {
    trend: r.trend,
    midRsi: r.midRsi,
    levelPct: typeof r.levelPct === 'number' && Number.isFinite(r.levelPct) ? r.levelPct : null,
  }
}

// One import surface for the panel + wizard (pure re-exports, no redefinition).
export { ALGO_STRATEGIES, ALGO_REGIME_PRESETS }
export type { AlgoRegimePresetId, AlgoStrategyId, AlgoTimeframe }
