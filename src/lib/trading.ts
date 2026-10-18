// Alpaca Trading API client (server-side only): paper + live order routing,
// positions, bracket/OCO exits, order replacement for SL/TP drag updates.
//
// Verified against the paper API (2026-10):
// - Stocks support order_class=bracket (entry + take_profit/stop_loss legs).
// - Crypto rejects ALL advanced order classes AND plain `stop` type; exits use
//   stop_limit/limit orders and the balance is reserved per open sell order,
//   so dual exits split the qty 50/50.
// - PATCH /v2/orders/{id} creates a REPLACEMENT order with a NEW id.
// - Position symbols drop the crypto slash (BTC/USD -> BTCUSD).
import { db } from './db'
import { getAlpacaKeys } from './alpaca'

export type TradeMode = 'paper' | 'live'

const TRADE_BASE: Record<TradeMode, string> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
}

interface UserSettings {
  alpacaKeyIdEnc?: string
  alpacaSecretEnc?: string
  telegramTokenEnc?: string
  telegramChatId?: string
  tradeMode?: TradeMode
}

export function isTradeMode(v: unknown): v is TradeMode {
  return v === 'paper' || v === 'live'
}

/** Requested mode wins; else the user's stored preference; else paper. */
export async function resolveTradeMode(userId: string | undefined, requested?: unknown): Promise<TradeMode> {
  if (isTradeMode(requested)) return requested
  if (userId) {
    const user = await db.user.findUnique({ where: { id: userId } })
    const s = (user?.settings as UserSettings | null) || null
    if (isTradeMode(s?.tradeMode)) return s.tradeMode
  }
  return 'paper'
}

/** Normalize symbols for the trading API: BTC/USD -> BTCUSD. */
export function tradeSymbol(symbol: string): string {
  return symbol.replace('/', '')
}

interface TradeFetchResult<T> {
  data: T | null
  status: number
  error?: string
}

async function tradeFetch<T>(
  userId: string,
  mode: TradeMode,
  path: string,
  init: RequestInit = {},
): Promise<TradeFetchResult<T>> {
  const keys = await getAlpacaKeys(userId)
  if (!keys) return { data: null, status: 0, error: 'no-keys' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch(`${TRADE_BASE[mode]}${path}`, {
      ...init,
      headers: {
        'APCA-API-KEY-ID': keys.keyId,
        'APCA-API-SECRET-KEY': keys.secret,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: controller.signal,
      cache: 'no-store',
    })
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (!res.ok) {
      const msg =
        (parsed as { message?: string } | null)?.message ||
        `Trading API HTTP ${res.status}`
      console.error(`Trading ${mode} ${path} -> ${res.status}: ${msg}`)
      return { data: parsed as T, status: res.status, error: msg }
    }
    return { data: parsed as T, status: res.status }
  } catch (e) {
    console.error(`Trading ${mode} ${path} failed:`, e instanceof Error ? e.message : e)
    return { data: null, status: 0, error: e instanceof Error ? e.message : 'network error' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------- shapes ----------

export interface TradingAccount {
  status: string
  equity: string
  cash: string
  buying_power: string
  currency: string
}

export interface TradingPosition {
  symbol: string // trading symbol (BTCUSD for crypto)
  qty: string
  qty_available: string
  side: string
  avg_entry_price: string
  current_price: string
  unrealized_pl: string
  unrealized_plpc: string
  asset_class: string
}

export interface TradingOrder {
  id: string
  symbol: string
  qty: string
  filled_qty: string
  filled_avg_price: string | null
  side: string
  type: string
  status: string
  stop_price: string | null
  limit_price: string | null
  trail_percent: string | null
  trail_price: string | null
  filled_at: string | null
  created_at: string | null
  replaces: string | null
  legs: TradingOrder[] | null
  client_order_id?: string
}

// ---------- API wrappers ----------

export async function getAccount(userId: string, mode: TradeMode) {
  return tradeFetch<TradingAccount>(userId, mode, '/v2/account')
}

export async function getPositions(userId: string, mode: TradeMode) {
  return tradeFetch<TradingPosition[]>(userId, mode, '/v2/positions')
}

export async function getOpenOrders(userId: string, mode: TradeMode, symbol?: string) {
  const q = symbol ? `&symbols=${encodeURIComponent(symbol)}` : ''
  return tradeFetch<TradingOrder[]>(userId, mode, `/v2/orders?status=open&limit=100${q}`)
}

export async function getClosedOrders(userId: string, mode: TradeMode, limit = 30) {
  return tradeFetch<TradingOrder[]>(
    userId,
    mode,
    `/v2/orders?status=closed&limit=${limit}&direction=desc`,
  )
}

export interface PlaceOrderBody {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  type?: 'market' | 'limit'
  limit_price?: number
  time_in_force?: 'gtc' | 'day' | 'ioc'
  take_profit?: number
  stop_loss?: number
  trail_percent?: number
  client_order_id?: string
}

/**
 * Place an entry order with optional exits.
 * Stocks: single bracket request when TP/SL present (Alpaca attaches legs).
 * Crypto: advanced classes are rejected — entry is placed alone, exits are
 * separate stop_limit/limit orders; with both exits qty is split 50/50.
 */
export async function placeOrderWithExits(
  userId: string,
  mode: TradeMode,
  body: PlaceOrderBody,
): Promise<{ results: TradingOrder[]; errors: string[]; splitNote?: string }> {
  const isCrypto = body.symbol.includes('/')
  const type = body.type || 'market'
  const tif = body.time_in_force || (isCrypto ? 'gtc' : type === 'market' ? 'day' : 'gtc')
  const entry: Record<string, unknown> = {
    symbol: tradeSymbol(body.symbol),
    qty: String(body.qty),
    side: body.side,
    type,
    time_in_force: tif,
  }
  if (type === 'limit') {
    if (!body.limit_price) return { results: [], errors: ['Limit price required for limit orders'] }
    entry.limit_price = String(body.limit_price)
  }
  if (body.client_order_id) entry.client_order_id = body.client_order_id

  const errors: string[] = []
  const results: TradingOrder[] = []

  if (!isCrypto) {
    // Stocks: bracket handles entry + legs atomically.
    const hasTp = typeof body.take_profit === 'number' && body.take_profit > 0
    const hasSl = typeof body.stop_loss === 'number' && body.stop_loss > 0
    if (hasTp || hasSl) {
      entry.order_class = 'bracket'
      if (hasTp) entry.take_profit = { limit_price: body.take_profit!.toFixed(2) }
      if (hasSl) entry.stop_loss = { stop_price: body.stop_loss!.toFixed(2) }
    }
    const r = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify(entry),
    })
    if (r.data && (r.data as TradingOrder).id) results.push(r.data)
    else errors.push(r.error || 'Entry order failed')
    return { results, errors }
  }

  // Crypto: entry alone (no advanced classes).
  const r = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(entry),
  })
  if (r.data && (r.data as TradingOrder).id) results.push(r.data)
  else {
    errors.push(r.error || 'Entry order failed')
    return { results, errors }
  }

  // Exits: separate orders; qty split when both requested (balance reserved
  // per open sell order — full qty twice is rejected by Alpaca). Crypto buys
  // receive qty minus a trading fee, so exits apply a 0.99 safety factor to
  // avoid 403 "insufficient balance" on the second exit.
  const hasTp = typeof body.take_profit === 'number' && body.take_profit > 0
  const hasSl = typeof body.stop_loss === 'number' && body.stop_loss > 0
  if (!hasTp && !hasSl) return { results, errors }

  const halfRaw = hasTp && hasSl ? body.qty / 2 : body.qty
  const exitQty = (halfRaw * 0.99).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  const exitSide = body.side === 'buy' ? 'sell' : 'buy'
  if (hasTp) {
    const tp = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: tradeSymbol(body.symbol),
        qty: exitQty,
        side: exitSide,
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: body.take_profit!.toFixed(body.take_profit! < 1 ? 6 : 2),
      }),
    })
    if (tp.data && (tp.data as TradingOrder).id) results.push(tp.data)
    else errors.push(`TP: ${tp.error || 'failed'}`)
  }
  if (hasSl) {
    const stopP = body.stop_loss!
    // stop-limit sell: limit slightly below the stop so it clears the book
    const limP = exitSide === 'sell' ? stopP * 0.999 : stopP * 1.001
    const sl = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: tradeSymbol(body.symbol),
        qty: exitQty,
        side: exitSide,
        type: 'stop_limit',
        time_in_force: 'gtc',
        stop_price: stopP.toFixed(stopP < 1 ? 6 : 2),
        limit_price: limP.toFixed(limP < 1 ? 6 : 2),
      }),
    })
    if (sl.data && (sl.data as TradingOrder).id) results.push(sl.data)
    else errors.push(`SL: ${sl.error || 'failed'}`)
  }
  return {
    results,
    errors,
    splitNote: hasTp && hasSl ? 'Crypto exits split 50/50 (Alpaca crypto has no bracket orders)' : undefined,
  }
}

/** Trailing-stop entry/exit (stocks only; crypto rejects trailing_stop). */
export async function placeTrailingStop(
  userId: string,
  mode: TradeMode,
  body: { symbol: string; side: 'buy' | 'sell'; qty: number; trail_percent: number },
) {
  return tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: tradeSymbol(body.symbol),
      qty: String(body.qty),
      side: body.side,
      type: 'trailing_stop',
      time_in_force: 'gtc',
      trail_percent: body.trail_percent.toFixed(2),
    }),
  })
}

/** Replace SL/TP prices on an open order. NOTE: Alpaca returns a replacement
 * order with a NEW id — callers must refresh their order ids. */
export async function replaceOrder(
  userId: string,
  mode: TradeMode,
  orderId: string,
  patch: { stop_price?: number; limit_price?: number; trail_percent?: number },
) {
  const body: Record<string, unknown> = {}
  if (patch.stop_price != null) body.stop_price = String(patch.stop_price)
  if (patch.limit_price != null) body.limit_price = String(patch.limit_price)
  if (patch.trail_percent != null) body.trail_percent = String(patch.trail_percent)
  return tradeFetch<TradingOrder>(userId, mode, `/v2/orders/${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function cancelOrder(userId: string, mode: TradeMode, orderId: string) {
  return tradeFetch<null>(userId, mode, `/v2/orders/${orderId}`, { method: 'DELETE' })
}

export async function closePosition(userId: string, mode: TradeMode, symbol: string) {
  return tradeFetch<TradingOrder>(userId, mode, `/v2/positions/${encodeURIComponent(tradeSymbol(symbol))}`, {
    method: 'DELETE',
  })
}
