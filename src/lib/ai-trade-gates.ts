// v2.12.33 — AI auto-trade decision-gate math (PURE, client-safe).
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
