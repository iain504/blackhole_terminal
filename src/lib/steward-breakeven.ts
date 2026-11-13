// v2.12.43 — 保本夾緊 (breakeven clamp) for the AI 護倉's SL amendments.
//
// Incident (TWST, paper, 13 Nov): short entry 108.99, floating +1.20%
// (cur ≈ 107.7) — the model proposed SL 109.50, which is ABOVE the entry.
// The geometry gates only ever checked the stop against the CURRENT price
// (109.50 > 107.7 ✓ legal), never against the ENTRY, so the 「鎖定保護」
// stop actually LOCKED IN a −0.47% LOSS. Price rebounded, SL filled at
// 109.48 → a profitable trade closed red (−$2.44 / −0.45%).
//
// ALAB (same session) shows the honest variant of the user's bid/ask
// hypothesis: SL 224.00 < entry 226.08 legitimately locked +0.92%; the
// buy-stop filled at the ask 224.09 → +0.88% — the spread shaved ~4bp off
// the locked profit. Normal stop-market mechanics, not a bug.
//
// RULE: a position IN PROFIT must never have its SL placed beyond
// breakeven — short SL ≤ entry×(1−buffer) · long SL ≥ entry×(1+buffer).
// The buffer covers spread/fees so the realized exit stays ≥ breakeven
// even after an ask/bid-side stop fill.
//
// Pure functions only (no imports) — used by the client-side steward store
// and probeable headless under bun.

/** 0.15% — spread/fee allowance; deliberately matches the steward's
 *  existing <0.15% churn-guard band so a clamped stop is never a no-op. */
export const BREAKEVEN_BUFFER = 0.0015

export interface BreakevenClamp {
  /** the price to actually send — always quantized to broker increments */
  price: number
  /** true when the model's candidate sat beyond breakeven and was adjusted */
  clamped: boolean
  /** true when the clamped level would fire immediately (≤ cur for a short /
   *  ≥ cur for a long — happens when floating profit < buffer): the caller
   *  should keep the old SL instead of triggering an instant exit */
  skip: boolean
  /** human remark for the event detail when clamped/skipped */
  note: string
}

/** Mirrors fmtPx (src/lib/trading.ts, server-only): stocks ≥$1 → 2dp,
 *  <$1 → 4dp; crypto ≥$1 → 6dp, <$1 → 8dp. Client-safe local copy so the
 *  steward never hands Alpaca a sub-penny clamp price (the v2.12.41 422
 *  family — a clamped 108.8266… must leave as 108.83). */
export function quantizeStopPrice(price: number, isCrypto: boolean): number {
  if (!Number.isFinite(price) || price <= 0) return price
  const dp = isCrypto ? (price >= 1 ? 6 : 8) : price >= 1 ? 2 : 4
  return Number(price.toFixed(dp))
}

/**
 * Clamp a model-proposed SL so a PROFITABLE position can never be handed a
 * stop that guarantees a loss. Returns null when the candidate is fine
 * (at a loss, invalid inputs, or already locks ≥ buffer profit).
 */
export function clampStopToBreakeven(
  side: 'long' | 'short',
  entry: number,
  cur: number,
  uplPct: number,
  candidate: number,
  isCrypto = false,
): BreakevenClamp | null {
  if (!(entry > 0) || !(cur > 0) || !(candidate > 0)) return null
  if (!(uplPct > 0)) return null // only profitable positions are guarded —
  // loss-cutting (short SL above entry / long SL below entry) stays legal
  const floor = side === 'short' ? entry * (1 - BREAKEVEN_BUFFER) : entry * (1 + BREAKEVEN_BUFFER)
  const beyond = side === 'short' ? candidate > floor : candidate < floor
  if (!beyond) return null // candidate already locks ≥ buffer profit — fine
  const base = `保本夾緊 — 浮盈 +${uplPct.toFixed(2)}% 時 SL 不得越過保本線（進場 ${entry}）`
  const price = quantizeStopPrice(floor, isCrypto)
  if (side === 'short' && price <= cur) {
    return { price, clamped: true, skip: true, note: `${base} — 夾緊後 ≤ 現價，保持原 SL` }
  }
  if (side === 'long' && price >= cur) {
    return { price, clamped: true, skip: true, note: `${base} — 夾緊後 ≥ 現價，保持原 SL` }
  }
  return { price, clamped: true, skip: false, note: base }
}

/** Fallback for the REATTACH path when the clamped level would fire
 *  immediately: the SL leg is MISSING (naked position — top-priority fix),
 *  so we attach a tight valid stop at cur±buffer instead. It exits near
 *  breakeven if hit — protection restored without re-creating the TWST
 *  loss, and without an instantly-triggering order Alpaca would reject. */
export function tightProtectiveStop(side: 'long' | 'short', cur: number, isCrypto = false): number {
  const px = side === 'short' ? cur * (1 + BREAKEVEN_BUFFER) : cur * (1 - BREAKEVEN_BUFFER)
  return quantizeStopPrice(px, isCrypto)
}
