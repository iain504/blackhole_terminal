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
//   3. v2.12.39 — the user's standing moral: "Plan your trade, trade your
//      plan." Every entry/exit starts as a PLAN (trigger/entry, TP, SL,
//      size) and the market — not improvisation — decides which plan runs:
//      price through the plan → follow it; price against the plan → the
//      plan's stop stands. No plan, no order. This is the React > Respond >
//      Review entry protocol stated as the trader's oath.
//
// v2.12.47 — the ALPACA EXTENDED-HOURS DOCTRINE (user standing order). Alpaca
// does not support native SL/TP bracket legs during pre/post market — only
// DAY limit orders with extended_hours=true are accepted, so the system can
// never rely on broker-side triggers overnight. The doctrine decouples the
// layers: a DETERMINISTIC state machine (this terminal's engine) handles the
// mechanical risk management, while the AI model acts as a contextual risk
// assessor at checkpoints:
//
//   4. Synthetic OCO — during extended sessions the SL is a LOCAL synthetic
//      stop (the engine compares the live quote with the SL line every cycle
//      and fires a capped aggressive limit exit on a cross) and the TP is a
//      resting extended-hours limit order. Never wait for a broker trigger
//      that cannot exist.
//   5. The AI is never the price trigger (API latency + token generation are
//      too slow for thin extended-books) — it decides at checkpoints:
//      pre-close hold-vs-flatten, buffer widening on wide spreads,
//      fakeout-vs-catalyst, pre-market re-arm.
//   6. API constraints: every extended-hours order must carry type=limit +
//      time_in_force=day + extended_hours=true (gtc/market → 422); whole
//      shares only (fractional waits for the regular session); every
//      aggressive exit limit carries a slippage cap (sell ≤ bid×0.985 /
//      buy ≥ ask×1.015 — the ±1.5% close band) so a liquidity vacuum cannot
//      fill it at a terrible price.
//
// This module is PURE (no server imports) — both the API routes and the
// client panel import from it.

/** The never-forget rules, verbatim into every steward review prompt. */
export const CORE_DISCIPLINES: readonly string[] = [
  '延長交易時段（Pre-market 04:00-09:30 ET / Post-market 16:00-20:00 ET）Alpaca 不接受市價單 — 市價單會被靜默擱置到下次 regular session 開市才提交。延長時段內一切進出場必須用限價單（終端會自動把市價單轉為限價）。',
  'TP/SL 保護單可能在護倉修改後、或由 regular 轉入 pre/post 時段後消失。每輪必須核對每個持倉的 SL/TP 是否仍存在（顯示「無」＝缺失）。SL 缺失＝全倉清盤風險，必須立即提出 reattach 重新掛上保護，不可忽略。',
  'Plan your trade, trade your plan（計劃你的交易，交易你的計劃）：任何進出場必須先有完整計劃（進場/觸發價、TP、SL、倉位），再按計劃執行 — 市場順計劃方向走就跟進（trade the plan），市場反向則按計劃停損離場，嚴禁無計劃下單、嚴禁臨場即興改變已定的進出場依據。',
  '延長時段（Pre/Post-market）Alpaca 沒有原生 SL/TP 觸發 — stop/bracket 腿盤外不執行，僅接受 DAY 限價單（extended_hours=true）。此時停損＝本地合成 SL：每輪以即時報價比對 SL 線，穿越即以帶上限的進取限價立即離場；TP＝改掛延時限價單。絕不指望券商盤外自動觸發。',
  'AI 不是價格觸發器（延時段簿薄、API 延遲慢 — 停損由本地機制即時執行）；AI 只在檢查點做情境評估：收盤前（~15:45 ET）依浮盈、波動、盤後財報/新聞判斷 Hold vs Flatten；價差異常寬時建議 widen 放寬合成緩衝（1%→2.5%）避免被單筆低量成交假穿針打掉；突發消息分輕量假突破（hold）與真實催化（立即離場）；盤前（~09:25 ET）清理殘存延時限價、重掛常規保護。',
  '延時段下單參數：必須 type=limit + time_in_force=day + extended_hours=true（gtc 或市價單會被 422 拒絕）；不支援碎股 — 只有整數股部分可下單，碎股等下次常規時段；進取限價必須設滑價上限（賣出 ≤ 現價×0.985、買入 ≥ 現價×1.015）— 低流動性真空裡未設上限的單可能以極差價成交。',
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

/** v2.12.47 — synthetic-SL cross test (DETERMINISTIC risk layer): during
 *  extended hours the native stop leg cannot trigger, so the ENGINE compares
 *  the live quote with the SL line itself every cycle — never the model
 *  (API latency and token generation are too slow for thin extended-books).
 *  long: exit when price falls to/below the stop; short: mirrored. */
export function isSlCrossed(side: 'long' | 'short', slPrice: number, refPrice: number): boolean {
  if (!(slPrice > 0) || !(refPrice > 0)) return false
  return side === 'long' ? refPrice <= slPrice : refPrice >= slPrice
}

/** Estimated trigger line for a trailing stop that carries only
 *  trailPercent (the broker does not expose its computed stop): long trails
 *  BELOW the price, short trails ABOVE. Synthetic-SL monitoring uses this
 *  when the exit leg carries no absolute price. */
export function estimateTrailStop(side: 'long' | 'short', current: number, trailPercent: number): number {
  const t = Math.max(0, trailPercent) / 100
  return side === 'long' ? current * (1 - t) : current * (1 + t)
}

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
