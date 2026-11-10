// Trade-history REASON resolution (v2.12.28) — answers "why did this trade
// close / why was this order cancelled" for the Positions tab Trade history.
//
// The broker tape alone can't fully explain closes: Alpaca orders carry no
// cancel reason, and a broker-side market close (DELETE /v2/positions/{sym},
// used by BOTH the manual Close button and the AI steward) looks identical.
// So the resolver combines three sources:
//   1. the EXIT ORDER itself — group_role ('take_profit'/'stop_loss'),
//      type ('trailing_stop'), and the client_order_id grammar ('tte-…-tp'
//      crypto legs, 'ttg-' grid, 'ttr-' algo) → planned exits label
//      themselves (TP 命中 / SL 命中 / Grid 引擎平倉 …).
//   2. the AI steward's event log (AiStewardEvent, kind position/order,
//      status executed) — a close/cancel event on the same symbol within a
//      ±15 min window of the broker action means the STEWARD did it, and its
//      verdict sentence becomes the human-readable detail. Steward TP/SL
//      amends between entry and exit enrich a TP/SL hit with 「AI 調整後」.
//   3. the order's client_order_id grammar for cancels — engine-placed
//      orders (ttg-/ttr-) that vanish without a steward event were killed by
//      their own engine's lifecycle (stop/refresh); everything else is a
//      manual cancel (the UI cancel button is the only remaining path).
import type { ClosedTrade, TradeReason } from '@/lib/market-types'
import { parseCryptoPlan, type TradingOrder } from '@/lib/trading'
import { db } from '@/lib/db'

/** The steward's executed actions we care about, newest first. */
export interface StewardAction {
  kind: string // 'position' | 'order'
  action: string // 'close' | 'cancel' | 'amend_tp' | 'amend_sl'
  symbol: string | null
  detail: string
  at: number // epoch ms
}

/** ±window around a broker action in which a matching steward event counts. */
const MATCH_WINDOW_MS = 15 * 60 * 1000

const cap = (s: string, n = 120): string => {
  const t = s.trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** Load the steward's recent executed close/cancel/amend events for reason
 * matching. Degrades to [] on any DB hiccup — reasons are enrichment, never
 * a reason for the history to fail. */
export async function loadStewardActions(userId: string, sinceDays = 7): Promise<StewardAction[]> {
  try {
    const since = new Date(Date.now() - sinceDays * 86_400_000)
    const rows = await db.aiStewardEvent.findMany({
      where: {
        userId,
        status: 'executed',
        action: { in: ['close', 'cancel', 'amend_tp', 'amend_sl'] },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { kind: true, action: true, symbol: true, detail: true, createdAt: true },
    })
    return rows.map((r) => ({
      kind: r.kind,
      action: r.action,
      symbol: r.symbol,
      detail: r.detail,
      at: r.createdAt.getTime(),
    }))
  } catch {
    return []
  }
}

/** The steward event matching this symbol+action nearest in time (within the
 * window), or null. */
function nearestEvent(
  events: StewardAction[],
  action: string,
  symbol: string,
  atMs: number,
): StewardAction | null {
  const norm = symbol.replace('/', '').toUpperCase()
  let best: StewardAction | null = null
  let bestDelta = Infinity
  for (const e of events) {
    if (e.action !== action) continue
    if (!e.symbol || e.symbol.replace('/', '').toUpperCase() !== norm) continue
    const delta = Math.abs(e.at - atMs)
    if (delta <= MATCH_WINDOW_MS && delta < bestDelta) {
      best = e
      bestDelta = delta
    }
  }
  return best
}

/** The steward's TP/SL amend on this symbol BETWEEN entry and exit (the
 * 「AI 調整後」 enrichment), or null. */
function stewardAmendBetween(
  events: StewardAction[],
  action: 'amend_tp' | 'amend_sl',
  symbol: string,
  entryMs: number,
  exitMs: number,
): StewardAction | null {
  const norm = symbol.replace('/', '').toUpperCase()
  let best: StewardAction | null = null
  for (const e of events) {
    if (e.action !== action) continue
    if (!e.symbol || e.symbol.replace('/', '').toUpperCase() !== norm) continue
    if (e.at < entryMs - MATCH_WINDOW_MS || e.at > exitMs) continue
    if (!best || e.at > best.at) best = e
  }
  return best
}

/** Resolve the close reason of one FIFO round-trip from its exit order
 * (+ the steward log). Always returns a reason — worst case 手動平倉. */
export function resolveTradeReason(
  t: ClosedTrade,
  exitOrder: TradingOrder | undefined,
  steward: StewardAction[] = [],
): TradeReason {
  const exitMs = new Date(t.exitAt).getTime()
  const entryMs = new Date(t.entryAt).getTime()

  // 1. planned exits — bracket/OCO legs and crypto tte- legs label themselves
  const role = exitOrder?.group_role ?? null
  const coid = exitOrder?.client_order_id ?? ''
  const plan = parseCryptoPlan(coid)
  const isTteTp = /^tte-[a-z0-9]+-tp/.test(coid)
  const isTteSl = /^tte-[a-z0-9]+-sl/.test(coid)
  if (role === 'take_profit' || isTteTp) {
    const amend = stewardAmendBetween(steward, 'amend_tp', t.symbol, entryMs, exitMs)
    return amend
      ? { code: 'tp_ai', label: 'TP 命中（AI 調整後）', detail: cap(`AI 護倉曾調整 TP — ${amend.detail}`) }
      : { code: 'tp', label: 'TP 命中' }
  }
  if (role === 'stop_loss' || isTteSl) {
    const amend = stewardAmendBetween(steward, 'amend_sl', t.symbol, entryMs, exitMs)
    return amend
      ? { code: 'sl_ai', label: 'SL 命中（AI 調整後）', detail: cap(`AI 護倉曾調整 SL — ${amend.detail}`) }
      : { code: 'sl', label: 'SL 命中' }
  }
  if (exitOrder?.type === 'trailing_stop') return { code: 'trail', label: '移動止損' }

  // engine-grammar exits (grid/algo close with their own market/limit orders)
  if (plan?.gridRef) return { code: 'grid_exit', label: 'Grid 引擎平倉' }
  if (plan?.runRef) return { code: 'algo_exit', label: 'Algo 策略平倉' }

  // 2. broker-side market close — manual Close vs AI steward (event match)
  const closeEvt = nearestEvent(steward, 'close', t.symbol, exitMs)
  if (closeEvt) return { code: 'ai_close', label: 'AI 護倉平倉', detail: cap(closeEvt.detail) }

  // 3. fallback
  return { code: 'manual_close', label: '手動平倉' }
}

/** Resolve the reason of one zero-fill canceled/expired order. */
export function resolveCancelReason(o: TradingOrder, steward: StewardAction[] = []): TradeReason {
  const atMs = new Date(o.updated_at || o.created_at || '').getTime() || Date.now()
  if (o.status === 'expired') return { code: 'expired', label: '已過期（未成交）' }
  const cancelEvt = nearestEvent(steward, 'cancel', o.symbol, atMs)
  if (cancelEvt) return { code: 'ai_cancel', label: 'AI 護倉取消', detail: cap(cancelEvt.detail) }
  const plan = parseCryptoPlan(o.client_order_id)
  if (plan?.gridRef) return { code: 'grid_cancel', label: 'Grid 引擎取消' }
  if (plan?.runRef) return { code: 'algo_cancel', label: 'Algo 引擎取消' }
  if (plan?.aiRef) return { code: 'ai_cancel', label: 'AI 顧問取消' }
  return { code: 'manual_cancel', label: '手動取消' }
}
