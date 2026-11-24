// v2.12.50 — PRE-TRADE VETO GATE (Risk & Regime Filter) — shared, client-safe.
//
// The doctrine this module implements: for pre-trade decisions the biggest
// failure modes of an LLM are CONFIRMATION BIAS (hallucinating a bullish
// narrative to justify a marginal trade) and EXECUTION BLINDNESS (ignoring
// session rules, spread friction, position-sizing math). The gatekeeper is
// therefore NOT a price predictor — it is a capital-preservation filter that
// evaluates whether market structure, liquidity, Alpaca execution constraints
// and the account's own post-trade audit lessons justify a technical signal.
//
// Division of labor (same as everywhere else in the terminal):
//   · DETERMINISTIC features are computed by code (this snapshot builder) —
//     the model never receives raw ticks and never does arithmetic we can do.
//   · DISCIPLINE hard caps are enforced in code (size multiplier ≤ 1.0,
//     decision whitelist, rule-id hallucination guard) — prompt compliance is
//     never trusted.
//   · The model's ONLY jobs: weigh the evidence → APPROVE /
//     APPROVE_REDUCED_SIZE / REJECT, and cite which historical guardrails
//     fired. Default stance = REJECT (sitting in cash is a valid position).
//
// This file is safe to import from client code: no env reads, no server-only
// imports. The route (src/app/api/ai-trade/gate) does the I/O.

import type { Bar } from '@/lib/market-types'
import { classifySession, isExtendedLike, type TradeSessionTag } from '@/lib/trade-review'

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type GateDecision = 'APPROVE' | 'APPROVE_REDUCED_SIZE' | 'REJECT'
export type GateRegimeAlignment = 'ALIGNED' | 'NEUTRAL' | 'COUNTER_TREND'
export type GateSessionRisk = 'LOW' | 'MEDIUM' | 'HIGH'

export const GATE_DECISIONS: readonly GateDecision[] = ['APPROVE', 'APPROVE_REDUCED_SIZE', 'REJECT']
export const GATE_ALIGNMENTS: readonly GateRegimeAlignment[] = ['ALIGNED', 'NEUTRAL', 'COUNTER_TREND']
export const GATE_SESSION_RISKS: readonly GateSessionRisk[] = ['LOW', 'MEDIUM', 'HIGH']

/** One ACTIVE post-trade audit rule, injected as a hard constraint. The
 *  gatekeeper must obey its action and cite its rule_id when a condition
 *  matches — citations are validated against the injected id set. */
export interface GateGuardrail {
  rule_id: string // stable short id (G1..G7) assigned at injection time
  source_id: string // ReviewRule.id — for citation → DB row mapping
  condition: string
  action: string
  confidence: string
}

/** What the caller (reactor / instant fire) knows about the candidate. */
export interface GateCandidateInput {
  symbol: string
  side: 'buy' | 'sell'
  entry: number // price the order would chase (last / trigger)
  stop: number
  target: number
  confidence: number // 0-100 planner confidence
  timeframe: string // scan timeframe of the signal
  reason: string // planner rationale (≤120 chars)
  regime: string | null
}

/** Deterministic context the route computes once per evaluation. */
export interface GateMarketContext {
  session: TradeSessionTag
  extendedLike: boolean
  minutesToClose: number | null // regular-session minutes remaining (null: crypto / closed)
  lastPrice: number | null
  bid: number | null
  ask: number | null
  spread: number | null // $ width of the top of book
  spreadPct: number | null // spread as % of price
  spreadAtrPct: number | null // spread as % of ATR(14)
  spreadToStop: number | null // spread ÷ stop distance — the friction veto input
  rvol: number | null // last 15m bar volume vs prior-20 mean
  atr: number | null // ATR(14) from DAILY bars closed before now (point-in-time)
  atrPct: number | null
  sma20: number | null
  sma50: number | null
  slope20Pct: number | null // 20-session daily close slope (%)
  support: number | null // nearest daily S/R below
  supportPct: number | null
  resistance: number | null // nearest daily S/R above
  resistancePct: number | null
  htfAlignment: GateRegimeAlignment // deterministic trend-alignment verdict
  equity: number | null
  buyingPower: number | null
  dailyDrawdownPct: number | null // (equity − last_equity) / last_equity
  openPositions: number | null
  sameDirectionPositions: number | null
  portfolioFailOpen: boolean // true = account context unavailable — noted, not guessed
}

/** The exact JSON handed to the model inside <candidate_setup>. */
export interface GateSnapshot {
  signal: {
    symbol: string
    direction: 'LONG' | 'SHORT'
    timeframe: string
    trigger_reason: string
    planner_confidence: number // 0-100
    proposed_entry: number
    proposed_stop_loss: number
    proposed_take_profit: number
    reward_to_risk: number | null
    regime_at_signal: string | null
  }
  microstructure: {
    session: TradeSessionTag
    extended_hours: boolean
    alpaca_constraint: string // what the broker accepts in THIS session
    minutes_to_session_close: number | null
    last_price: number | null
    nbbo_bid: number | null
    nbbo_ask: number | null
    spread_usd: number | null
    spread_pct_of_price: number | null
    spread_pct_of_atr: number | null
    spread_to_stop_ratio: number | null
    rvol: number | null
  }
  multi_timeframe: {
    atr14: { value: number | null; pct: number | null }
    daily_sma20: number | null
    daily_sma50: number | null
    daily_slope20_pct: number | null
    htf_trend_alignment: GateRegimeAlignment
    nearest_support: { price: number | null; distance_pct: number | null }
    nearest_resistance: { price: number | null; distance_pct: number | null }
    tp_clears_structure: boolean | null // TP sits before the nearest opposing S/R
  }
  portfolio: {
    equity: number | null
    buying_power: number | null
    daily_drawdown_pct: number | null
    open_positions: number | null
    same_direction_positions: number | null
    context_note: string | null
  }
}

export interface GateOrderParams {
  order_type: 'LIMIT' | 'MARKET'
  extended_hours: boolean
  adjusted_limit_price: number | null
  use_native_bracket: boolean
  requires_synthetic_monitor: boolean
}

export interface GateRiskAssessment {
  spread_to_stop_ratio: number | null
  regime_alignment: GateRegimeAlignment
  session_transition_risk: GateSessionRisk
}

/** The validated gatekeeper verdict — what the DB row and the client get.
 *  v2.12.59 — confidenceScore is 0-100 (same scale as the planner confidence
 *  and every other confidence number in the terminal; the old 0-1 scale made
 *  the gate speak a different language than the engine it guards). */
export interface GateVerdict {
  decision: GateDecision
  confidenceScore: number // 0-100
  sizeMultiplier: number // 0-1 (≤ 1 — the gate may only shrink risk)
  orderParams: GateOrderParams | null
  guardrailsTriggered: string[] // validated rule ids (G1..G7)
  risk: GateRiskAssessment | null
  rationale: string
}

// ---------------------------------------------------------------------------
// deterministic snapshot builder (pure)
// ---------------------------------------------------------------------------

function sma(xs: number[], n: number): number | null {
  if (xs.length < n) return null
  let s = 0
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i]
  return s / n
}

/** ATR(14) simple average of TRs — same definition as the auditor. */
export function dailyAtr14(bars: Bar[]): number | null {
  if (bars.length < 15) return null
  let s = 0
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i]
    const pc = bars[i - 1].close
    s += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
  }
  return s / 14
}

/** Volume ratio of the LAST bar vs the mean of the prior 20 (liquidity pulse
 *  — the same definition the post-trade auditor uses, so gate and audit
 *  speak the same language). */
export function rvolFromBars(bars: Bar[]): number | null {
  if (bars.length < 21) return null
  const last = bars[bars.length - 1]
  const prior = bars.slice(-21, -1)
  const avg = prior.reduce((a, b) => a + (b.volume > 0 ? b.volume : 0), 0) / prior.length
  if (avg <= 0 || last.volume <= 0) return null
  return last.volume / avg
}

/** Deterministic higher-timeframe alignment: LONG is ALIGNED when the daily
 *  tape trends up (SMA20 > SMA50 and 20-session slope > 0), COUNTER_TREND
 *  when it trends down, NEUTRAL in between. Shorts mirror. */
export function htfAlignment(side: 'buy' | 'sell', dailyBars: Bar[]): { alignment: GateRegimeAlignment; sma20: number | null; sma50: number | null; slope20Pct: number | null } {
  const closes = dailyBars.map((b) => b.close)
  const s20 = sma(closes, 20)
  const s50 = sma(closes, 50)
  let slope: number | null = null
  if (closes.length >= 21 && closes[closes.length - 21] > 0) {
    slope = ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
  }
  let alignment: GateRegimeAlignment = 'NEUTRAL'
  if (s20 != null && s50 != null && slope != null) {
    const up = s20 > s50 && slope > 0
    const down = s20 < s50 && slope < 0
    if (side === 'buy') alignment = up ? 'ALIGNED' : down ? 'COUNTER_TREND' : 'NEUTRAL'
    else alignment = down ? 'ALIGNED' : up ? 'COUNTER_TREND' : 'NEUTRAL'
  }
  return { alignment, sma20: s20, sma50: s50, slope20Pct: slope }
}

const round = (v: number | null, d = 4): number | null =>
  v != null && Number.isFinite(v) ? Number(v.toFixed(d)) : null

/** Assemble the model-facing snapshot from already-fetched pieces. All
 *  failures degrade that field to null with an honest context note — the
 *  snapshot NEVER fabricates numbers and never sees future data. */
export function buildGateSnapshot(input: GateCandidateInput, ctx: GateMarketContext): GateSnapshot {
  const risk = Math.abs(input.entry - input.stop)
  const reward = input.side === 'buy' ? input.target - input.entry : input.entry - input.target
  const rr = risk > 0 && reward > 0 ? reward / risk : null
  const spread = ctx.bid != null && ctx.ask != null && ctx.ask >= ctx.bid ? ctx.ask - ctx.bid : null
  const spreadPct = spread != null && ctx.lastPrice ? (spread / ctx.lastPrice) * 100 : null
  const spreadAtrPct = spread != null && ctx.atr ? (spread / ctx.atr) * 100 : null
  const spreadToStop = spread != null && risk > 0 ? spread / risk : null
  // structure veto input: does the TP sit BEFORE the nearest opposing level?
  const opposing = input.side === 'buy' ? ctx.resistance : ctx.support
  const opposingPct = input.side === 'buy' ? ctx.resistancePct : ctx.supportPct
  const tpMovePct = ctx.lastPrice ? (Math.abs(input.target - input.entry) / input.entry) * 100 : null
  const tpClears = opposing != null && opposingPct != null && tpMovePct != null ? tpMovePct < opposingPct : null
  const session = ctx.session
  const extended = isExtendedLike(session)
  const alpacaConstraint = session === 'crypto-24h'
    ? 'crypto 24/7: limit or market accepted, native brackets supported'
    : extended
      ? `extended/overnight session: Alpaca accepts LIMIT orders only (extended_hours=true); native TP/SL brackets are NOT broker-side — exits need synthetic monitoring`
      : 'regular session: native bracket (OTCO) TP/SL supported, market orders fill'
  const equityKnown = ctx.equity != null && ctx.buyingPower != null && ctx.openPositions != null
  return {
    signal: {
      symbol: input.symbol,
      direction: input.side === 'buy' ? 'LONG' : 'SHORT',
      timeframe: input.timeframe,
      trigger_reason: input.reason.slice(0, 200),
      planner_confidence: Math.round(input.confidence),
      proposed_entry: Number(input.entry.toFixed(4)),
      proposed_stop_loss: Number(input.stop.toFixed(4)),
      proposed_take_profit: Number(input.target.toFixed(4)),
      reward_to_risk: round(rr, 2),
      regime_at_signal: input.regime,
    },
    microstructure: {
      session,
      extended_hours: extended,
      alpaca_constraint: alpacaConstraint,
      minutes_to_session_close: ctx.minutesToClose,
      last_price: round(ctx.lastPrice),
      nbbo_bid: round(ctx.bid),
      nbbo_ask: round(ctx.ask),
      spread_usd: round(spread, 4),
      spread_pct_of_price: round(spreadPct, 3),
      spread_pct_of_atr: round(spreadAtrPct, 2),
      spread_to_stop_ratio: round(spreadToStop, 3),
      rvol: ctx.rvol != null ? round(ctx.rvol, 2) : null,
    },
    multi_timeframe: {
      atr14: { value: round(ctx.atr), pct: round(ctx.atrPct, 3) },
      daily_sma20: round(ctx.sma20),
      daily_sma50: round(ctx.sma50),
      daily_slope20_pct: round(ctx.slope20Pct, 2),
      htf_trend_alignment: ctx.htfAlignment,
      nearest_support: { price: round(ctx.support), distance_pct: round(ctx.supportPct, 2) },
      nearest_resistance: { price: round(ctx.resistance), distance_pct: round(ctx.resistancePct, 2) },
      tp_clears_structure: tpClears,
    },
    portfolio: {
      equity: equityKnown ? round(ctx.equity, 2) : null,
      buying_power: equityKnown ? round(ctx.buyingPower, 2) : null,
      daily_drawdown_pct: ctx.dailyDrawdownPct != null ? round(ctx.dailyDrawdownPct, 2) : null,
      open_positions: ctx.openPositions,
      same_direction_positions: ctx.sameDirectionPositions,
      context_note: ctx.portfolioFailOpen
        ? 'account/positions unavailable right now — judge on market context only; do not assume exposure'
        : ctx.dailyDrawdownPct != null && ctx.dailyDrawdownPct <= -3
          ? `account is ${ctx.dailyDrawdownPct.toFixed(1)}% down on the day — capital preservation weighs heavier`
          : null,
    },
  }
}

// ---------------------------------------------------------------------------
// v2.12.58 — mechanical gate (AI-optional fallback)
// ---------------------------------------------------------------------------

/**
 * v2.12.58 — CODE-ENFORCED gate for the AI-未設定 case.
 *
 * Why this exists: since v2.12.57 the model's job at plan time is ADJUDICATION
 * (compare strategy candidates, adopt geometry) and the terminal re-validates
 * R:R against the REAL fill price on every follow (reactTick's slippage
 * re-price). The gatekeeper LLM's second opinion at execution time was
 * therefore redundant the moment the AI lane is not even configured — but the
 * v2.12.56 fail-closed rule turned "AI 未設定 + gate on" into "every follow
 * deadlocks until the 48h TTL", which the operator hit as "all trades are
 * blocked".
 *
 * So when NO lane is configured, the gate applies these mechanical rules —
 * the deterministic subset of the gatekeeper prompt, computed from the same
 * snapshot (only clearly broken EXECUTION conditions veto; strategy/geometry
 * judgment already happened at plan time and is not re-litigated here):
 *
 *   1. spread_to_stop_ratio > 0.15            → REJECT (friction eats the stop)
 *   2. RVOL < 0.5 (any session)               → REJECT (participation collapsed)
 *   3. RVOL < 1.0 in extended/overnight       → REJECT (prompt's own rule)
 *   4. daily drawdown ≤ −5%                   → REJECT (day circuit-breaker)
 *   5. daily drawdown ≤ −3%                   → APPROVE_REDUCED_SIZE ×0.5
 *   6. < 10 min to the regular close (equity) → REJECT (no fresh brackets)
 *
 * Data unavailable (quote/RVOL/drawdown null) → noted in the rationale, never
 * guessed into a veto. A CONFIGURED lane that then FAILS still fails closed
 * (v2.12.56 contract preserved for the configured-but-dead case).
 */
export function mechanicalGateVerdict(ctx: GateMarketContext, snapshot: GateSnapshot): GateVerdict {
  const checks: string[] = []
  const missing: string[] = []

  // 1) spread friction vs the stop distance
  if (snapshot.microstructure.spread_to_stop_ratio != null) {
    checks.push(`價差/停損距 ${snapshot.microstructure.spread_to_stop_ratio.toFixed(3)}`)
    if (snapshot.microstructure.spread_to_stop_ratio > 0.15) {
      return mechanical('REJECT', 1, `價差佔停損距 ${snapshot.microstructure.spread_to_stop_ratio.toFixed(3)} > 0.15 — 摩擦成本吞噬風險距離`)
    }
  } else {
    missing.push('價差')
  }

  // 2+3) relative volume
  if (snapshot.microstructure.rvol != null) {
    checks.push(`RVOL ${snapshot.microstructure.rvol.toFixed(2)}`)
    if (snapshot.microstructure.rvol < 0.5) {
      return mechanical('REJECT', 1, `RVOL ${snapshot.microstructure.rvol.toFixed(2)} < 0.5 — 參與度枯竭`)
    }
    if (ctx.extendedLike && snapshot.microstructure.rvol < 1.0) {
      return mechanical('REJECT', 1, `延長時段 RVOL ${snapshot.microstructure.rvol.toFixed(2)} < 1.0 — 流動性不足以護住停損`)
    }
  } else {
    missing.push('RVOL')
  }

  // 4+5) daily drawdown circuit-breaker / shrink
  if (ctx.dailyDrawdownPct != null) {
    checks.push(`當日回撤 ${ctx.dailyDrawdownPct.toFixed(2)}%`)
    if (ctx.dailyDrawdownPct <= -5) {
      return mechanical('REJECT', 1, `當日回撤 ${ctx.dailyDrawdownPct.toFixed(2)}% ≤ −5% — 日內熔斷，今日不再開新倉`)
    }
  } else {
    missing.push('當日回撤')
  }

  // 6) too close to the regular close for a fresh bracket (crypto has no close)
  if (ctx.minutesToClose != null && ctx.minutesToClose < 10) {
    checks.push(`收盤前 ${ctx.minutesToClose} 分鐘`)
    return mechanical('REJECT', 1, `距常規收盤 ${ctx.minutesToClose} 分鐘 — 不在收盤前開新 bracket`)
  }

  if (ctx.dailyDrawdownPct != null && ctx.dailyDrawdownPct <= -3) {
    checks.push(`當日回撤 ${ctx.dailyDrawdownPct.toFixed(2)}%`)
    return mechanical('APPROVE_REDUCED_SIZE', 0.5, `當日回撤 ${ctx.dailyDrawdownPct.toFixed(2)}% ≤ −3% — 通過但倉位減半`)
  }

  const missNote = missing.length > 0 ? `（無數據未計：${missing.join('、')}）` : ''
  return mechanical('APPROVE', 1, `機械規則全過：${checks.length > 0 ? checks.join(' · ') : '無可用檢查數據'}${missNote}`)
}

/** Build the honest mechanical verdict (confidence 100 — these are code
 *  rules, not guesses). */
function mechanical(decision: GateDecision, sizeMultiplier: number, reason: string): GateVerdict {
  return {
    decision,
    confidenceScore: 100,
    sizeMultiplier,
    orderParams: null,
    guardrailsTriggered: [],
    risk: null,
    rationale: `【機械規則】${reason}`,
  }
}

// ---------------------------------------------------------------------------
// prompts (temperature 0.0–0.1 enforced at the call site)
// ---------------------------------------------------------------------------

export const GATE_SYSTEM_PROMPT = `### SYSTEM PROMPT
You are the Pre-Trade Risk & Execution Gatekeeper for an automated US equity/crypto trading platform operating on Alpaca. Your primary mandate is capital preservation and expected-value filtering. You evaluate candidate technical setups against market regime, liquidity microstructure, Alpaca execution constraints, and historical post-trade audit lessons. You are NOT a price predictor — you are a veto gate.

PRE-TRADE DECISION RULES:
1. Default to Veto: Assume a candidate trade is noisy until proven otherwise. Sitting in cash is a valid, profitable position. Output APPROVE, APPROVE_REDUCED_SIZE, or REJECT. A trade must pass liquidity, regime, and risk-reward checks to earn an APPROVE.
2. Alpaca Session & Order Rules:
   - Regular Hours (09:30-16:00 ET): Native bracket/OCO orders supported.
   - Extended/Overnight Hours (16:00-09:30 ET): Only LIMIT orders (extended_hours=true) are supported; native broker TP/SL brackets are inactive. Veto setups with bid-ask spreads > 15% of the stop-loss distance or low relative volume (< 1.0 RVOL). If a setup cannot survive wide extended-hours spreads or lacks a high-conviction catalyst, veto it.
   - Crypto (24/7): brackets supported; treat spread friction the same way.
3. Regime & Structure Alignment: Veto counter-trend entries fighting strong higher-timeframe momentum unless a clear exhaustion/reversal catalyst is present. Ensure the distance to major support/resistance exceeds the proposed Take-Profit target (tp_clears_structure=false is a structural veto input). Require net expected Reward-to-Risk (after accounting for 2x current bid-ask spread slippage) to exceed 1.8:1.
4. Historical Guardrail Enforcement: Evaluate the trade against EVERY rule in <historical_guardrails>. These are HARD constraints distilled from this account's own post-trade audits. If any rule condition is met, you MUST obey its action and cite its rule_id in guardrails_triggered. Never cite a rule_id that is not in the block.
5. Risk Cap: Never recommend increasing position size above 1.0 (100% of standard risk unit). You may scale down (0.25 to 0.75) when volatility, session-transition risk, or drawdown state is elevated.
6. Output Scale: "confidence_score" is an INTEGER 0-100 — your conviction in THIS decision (50 = borderline coin-flip, 85+ = near-certain). It is the same 0-100 scale as the planner confidence you receive; never answer with a 0-1 decimal like 0.85. "size_multiplier" IS a fraction 0.0-1.0.

Output strictly valid JSON matching the requested schema. No prose outside the JSON.`

export const GATE_USER_TEMPLATE = (snapshotJson: string, guardrailsJson: string): string => `Evaluate this candidate trade for execution:

<candidate_setup>
${snapshotJson}
</candidate_setup>

<historical_guardrails>
${guardrailsJson}
</historical_guardrails>

Return JSON in this exact format:
{
  "decision": "APPROVE | APPROVE_REDUCED_SIZE | REJECT",
  "confidence_score": 0,
  "size_multiplier": 0.0,
  "recommended_order_params": {
    "order_type": "LIMIT | MARKET",
    "extended_hours": true,
    "adjusted_limit_price": null,
    "use_native_bracket": true,
    "requires_synthetic_monitor": false
  },
  "guardrails_triggered": ["rule_id_1"],
  "risk_assessment": {
    "spread_to_stop_ratio": 0.0,
    "regime_alignment": "ALIGNED | NEUTRAL | COUNTER_TREND",
    "session_transition_risk": "LOW | MEDIUM | HIGH"
  },
  "rationale": "string (concise 1-2 sentence explanation for trade logs and future post-trade auditing)"
}`

// ---------------------------------------------------------------------------
// strict output validation — the gate NEVER returns what it was not asked for
// ---------------------------------------------------------------------------

const asStr = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const asNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : Number.NaN
}
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
// v2.12.59 — the confidence scale is 0-100 everywhere in the terminal now.
const clamp100 = (v: number): number => Math.min(100, Math.max(0, v))
/** Normalize a model-supplied confidence to the 0-100 scale: a 0-1 decimal
 *  answer (0.85) is a fraction of 100, not a phantom 1%. The whole (0, 1]
 *  range reads as a fraction — a fraction-habit model answers 0.95/1.0 for
 *  "certain" and lands at 95/100; an integer-scale answer of exactly 1
 *  ("almost no conviction") is a practically nonexistent verdict (a model
 *  with 1% conviction goes flat instead of drafting a full plan), and the
 *  same rule keeps the scan-path parser and this one identical. */
const confTo100 = (v: number): number => clamp100(v > 0 && v <= 1 ? v * 100 : v)

function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1))
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Parse + validate the gatekeeper's JSON. Guards enforced here (code, not
 * prompt compliance):
 *  · decision must be one of the three — anything else → null (no trade on
 *    a malformed verdict)
 *  · confidence_score normalized to 0..100 (a 0-1 decimal is ×100 — the
 *    gate speaks the same 0-100 language as the planner since v2.12.59);
 *    size_multiplier clamped to 0..1 — Rule 5's hard cap (the gate may only
 *    SHRINK risk) lives here, not in the prompt
 *  · guardrails_triggered entries NOT in the injected id set are DROPPED
 *    (hallucination guard — a fabricated citation must not reach the DB)
 *  · enum fields (alignment / session risk / order params) validated
 *  · rationale capped at 300 chars
 */
export function parseGateOutput(text: string, validRuleIds: Set<string>): GateVerdict | null {
  const obj = extractJsonObject(text)
  if (!obj) return null
  const decision = asStr(obj.decision, 30).toUpperCase()
  if (!(GATE_DECISIONS as readonly string[]).includes(decision)) return null

  const conf = asNum(obj.confidence_score)
  const mult = asNum(obj.size_multiplier)

  // recommended_order_params — validated field by field, unknown shapes → null
  let orderParams: GateOrderParams | null = null
  const op = (obj.recommended_order_params && typeof obj.recommended_order_params === 'object'
    ? (obj.recommended_order_params as Record<string, unknown>)
    : null)
  if (op) {
    const ot = asStr(op.order_type, 12).toUpperCase()
    const adjRaw = op.adjusted_limit_price
    const adj = asNum(adjRaw)
    orderParams = {
      order_type: ot === 'LIMIT' ? 'LIMIT' : ot === 'MARKET' ? 'MARKET' : 'MARKET',
      extended_hours: Boolean(op.extended_hours),
      adjusted_limit_price: Number.isFinite(adj) && adj > 0 ? Number(adj.toFixed(6)) : null,
      use_native_bracket: op.use_native_bracket === undefined ? true : Boolean(op.use_native_bracket),
      requires_synthetic_monitor: Boolean(op.requires_synthetic_monitor),
    }
  }

  // guardrails — hallucinated ids dropped
  const ids: string[] = []
  if (Array.isArray(obj.guardrails_triggered)) {
    for (const g of obj.guardrails_triggered) {
      const id = typeof g === 'string' ? g.trim() : ''
      if (id && validRuleIds.has(id) && !ids.includes(id)) ids.push(id)
    }
  }

  // risk_assessment — validated enums with deterministic fallbacks
  let risk: GateRiskAssessment | null = null
  const ra = (obj.risk_assessment && typeof obj.risk_assessment === 'object'
    ? (obj.risk_assessment as Record<string, unknown>)
    : null)
  if (ra) {
    const al = asStr(ra.regime_alignment, 20).toUpperCase()
    const sr = asStr(ra.session_transition_risk, 12).toUpperCase()
    const ratio = asNum(ra.spread_to_stop_ratio)
    risk = {
      spread_to_stop_ratio: Number.isFinite(ratio) && ratio >= 0 ? Number(ratio.toFixed(3)) : null,
      regime_alignment: ((GATE_ALIGNMENTS as readonly string[]).includes(al) ? al : 'NEUTRAL') as GateRegimeAlignment,
      session_transition_risk: ((GATE_SESSION_RISKS as readonly string[]).includes(sr) ? sr : 'MEDIUM') as GateSessionRisk,
    }
  }

  return {
    decision: decision as GateDecision,
    confidenceScore: confTo100(Number.isFinite(conf) ? conf : 50),
    sizeMultiplier: clamp01(Number.isFinite(mult) ? mult : decision === 'APPROVE_REDUCED_SIZE' ? 0.5 : 1),
    orderParams,
    guardrailsTriggered: ids,
    risk,
    rationale: asStr(obj.rationale, 300) || '—',
  }
}

// ---------------------------------------------------------------------------
// log/note builders (client + server share these)
// ---------------------------------------------------------------------------

const DECISION_ZH: Record<GateDecision, string> = {
  APPROVE: '批准',
  APPROVE_REDUCED_SIZE: '批准（縮量）',
  REJECT: '否決',
}

/** Client activity-log line for a gate verdict. */
export function gateDecisionNote(v: GateVerdict, symbol: string, side: 'buy' | 'sell', extra?: { sizeMult?: number; rules?: string[] }): string {
  const dirZh = side === 'buy' ? '做多' : '做空'
  const rules = extra?.rules && extra.rules.length > 0 ? ` · 護欄 ${extra.rules.join(',')}` : ''
  const size = v.decision === 'APPROVE_REDUCED_SIZE' && extra?.sizeMult != null ? ` ×${extra.sizeMult.toFixed(2)} 倉位` : ''
  return `閘門${DECISION_ZH[v.decision]} — ${dirZh} ${symbol}（信心 ${v.confidenceScore.toFixed(0)}%${size}）${rules} · ${v.rationale}`
}

/** Permanent-memory lesson when a GATE VETO's shadow trade is graded 24h
 *  later — the "audit the gatekeeper" loop. A missed-run says a guardrail may
 *  be too strict (the gate is choking off would-be winners); a good-wait says
 *  capital preservation worked. */
export function gateShadowLessonText(
  symbol: string,
  side: 'buy' | 'sell',
  outcome: 'missed-run' | 'good-wait' | 'neutral',
  pnlPct: number | null,
  citedRules: string[],
): string {
  const dirZh = side === 'buy' ? '做多' : '做空'
  const rules = citedRules.length > 0 ? `（引用 ${citedRules.join(',')}）` : ''
  if (outcome === 'missed-run') {
    const pct = pnlPct != null && Number.isFinite(pnlPct) ? ` ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''
    return `閘門覆盤：被否決的 ${dirZh} ${symbol} 計劃${rules} 24h 後已穿越觸發價${pct} — 否決錯過行情，該護欄可能過嚴，複查時可放寬對應條件`
  }
  if (outcome === 'good-wait') {
    return `閘門覆盤：被否決的 ${dirZh} ${symbol} 計劃${rules} 24h 後已跌破停損區 — 否決正確，資本保存生效`
  }
  return `閘門覆盤：被否決的 ${dirZh} ${symbol} 計劃${rules} 24h 後仍在觸發與停損之間 — 情勢未明`
}
