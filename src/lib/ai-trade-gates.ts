// v2.12.37 — AI auto-trade decision-gate math (PURE, client-safe).
//
// Three win-rate mechanisms the terminal enforces ON TOP of the model's raw
// verdict, so the discipline lives in code, not in prompt compliance:
//
// 1. DYNAMIC THRESHOLDS — the config's minConfidence/minRR are BASE values;
//    the regime raises them for the against-the-wind direction (RISK_OFF →
//    longs pay +10 confidence and ×1.25 R:R, RISK_ON → shorts likewise).
//    Counter-trend entries into a hostile tape are the classic win-rate
//    killer; when the model wants one anyway, it must clear a higher bar.
//
// 2. CONCENTRATION GATE — a new entry must not stack onto a cluster of
//    same-direction holdings that all move together. Uses the price-return
//    correlation matrix (/api/market/correlation): block when the candidate
//    correlates ≥ CONCENTRATION_CORR with ANY same-direction holding, or
//    when the same-direction holding count already reached maxCorrelated.
//    Correlation data may be absent (sim/feed failure) → the correlation
//    rule fails open, the COUNT rule still applies.
//
// 3. POST-HOC ATTRIBUTION labels (verdictRows) — every non-flat verdict is
//    recorded with the context it was decided under (regime, earnings,
//    status) so the 24h reconciliation can distill 「自動交易覆盤」 lessons
//    into the permanent memory.

export type GateRegime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF' | 'UNKNOWN' | null | undefined

/** Regime-dynamic entry thresholds for one candidate direction. */
export function dynamicThresholds(
  minConfidence: number,
  minRR: number,
  regime: GateRegime,
  direction: 'long' | 'short',
): { minConfidence: number; minRR: number; note: string | null } {
  const against = (regime === 'RISK_OFF' && direction === 'long') || (regime === 'RISK_ON' && direction === 'short')
  if (!against) return { minConfidence, minRR, note: null }
  return {
    minConfidence: Math.min(Math.round(minConfidence + 10), 95),
    minRR: Number((minRR * 1.25).toFixed(2)),
    note: regime === 'RISK_OFF'
      ? `RISK_OFF 做多門檻上調（信心 +10 · R:R ×1.25）`
      : `RISK_ON 做空門檻上調（信心 +10 · R:R ×1.25）`,
  }
}

/** A candidate this correlated with a same-direction holding is the same
 *  trade in disguise — stacking it is concentration, not diversification. */
export const CONCENTRATION_CORR = 0.85

export interface CorrMatrix { [sym: string]: { [sym: string]: number } }

/** Concentration verdict for one candidate against the current holdings.
 *  @param candidate the candidate symbol (upper, no slash)
 *  @param candidateDirection the candidate's direction
 *  @param holdings same-direction holdings: { symbol, r } — r null when the
 *                  matrix couldn't answer for that pair (feed/sim failure)
 *  @param maxCorrelated config cap on same-direction correlated holdings */
export function concentrationCheck(
  candidate: string,
  candidateDirection: 'long' | 'short',
  holdings: { symbol: string; r: number | null }[],
  maxCorrelated: number,
): { blocked: boolean; note: string | null } {
  const sameDir = holdings.filter((h) => h.symbol !== candidate)
  if (sameDir.length >= maxCorrelated) {
    return {
      blocked: true,
      note: `集中風險：已有 ${sameDir.length} 個同向持倉（上限 ${maxCorrelated}）— ${candidate} 不再加同向`,
    }
  }
  const withR = sameDir.filter((h) => h.r != null && Number.isFinite(h.r))
  const worst = withR.sort((a, b) => (b.r ?? 0) - (a.r ?? 0))[0]
  if (worst && (worst.r ?? 0) >= CONCENTRATION_CORR) {
    return {
      blocked: true,
      note: `集中風險：與同向持倉 ${worst.symbol} 相關性 ${(worst.r ?? 0).toFixed(2)} ≥ ${CONCENTRATION_CORR} — 同一筆交易疊倉`,
    }
  }
  return { blocked: false, note: null }
}

/** Human-readable 24h reconciliation line distilled into the permanent
 *  lesson memory (≤200 chars — the lessons lib clamps, but keep it tight). */
export function verdictLessonText(v: {
  symbol: string
  direction: 'long' | 'short'
  confidence: number
  regime?: string | null
  earnings?: string | null
  status: string
  pnlPct: number | null
}): string {
  const dirZh = v.direction === 'long' ? '做多' : '做空'
  const statusZh = v.status === 'fired' ? '已下單' : v.status === 'dry-run' ? '試運行' : '被閘門拒絕'
  const ea = v.earnings === 'block' ? ' · 財報臨近' : v.earnings && v.earnings !== 'unknown' ? ` · 財報${v.earnings}天後` : ''
  const pnl = v.pnlPct != null && Number.isFinite(v.pnlPct) ? ` → 24h 標記 ${v.pnlPct > 0 ? '+' : ''}${v.pnlPct.toFixed(1)}%（${v.pnlPct > 0.5 ? '贏' : v.pnlPct < -0.5 ? '輸' : '平'}）` : ' → 24h 無法標記'
  return `自動交易覆盤：${dirZh} ${v.symbol} · 信心${v.confidence}${v.regime ? ` · regime ${v.regime}` : ''}${ea} · ${statusZh}${pnl}`
}

// ---------------------------------------------------------------------------
// v2.12.37 — REACT > RESPOND > REVIEW plan math (PURE, client-safe).
//
// The entry protocol: the model plans CONDITIONAL entries (trigger + TP/SL
// per side), the terminal validates the geometry (never trusts model
// arithmetic), a reactor watches the market, and ONLY a market that moves
// THROUGH the trigger follows the plan. These helpers are the shared math
// for the scan (plan validation) and the 24h review pass (was waiting right).
// ---------------------------------------------------------------------------

/** Trigger bands: a BUY plan must sit ABOVE the planning price (it confirms
 *  only when the market goes UP into it) and a SELL plan BELOW (confirms on
 *  a down-move) — otherwise it would "trigger" instantly and the whole
 *  wait-for-confirmation discipline would be theater. The outer bound stops
 *  the model planning chases >5% away from reality. */
export const PLAN_BAND = { up: 0.05, down: 0.05 } as const

/** v2.12.38 — mechanical-TP cap: a repaired target may not sit further than
 *  this % from the trigger. Beyond that the required risk distance is too
 *  wide for the band — the plan is refused instead of given a fantasy TP. */
export const PLAN_TP_CAP_PCT = 8

export interface PlanGeometry {
  ok: boolean
  rr: number | null
  reason: string | null
}

/** v2.12.38 — GEOMETRY REPAIR. A small planner often nails the direction and
 *  the structural stop but submits a TP far too close (measured in the wild:
 *  R:R 0.30 against a 1.88 floor). Rather than silently killing every
 *  well-aimed plan, the terminal — which never trusted model arithmetic in
 *  the first place — re-derives the target as the MECHANICAL R-multiple that
 *  exactly clears the floor, keeping the model's trigger and structural SL.
 *  Discipline lives in code, not in prompt compliance. Returns null when the
 *  required move exceeds the cap (risk too wide — refuse, don't fantasize). */
export function repairPlanTp(
  side: 'buy' | 'sell',
  trigger: number,
  sl: number,
  minRR: number,
): { tp: number; rr: number } | null {
  const risk = side === 'buy' ? trigger - sl : sl - trigger
  if (!(risk > 0) || !Number.isFinite(risk)) return null
  const move = minRR * risk
  if (move > trigger * (PLAN_TP_CAP_PCT / 100)) return null
  const tp = side === 'buy' ? trigger + move : trigger - move
  return { tp, rr: minRR }
}

/** Validate ONE conditional plan side against the planning price.
 *  R:R is computed HERE from trigger/tp/sl — the model's own ratio is never
 *  trusted. buy: sl < trigger < tp with refPrice < trigger ≤ ref×(1+up).
 *  sell: tp < trigger < sl with ref×(1−down) ≤ trigger < refPrice. */
export function validatePlanSide(
  side: 'buy' | 'sell',
  refPrice: number,
  trigger: number,
  tp: number,
  sl: number,
): PlanGeometry {
  const nums = [refPrice, trigger, tp, sl]
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) return { ok: false, rr: null, reason: '計劃數字無效' }
  if (side === 'buy') {
    if (!(sl < trigger && trigger < tp)) return { ok: false, rr: null, reason: 'buy 方位不合理（需 SL < 觸發 < TP）' }
    if (!(trigger > refPrice * 1.0005)) return { ok: false, rr: null, reason: 'buy 觸發價必須高於現價（等市場上攻確認）' }
    if (trigger > refPrice * (1 + PLAN_BAND.up)) return { ok: false, rr: null, reason: `buy 觸發價偏離現價 >${Math.round(PLAN_BAND.up * 100)}%` }
    const rr = (tp - trigger) / (trigger - sl)
    return { ok: true, rr: Number.isFinite(rr) && rr > 0 ? rr : null, reason: null }
  }
  if (!(tp < trigger && trigger < sl)) return { ok: false, rr: null, reason: 'sell 方位不合理（需 TP < 觸發 < SL）' }
  if (!(trigger < refPrice * 0.9995)) return { ok: false, rr: null, reason: 'sell 觸發價必須低於現價（等市場跌破確認）' }
  if (trigger < refPrice * (1 - PLAN_BAND.down)) return { ok: false, rr: null, reason: `sell 觸發價偏離現價 >${Math.round(PLAN_BAND.down * 100)}%` }
  const rr = (trigger - tp) / (sl - trigger)
  return { ok: true, rr: Number.isFinite(rr) && rr > 0 ? rr : null, reason: null }
}

export type PlanReviewOutcome = 'missed-run' | 'good-wait' | 'neutral'

/** 24h review verdict for a CLOSED (never executed) plan: did the discipline
 *  avoid a loss (good-wait — price went on to breach the stop) or cost the
 *  move (missed-run — price went on to cross the trigger)? pnlPct is the
 *  would-be P&L% at the current price relative to the trigger. */
export function planReviewOutcome(
  side: 'buy' | 'sell',
  trigger: number,
  sl: number,
  priceNow: number,
): { outcome: PlanReviewOutcome; pnlPct: number | null } {
  if (![trigger, sl, priceNow].every((n) => Number.isFinite(n) && n > 0)) return { outcome: 'neutral', pnlPct: null }
  const pnlPct = side === 'buy'
    ? ((priceNow - trigger) / trigger) * 100
    : ((trigger - priceNow) / trigger) * 100
  const crossed = side === 'buy' ? priceNow >= trigger : priceNow <= trigger
  const stopped = side === 'buy' ? priceNow <= sl : priceNow >= sl
  if (crossed) return { outcome: 'missed-run', pnlPct }
  if (stopped) return { outcome: 'good-wait', pnlPct }
  return { outcome: 'neutral', pnlPct }
}

/** Permanent-memory lesson line for a reviewed plan (≤200 chars). */
export function planLessonText(p: {
  symbol: string
  side: 'buy' | 'sell'
  trigger: number
  confidence: number
  status: string
  regime?: string | null
}, outcome: PlanReviewOutcome, pnlPct: number | null): string {
  const dirZh = p.side === 'buy' ? '做多' : '做空'
  const statusZh = p.status === 'INVALIDATED' ? '市場反向否定' : p.status === 'EXPIRED' ? '逾期作廢' : p.status === 'SUPERSEDED' ? '新計劃取代' : '閘門拒絕'
  const pnl = pnlPct != null && Number.isFinite(pnlPct) ? `${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '?'
  if (outcome === 'missed-run') {
    return `計劃覆盤：${dirZh} ${p.symbol}（觸發 ${p.trigger} · 信心${p.confidence}）${statusZh} → 24h 後價格已越過觸發價 ${pnl} — 等待錯過行情，此類計劃門檻可考慮放寬`
  }
  if (outcome === 'good-wait') {
    return `計劃覆盤：${dirZh} ${p.symbol}（觸發 ${p.trigger} · 信心${p.confidence}）${statusZh} → 24h 後價格已跌破停損區 ${pnl} — 等待正確，確認紀律避開了虧損`
  }
  return `計劃覆盤：${dirZh} ${p.symbol}（觸發 ${p.trigger}）${statusZh} → 24h 後仍在觸發與停損之間 — 情勢未明`
}
