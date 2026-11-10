// v2.12.29 — CORE trading disciplines for the AI 護倉 / AI Trade Adviser.
//
// The user's standing orders (紀律), to be respected by the model on EVERY
// review — unlike user-editable lessons these are code-level constants:
// they can never be deleted, trimmed, or forgotten:
//
//   1. Extended trading hours (pre/post market) — Alpaca does NOT accept
//      market orders: a market order submitted at 18:00 ET is silently
//      QUEUED until the next regular session opens. Extended-hours trading
//      is limit-orders-only. The terminal now ENFORCES this server-side
//      (orders/positions routes auto-convert market → marketable limit).
//
//   2. TP/SL protective exits can VANISH — after a 護倉 amend (cancel-replace
//      failure leaves the position naked) or a session transition (regular →
//      pre/post kills DAY-tif legs at the close). A position without its SL
//      carries full-liquidation risk (全倉清盤). The steward audits every
//      open position EVERY cycle and re-attaches missing protection.
//
// This module is PURE (no server imports) — both the API routes and the
// client panel import from it.

/** The never-forget rules, verbatim into every steward review prompt. */
export const CORE_DISCIPLINES: readonly string[] = [
  '延長交易時段（Pre-market 04:00-09:30 ET / Post-market 16:00-20:00 ET）Alpaca 不接受市價單 — 市價單會被靜默擱置到下次 regular session 開市才提交。延長時段內一切進出場必須用限價單（終端會自動把市價單轉為限價）。',
  'TP/SL 保護單可能在護倉修改後、或由 regular 轉入 pre/post 時段後消失。每輪必須核對每個持倉的 SL/TP 是否仍存在（顯示「無」＝缺失）。SL 缺失＝全倉清盤風險，必須立即提出 reattach 重新掛上保護，不可忽略。',
]

/** Marketable-limit band for a market ENTRY converted during extended
 *  hours: the limit sits this far through the reference quote so it fills
 *  immediately in the thin pre/post book (buy: ask up to +1%, sell: down
 *  to −1%). */
export const EXTENDED_ENTRY_BAND_PCT = 1.0

/** Same for a market CLOSE (steward emergency exit / manual 平倉): a wider
 *  band — a protective close MUST fill, slippage is the lesser evil vs a
 *  queued close that leaves the position naked until the next session. */
export const EXTENDED_CLOSE_BAND_PCT = 1.5

/** Marketable limit price for `side` off a reference quote:
 *  buy → ref × (1 + band), sell → ref × (1 − band). */
export function extendedLimitPrice(side: 'buy' | 'sell', refPrice: number, bandPct: number): number {
  const b = Math.max(0, bandPct) / 100
  const px = side === 'buy' ? refPrice * (1 + b) : refPrice * (1 - b)
  return px > 0 ? px : refPrice
}

/** Alpaca price formatting for a limit price (stocks: 2 decimals above $1,
 *  sub-dollar names need more precision). */
export function fmtLimitPx(px: number): string {
  return px >= 1 ? px.toFixed(2) : px.toFixed(4)
}
