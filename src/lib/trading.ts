// Alpaca Trading API client (server-side only): paper + live order routing,
// positions, bracket/OCO exits, order replacement for SL/TP drag updates.
//
// Verified against the paper API (2026-10):
// - Stocks support order_class=bracket (entry + take_profit/stop_loss legs).
// - Crypto rejects ALL advanced order classes (order_class=oco -> 40010001
//   "invalid order type for crypto order"; bracket -> 42210000) AND plain
//   `stop` type. Sell exits also CANNOT be reserved against a PENDING buy
//   (40310000 "insufficient balance" — only settled position qty counts),
//   so crypto complex orders are EMULATED: the entry carries its intended
//   TP/SL in the client_order_id (`ttb-…`) and the OCO supervisor below
//   attaches the exit legs (`tte-…`) the moment the entry FILLS, canceling
//   any surviving leg once the position is gone.
// - PATCH /v2/orders/{id} creates a REPLACEMENT order with a NEW id.
// - Position symbols drop the crypto slash (BTC/USD -> BTCUSD); ORDER
//   symbols keep it (BTC/USD).
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

/**
 * Alpaca rejects prices with more than 9 decimal places ("limit price exceeds
 * maximum precision of 9 decimal places") on CRYPTO, and sub-penny increments
 * on STOCKS ("sub-penny increment does not fulfill minimum pricing criteria").
 * Chart drag prices are raw JS floats (65800.22400000001) that blow past both —
 * first the direct PATCH fails, then the cancel+re-place fallback fails too,
 * LEAVING THE EXIT ORDER CANCELED AND LOST. Round every outgoing price string:
 * crypto 6dp (>=1) / 8dp (<1), stocks penny 2dp (>=1) / 4dp (<1).
 */
export function fmtPx(v: number, crypto = false): string {
  if (!Number.isFinite(v) || v <= 0) return String(v)
  const dp = crypto ? (v >= 1 ? 6 : 8) : v >= 1 ? 2 : 4
  return String(parseFloat(v.toFixed(dp)))
}

export interface TradingAccount {
  status: string
  equity: string
  cash: string
  buying_power: string
  currency: string
  // extended fields (present on current Alpaca accounts) — the Positions-tab
  // account panel / details dialog read these
  account_number?: string
  portfolio_value?: string
  last_equity?: string
  regt_buying_power?: string
  daytrading_buying_power?: string
  non_marginable_buying_power?: string
  daytrade_count?: number
  initial_margin?: string
  maintenance_margin?: string
  multiplier?: string
  shorting_enabled?: boolean
  trading_blocked?: boolean
  transfers_blocked?: boolean
  account_blocked?: boolean
  pattern_day_trader?: boolean
  sma?: string
  created_at?: string
}

/** Raw GET /v2/account/portfolio/history response (nulls mark empty slots). */
export interface PortfolioHistoryRaw {
  timestamp: number[] // unix seconds
  equity: (number | null)[]
  profit_loss: (number | null)[]
  profit_loss_pct: (number | null)[]
  base_value: number | null
  timeframe: string
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
  time_in_force?: string
  stop_price: string | null
  limit_price: string | null
  trail_percent: string | null
  trail_price: string | null
  filled_at: string | null
  created_at: string | null
  replaces: string | null
  replaced_by?: string | null
  legs: TradingOrder[] | null
  client_order_id?: string
  asset_class?: string
}

// ---------- API wrappers ----------

export async function getAccount(userId: string, mode: TradeMode) {
  return tradeFetch<TradingAccount>(userId, mode, '/v2/account')
}

/** Equity curve for the Positions tab (Hour/Day/Week/Month/Year ranges). */
export async function getPortfolioHistory(userId: string, mode: TradeMode, period: string, timeframe: string) {
  return tradeFetch<PortfolioHistoryRaw>(
    userId,
    mode,
    `/v2/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=true`,
  )
}

export async function getPositions(userId: string, mode: TradeMode) {
  return tradeFetch<TradingPosition[]>(userId, mode, '/v2/positions')
}

export async function getOpenOrders(userId: string, mode: TradeMode, symbol?: string) {
  const q = symbol ? `&symbols=${encodeURIComponent(symbol)}` : ''
  // Alpaca hides bracket legs from the DEFAULT (nested=false) list: an open
  // bracket parent comes back with legs=null, so pending-entry TP/SL (and any
  // exit mapped from legs) is invisible to callers. The nested=true variant
  // nests the legs under the parent — but a FILLED parent's ACTIVE legs only
  // show in the flat list. Fetch BOTH and merge by id (nested wins when it
  // carries legs) so both shapes are always covered.
  const [flat, nested] = await Promise.all([
    tradeFetch<TradingOrder[]>(userId, mode, `/v2/orders?status=open&limit=100${q}`),
    tradeFetch<TradingOrder[]>(userId, mode, `/v2/orders?status=open&limit=100&nested=true${q}`),
  ])
  const flatRows: TradingOrder[] = Array.isArray(flat.data) ? flat.data : []
  const nestedRows: TradingOrder[] = Array.isArray(nested.data) ? nested.data : []
  if (nestedRows.length === 0) return flat
  const byId = new Map<string, TradingOrder>()
  for (const o of flatRows) byId.set(o.id, o)
  for (const o of nestedRows) {
    const prev = byId.get(o.id)
    byId.set(o.id, !prev || (o.legs?.length ?? 0) > 0 ? o : prev)
  }
  return { ...flat, data: [...byId.values()] }
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
 * Crypto: advanced classes are rejected — the entry is placed ALONE carrying
 * the intended TP/SL in its client_order_id (`ttb-…`); the OCO supervisor
 * (ensureCryptoOcoSupervisor) attaches the exit legs when the entry fills.
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
      // encode the plan for the chart's pending display: Alpaca materializes
      // bracket LEGS only when the entry activates, so a queued (weekend /
      // pre-market) bracket would otherwise render without its TP/SL lines
      entry.client_order_id = encodePlanClientId(mode, hasTp ? body.take_profit! : null, hasSl ? body.stop_loss! : null)
    }
    const r = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify(entry),
    })
    if (r.data && (r.data as TradingOrder).id) results.push(r.data)
    else errors.push(r.error || 'Entry order failed')
    return { results, errors }
  }

  // ---- Crypto: complex orders are EMULATED (no native bracket/OCO) ----
  const hasTp = typeof body.take_profit === 'number' && body.take_profit > 0
  const hasSl = typeof body.stop_loss === 'number' && body.stop_loss > 0
  if (hasTp || hasSl) {
    // encode the planned exits so the chart can render them while the entry
    // is pending AND the supervisor can attach the legs without extra state
    entry.client_order_id = encodePlanClientId(mode, hasTp ? body.take_profit! : null, hasSl ? body.stop_loss! : null)
  }
  const r = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(entry),
  })
  if (r.data && (r.data as TradingOrder).id) results.push(r.data)
  else {
    errors.push(r.error || 'Entry order failed')
    return { results, errors }
  }
  if (!hasTp && !hasSl) return { results, errors }

  // Fast path: a MARKET entry usually fills instantly — poll briefly and
  // attach the exits in-line so protection starts immediately. Limit entries
  // return right away (the supervisor attaches on fill within ~6s).
  if (type === 'market') {
    let cur: TradingOrder | null = r.data
    for (let i = 0; i < 4 && cur && cur.status !== 'filled'; i++) {
      await new Promise((res) => setTimeout(res, 600))
      const s = await tradeFetch<TradingOrder>(userId, mode, `/v2/orders/${(r.data as TradingOrder).id}`)
      cur = s.data ?? cur
      if (cur && ['canceled', 'cancelled', 'rejected', 'expired'].includes(cur.status)) break
    }
    if (cur?.status === 'filled') {
      const legErrs = await placeCryptoExitLegs(
        userId,
        mode,
        cur,
        hasTp ? body.take_profit : undefined,
        hasSl ? body.stop_loss : undefined,
      )
      errors.push(...legErrs)
      return { results, errors }
    }
  }
  return {
    results,
    errors,
    splitNote: 'TP/SL attach automatically when the entry fills (OCO-managed)',
  }
}

// ---------- crypto complex-order emulation (OCO supervisor) ----------

/** Price -> client_order_id-safe digits (6dp fixed point). */
function encP(v: number): string {
  return String(Math.round(v * 1e6))
}

/** client_order_id prefix identifying a MANAGED crypto exit leg. */
function exitLegClientId(entryOrderId: string, kind: 'tp' | 'sl'): string {
  return `tte-${entryOrderId}-${kind}`
}

/** Encode the OCO/bracket plan (mode + TP/SL prices) into the entry's client_order_id. */
function encodePlanClientId(mode: TradeMode, tp: number | null, sl: number | null): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `ttb-${mode[0]}-tp${tp != null && tp > 0 ? encP(tp) : '0'}-sl${sl != null && sl > 0 ? encP(sl) : '0'}-${rand}`
}

/** Decode the plan from a `ttb-…` client_order_id. Returns null when not ours. */
function parseCryptoPlan(clientOrderId: string | undefined | null): { tp: number | null; sl: number | null } | null {
  const m = /^ttb-[a-z](?:-tp(\d+))?(?:-sl(\d+))?-/.exec(clientOrderId || '')
  if (!m) return null
  const dec = (s: string | undefined) => (s ? parseInt(s, 10) / 1e6 : 0)
  const tp = dec(m[1])
  const sl = dec(m[2])
  return { tp: tp > 0 ? tp : null, sl: sl > 0 ? sl : null }
}

/**
 * Place the exit legs for a FILLED crypto entry (50/50 qty split when both
 * legs are requested — Alpaca reserves balance per open sell order). Leg ids
 * are deterministic (`tte-<entryId>-tp|-sl`) so the supervisor is idempotent.
 * Crypto buys receive qty minus a trading fee, so legs apply a 0.99 safety
 * factor to avoid 403 "insufficient balance".
 */
async function placeCryptoExitLegs(
  userId: string,
  mode: TradeMode,
  entry: TradingOrder,
  tp?: number,
  sl?: number,
): Promise<string[]> {
  const errors: string[] = []
  const filledQty = parseFloat(entry.filled_qty) || parseFloat(entry.qty) || 0
  if (!(filledQty > 0)) return ['entry has no filled qty']
  const exitSide = entry.side === 'buy' ? 'sell' : 'buy'
  const both = tp != null && sl != null
  const legQty = ((both ? filledQty / 2 : filledQty) * 0.99).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  if (tp != null) {
    const r = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: entry.symbol,
        qty: legQty,
        side: exitSide,
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: tp.toFixed(tp < 1 ? 6 : 2),
        client_order_id: exitLegClientId(entry.id, 'tp'),
      }),
    })
    if (!(r.data && (r.data as TradingOrder).id)) errors.push(`TP: ${r.error || 'failed'}`)
  }
  if (sl != null) {
    // stop-limit sell: limit slightly below the stop so it clears the book
    const limP = exitSide === 'sell' ? sl * 0.999 : sl * 1.001
    const r = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        symbol: entry.symbol,
        qty: legQty,
        side: exitSide,
        type: 'stop_limit',
        time_in_force: 'gtc',
        stop_price: sl.toFixed(sl < 1 ? 6 : 2),
        limit_price: limP.toFixed(limP < 1 ? 6 : 2),
        client_order_id: exitLegClientId(entry.id, 'sl'),
      }),
    })
    if (!(r.data && (r.data as TradingOrder).id)) errors.push(`SL: ${r.error || 'failed'}`)
  }
  return errors
}

const OCO_CYCLE_MS = 6000
const OCO_OPEN_STATUSES = ['new', 'open', 'accepted', 'pending_new', 'held', 'partially_filled']
// last attach-failure signature per entry id — the supervisor retries every
// cycle, but transient rejections (e.g. Alpaca's "potential wash trade
// detected" while a crossing pending entry rests) must not spam the log
const attachWarnSig = new Map<string, string>()

/** Supervised (user,mode) pairs — survives dev hot reloads via globalThis. */
function supervisedSet(): Set<string> {
  const g = globalThis as { __ttOcoSupervised?: Set<string> }
  if (!g.__ttOcoSupervised) g.__ttOcoSupervised = new Set<string>()
  return g.__ttOcoSupervised
}

/**
 * Start the OCO supervisor for a (user, mode) pair (idempotent). One cycle
 * every 6s: (a) cancel managed exit legs whose position is gone (OCO
 * semantics — when the position closes, the surviving leg dies),
 * (b) attach exit legs to managed entries that have FILLED.
 */
export function ensureCryptoOcoSupervisor(userId: string, mode: TradeMode): void {
  const key = `${userId}|${mode}`
  if (supervisedSet().has(key)) return
  supervisedSet().add(key)
  const timer = setInterval(() => {
    void runOcoCycle(userId, mode)
  }, OCO_CYCLE_MS)
  // never keep the process alive just for the supervisor
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
}

async function runOcoCycle(userId: string, mode: TradeMode): Promise<void> {
  try {
    const [ordRes, posRes] = await Promise.all([
      tradeFetch<TradingOrder[]>(userId, mode, '/v2/orders?status=all&limit=500&direction=desc'),
      tradeFetch<TradingPosition[]>(userId, mode, '/v2/positions'),
    ])
    const orders: TradingOrder[] = Array.isArray(ordRes.data) ? ordRes.data : []
    const positions: TradingPosition[] = Array.isArray(posRes.data) ? posRes.data : []
    const norm = (s: string) => s.replace('/', '').toUpperCase()
    const posSet = new Set(positions.map((p) => norm(p.symbol)))
    const knownCoids = new Set(orders.map((o) => o.client_order_id || ''))
    const isCrypto = (o: TradingOrder) => o.asset_class === 'crypto' || o.symbol.includes('/')

    // (a) OCO cleanup: a managed exit leg dies with its position
    for (const o of orders) {
      if (!isCrypto(o) || !OCO_OPEN_STATUSES.includes(o.status)) continue
      if (!(o.client_order_id || '').startsWith('tte-')) continue
      if (!posSet.has(norm(o.symbol))) {
        const r = await cancelOrder(userId, mode, o.id)
        console.log(`[oco] canceled orphaned exit ${o.client_order_id} (${o.symbol}) -> ${r.status}`)
      }
    }

    // (b) attach exit legs to managed entries that have FILLED
    for (const o of orders) {
      if (!isCrypto(o) || o.status !== 'filled') continue
      const plan = parseCryptoPlan(o.client_order_id)
      if (!plan || (plan.tp == null && plan.sl == null)) continue
      const wantTp = plan.tp != null && !knownCoids.has(exitLegClientId(o.id, 'tp'))
      const wantSl = plan.sl != null && !knownCoids.has(exitLegClientId(o.id, 'sl'))
      if (!wantTp && !wantSl) continue
      const errs = await placeCryptoExitLegs(
        userId,
        mode,
        o,
        wantTp ? plan.tp! : undefined,
        wantSl ? plan.sl! : undefined,
      )
      if (errs.length) {
        const sig = errs.join('; ')
        if (attachWarnSig.get(o.id) !== sig) {
          attachWarnSig.set(o.id, sig)
          console.warn(`[oco] exit attach failed for ${o.id} (${o.symbol}):`, sig)
        }
      } else {
        attachWarnSig.delete(o.id)
        console.log(`[oco] attached exits to filled entry ${o.id} (${o.symbol}) tp=${plan.tp} sl=${plan.sl}`)
      }
    }
  } catch (e) {
    console.warn('[oco] supervisor cycle failed:', e instanceof Error ? e.message : e)
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

/** Rebuild an open exit order body from an existing order (used by the
 * cancel+re-place fallback and OCO-sibling regeneration). */
function exitBodyFrom(
  orig: TradingOrder,
  patch: { stop_price?: number; limit_price?: number; trail_percent?: number },
): Record<string, unknown> | null {
  const isCrypto = orig.asset_class === 'crypto' || orig.symbol.includes('/')
  const num = (v: string | null | undefined): number | null => {
    if (v == null) return null
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const newStop = patch.stop_price ?? num(orig.stop_price)
  const newLimit = patch.limit_price ?? num(orig.limit_price)
  const newTrail = patch.trail_percent ?? num(orig.trail_percent)
  const body: Record<string, unknown> = {
    symbol: orig.symbol,
    qty: orig.qty,
    side: orig.side,
    type: orig.type,
    time_in_force: orig.time_in_force || 'gtc',
  }
  if (orig.type === 'stop') {
    if (newStop == null) return null
    body.stop_price = fmtPx(newStop, isCrypto)
  } else if (orig.type === 'stop_limit') {
    if (newStop == null) return null
    body.stop_price = fmtPx(newStop, isCrypto)
    if (newLimit != null) {
      body.limit_price = fmtPx(newLimit, isCrypto)
    } else {
      // preserve the original stop→limit offset when only the stop moves
      const os = num(orig.stop_price)
      const ol = num(orig.limit_price)
      const ratio = os && ol ? ol / os : orig.side === 'sell' ? 0.999 : 1.001
      body.limit_price = fmtPx(newStop * ratio, isCrypto)
    }
  } else if (orig.type === 'limit') {
    if (newLimit == null) return null
    body.limit_price = fmtPx(newLimit, isCrypto)
  } else if (orig.type === 'trailing_stop') {
    if (newTrail == null) return null
    body.trail_percent = String(newTrail)
  } else {
    return null // market / unknown — never re-placed blindly
  }
  return body
}

export interface ReplaceExitResult {
  data: TradingOrder | null
  status: number
  error?: string
  mode?: TradeMode
  method?: 'replace' | 'cancel-replace'
  note?: string
}

/**
 * Replace SL/TP prices on an open exit order — the chart line-drag path.
 *
 * Verified against the paper API (2026-10):
 * - A PATCH on a STANDALONE exit (crypto split exits) replaces cleanly:
 *   type/time_in_force/sibling prices are preserved and a NEW order id is
 *   returned.
 * - The chart drag used to 404 when the order lived on the OTHER host: the
 *   client did not send `mode`, so the PATCH went to the stored trade-mode
 *   preference — paper order ids do not exist on live and vice versa, the
 *   update silently never landed on Alpaca.
 * - Bracket OCO legs may refuse direct replacement; cancel+re-place is the
 *   universal fallback (canceling one OCO leg can cascade-cancel the sibling,
 *   which we detect and regenerate).
 */
export async function replaceExitOrderSmart(
  userId: string,
  mode: TradeMode,
  orderId: string,
  patch: { stop_price?: number; limit_price?: number; trail_percent?: number; crypto?: boolean },
): Promise<ReplaceExitResult> {
  const patchBody: Record<string, unknown> = {}
  if (patch.stop_price != null) patchBody.stop_price = fmtPx(patch.stop_price, patch.crypto)
  if (patch.limit_price != null) patchBody.limit_price = fmtPx(patch.limit_price, patch.crypto)
  if (patch.trail_percent != null) patchBody.trail_percent = String(parseFloat(patch.trail_percent.toFixed(4)))

  // 1) PATCH on the requested host; 2) retry the other host on 404 —
  // both hosts share the same key pair, so a wrong-host id self-heals here.
  const order: TradeMode[] = mode === 'paper' ? ['paper', 'live'] : ['live', 'paper']
  let last: TradeFetchResult<TradingOrder> | null = null
  let errHost: TradeMode = mode
  for (const m of order) {
    const r = await tradeFetch<TradingOrder>(userId, m, `/v2/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify(patchBody),
    })
    if (r.data && (r.data as TradingOrder).id) {
      return { data: r.data, status: r.status, mode: m, method: 'replace' }
    }
    last = r
    // 422 "order parameters are not changed" — the order ALREADY carries the
    // requested value (e.g. a second drag to the same level). That IS the
    // desired end state: return the current order instead of churning a
    // cancel+re-place cycle.
    if (r.status === 422 && String(r.error || '').includes('not changed')) {
      const cur = await tradeFetch<TradingOrder>(userId, m, `/v2/orders/${orderId}`)
      if (cur.data) {
        return { data: cur.data, status: 200, mode: m, method: 'replace', note: 'Order already at this value' }
      }
    }
    if (r.status !== 404) {
      // real rejection — the order lives on THIS host; run the fallback there
      errHost = m
      break
    }
  }

  // 3) The id may have JUST been replaced (fast double-drag: Alpaca's
  // cancel/replace is async and 404s for a beat) — follow the replaced_by
  // chain and retry the direct PATCH on the live successor first.
  const OPEN_STATUSES = ['new', 'open', 'accepted', 'pending_new', 'held', 'partially_filled']
  let orig: TradingOrder | null = null
  let targetId = orderId
  for (let hop = 0; hop < 4; hop++) {
    const o = await tradeFetch<TradingOrder>(userId, errHost, `/v2/orders/${targetId}`)
    if (!o.data) break
    const od = o.data
    if (OPEN_STATUSES.includes(String(od.status))) {
      orig = od
      if (targetId !== orderId) {
        // the open successor exists — retry the direct PATCH on it
        const retry = await tradeFetch<TradingOrder>(userId, errHost, `/v2/orders/${targetId}`, {
          method: 'PATCH',
          body: JSON.stringify(patchBody),
        })
        if (retry.data && (retry.data as TradingOrder).id) {
          return { data: retry.data, status: 200, mode: errHost, method: 'replace', note: 'Applied to the replacement order' }
        }
        if (retry.status === 422 && String(retry.error || '').includes('not changed')) {
          return { data: od, status: 200, mode: errHost, method: 'replace', note: 'Order already at this value' }
        }
        last = retry
      }
      break
    }
    const rb = od.replaced_by
    if (typeof rb === 'string' && rb && rb !== targetId) {
      targetId = rb
      continue
    }
    orig = od // terminal status without a successor
    break
  }
  if (!orig) {
    return {
      data: null,
      status: last?.status || 502,
      error: last?.error || 'Order not found on paper or live',
      mode: errHost,
      method: 'cancel-replace',
    }
  }
  if (!OPEN_STATUSES.includes(String(orig.status))) {
    return {
      data: null,
      status: 409,
      error: `Order is ${orig.status} on ${errHost} — nothing to replace (refresh the chart)`,
      mode: errHost,
      method: 'cancel-replace',
    }
  }

  // snapshot the OCO sibling BEFORE cancelling (limit TP vs stop-ish SL of
  // the same symbol + same side) so a cascade-cancel can be healed
  const openRes = await tradeFetch<TradingOrder[]>(userId, errHost, "/v2/orders?status=open&limit=500")
  const norm = (s: string) => s.replace('/', '').toUpperCase()
  const isStopish = (t: string) => t === 'stop' || t === 'stop_limit' || t === 'trailing_stop'
  const sibling = (openRes.data || []).find(
    (o) =>
      o.id !== orderId &&
      norm(o.symbol) === norm(orig.symbol) &&
      o.side === orig.side &&
      ((isStopish(orig.type) && o.type === 'limit') || (orig.type === 'limit' && isStopish(o.type))),
  )

  const cancelRes = await cancelOrder(userId, errHost, targetId)
  if (cancelRes.status !== 204 && cancelRes.status !== 200 && cancelRes.status !== 404) {
    return { data: null, status: cancelRes.status || 502, error: cancelRes.error || 'Cancel failed', mode: errHost, method: 'cancel-replace' }
  }

  const newBody = exitBodyFrom(orig, patch)
  if (!newBody) {
    return { data: null, status: 400, error: `Unsupported exit type ${orig.type} for re-place`, mode: errHost, method: 'cancel-replace' }
  }
  // re-place on the host the order actually lives on (`mode` can differ when
  // the PATCH self-healed across paper/live)
  const r2 = await tradeFetch<TradingOrder>(userId, errHost, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(newBody),
  })
  if (!(r2.data && (r2.data as TradingOrder).id)) {
    return { data: null, status: r2.status || 502, error: `Re-place failed after cancel: ${r2.error || 'unknown'}`, mode: errHost, method: 'cancel-replace' }
  }

  // heal the sibling if the cancel cascaded (OCO group cancellation)
  let note: string | undefined
  if (sibling) {
    const stillOpen = await tradeFetch<TradingOrder>(userId, errHost, `/v2/orders/${sibling.id}`)
    const gone = !stillOpen.data || ['canceled', 'cancelled', 'expired', 'rejected'].includes(String(stillOpen.data.status))
    if (gone) {
      const sibBody = exitBodyFrom(sibling, {})
      if (sibBody) {
        const rs = await tradeFetch<TradingOrder>(userId, errHost, '/v2/orders', {
          method: 'POST',
          body: JSON.stringify(sibBody),
        })
        note = rs.data ? 'OCO sibling re-created' : `Warning: sibling exit lost (${rs.error || 're-place failed'})`
      }
    }
  }
  return { data: r2.data, status: r2.status, mode: errHost, method: 'cancel-replace', note }
}

// ---------- pending ENTRY order replacement (drag entry/TP/SL lines) ----------

export interface ReplaceEntryResult {
  data: TradingOrder | null
  status: number
  error?: string
  mode?: TradeMode
  method?: 'replace' | 'cancel-replace'
  note?: string
}

const ENTRY_OPEN_STATUSES = ['new', 'open', 'accepted', 'pending_new', 'held', 'partially_filled']

/** Poll the order until the async cancel lands (buying power frees up). */
async function waitUntilCanceled(userId: string, host: TradeMode, orderId: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((res) => setTimeout(res, 350))
    const r = await tradeFetch<TradingOrder>(userId, host, `/v2/orders/${orderId}`)
    const s = String(r.data?.status || '')
    if (['canceled', 'cancelled', 'expired', 'rejected'].includes(s)) return
    if (!r.data) return // gone / unreachable — best effort
  }
}

/**
 * Change the entry limit price and/or the planned TP/SL of a PENDING
 * (unfilled) entry order — the chart drag on the dashed entry / (pend)
 * TP / SL lines lands here.
 *
 * Verified against the paper API (2026-10, the "US-stock drag kills both
 * TP/SL" bug):
 * - Alpaca REFUSES a PATCH on a bracket parent in `accepted` status
 *   (422 "cannot replace order in accepted status") — so EVERY stock
 *   pending-order drag takes the cancel+re-place fallback below.
 * - Canceling the parent cascades to the WHOLE family (parent + both legs).
 * - The re-place POST is then validated by Alpaca against the entry price:
 *   TP must be >= base+0.01 (long) / <= base-0.01 (short), SL mirrored.
 *   A drag that crossed the entry made the POST 422 AFTER the family was
 *   already canceled — both TP/SL lines vanished (crypto never hits this:
 *   its plan rides in the client_order_id with no Alpaca-side validation).
 *
 * Therefore:
 * - STOCK bracket parents: pre-validate the final entry/TP/SL combo BEFORE
 *   any cancel and reject crossing drags with a clear message (the family
 *   stays on the chart); a direct PATCH is still attempted first when the
 *   order is in a replaceable state.
 * - If the re-place POST fails for ANY reason after the cancel, the ORIGINAL
 *   prices are re-posted (restore) so a transient rejection can never lose
 *   the exits.
 * - CRYPTO managed entries (`ttb-` plan in client_order_id): ALWAYS cancel →
 *   wait → re-place with a freshly encoded plan. A direct PATCH replaces the
 *   order WITHOUT carrying the client_order_id over (verified live: the
 *   replacement lost the plan and the OCO supervisor would never attach the
 *   exits), and client_order_id cannot be safely re-sent (uniqueness).
 *   Re-placing keeps the REMAINING qty (a partially filled entry keeps its
 *   fill).
 * - Plain limit entries (no plan): direct PATCH on limit_price.
 */
export async function replacePendingEntrySmart(
  userId: string,
  mode: TradeMode,
  orderId: string,
  patch: { limit_price?: number; tp?: number; sl?: number; crypto?: boolean },
): Promise<ReplaceEntryResult> {
  // 1) locate the order (host fallback, same id spaces as exits)
  const hosts: TradeMode[] = mode === 'paper' ? ['paper', 'live'] : ['live', 'paper']
  let host: TradeMode = mode
  let orig: TradingOrder | null = null
  let last: TradeFetchResult<TradingOrder> | null = null
  for (const m of hosts) {
    const r = await tradeFetch<TradingOrder>(userId, m, `/v2/orders/${orderId}`)
    if (r.data && (r.data as TradingOrder).id) {
      orig = r.data
      host = m
      break
    }
    last = r
  }
  if (!orig) {
    return { data: null, status: last?.status || 404, error: last?.error || 'Order not found on paper or live', mode }
  }
  const statusStr = String(orig.status)
  if (!ENTRY_OPEN_STATUSES.includes(statusStr)) {
    return { data: null, status: 409, error: `Order is ${statusStr} — nothing to change (refresh the chart)`, mode: host }
  }

  const isCrypto = orig.asset_class === 'crypto' || orig.symbol.includes('/')
  const crypto = Boolean(patch.crypto) || isCrypto
  const plan = parseCryptoPlan(orig.client_order_id)
  const exitLegs = (orig.legs || []).filter((l) => l.side !== orig.side)
  const num = (v: string | null | undefined): number | null => {
    if (v == null) return null
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  // pre-drag prices (for the restore-on-failure re-post)
  const origLimit0 = num(orig.limit_price)
  const origTp0 = num(exitLegs.find((l) => l.type === 'limit')?.limit_price) ?? plan?.tp ?? null
  const origSl0 = num(exitLegs.find((l) => l.type === 'stop' || l.type === 'stop_limit')?.stop_price) ?? plan?.sl ?? null
  // the order's ACTUAL current values (pre-patch) — used to verify "not changed"
  const curTp0 = origTp0
  const curSl0 = origSl0
  // current TP/SL: requested patch wins, else the parent's legs, else the plan
  const curTp =
    patch.tp ??
    num(exitLegs.find((l) => l.type === 'limit')?.limit_price) ??
    plan?.tp ??
    null
  const curSl =
    patch.sl ??
    num(exitLegs.find((l) => l.type === 'stop' || l.type === 'stop_limit')?.stop_price) ??
    plan?.sl ??
    null
  const origHasTp = curTp != null
  const origHasSl = curSl != null
  const newLimit = patch.limit_price ?? num(orig.limit_price)
  // a PATCH cannot ADD a bracket leg the order does not have — full re-place
  const addsLeg = (patch.tp != null && !origHasTp) || (patch.sl != null && !origHasSl)
  // crypto plan orders ALWAYS re-place: a direct PATCH drops the ttb-
  // client_order_id (verified live), losing the TP/SL plan entirely
  const managedCrypto = Boolean(plan)

  // ---- STOCK bracket validation (BEFORE any cancel — this is the fix for
  // the "drag kills both TP/SL" bug). Alpaca validates bracket legs against
  // the entry price and the cancel+re-place fallback is UNAVOIDABLE for
  // stock brackets (PATCH refused on accepted-status parents), so a crossing
  // drag would cancel the family and then fail the re-place — total loss.
  // Reject the drag up-front with an actionable message; nothing is canceled
  // and the chart refresh restores the lines at their old prices.
  const basePx = newLimit ?? (orig.type === 'stop_limit' || orig.type === 'stop' ? num(orig.stop_price) : null)
  if (!crypto && basePx != null && (curTp != null || curSl != null)) {
    const long = orig.side === 'buy'
    const tick = 0.01
    const entry = fmtPx(basePx, false)
    if (curTp != null) {
      const okTp = long ? curTp >= basePx + tick : curTp <= basePx - tick
      if (!okTp) {
        return {
          data: null,
          status: 422,
          mode: host,
          error: long
            ? `Take-profit must stay above the entry price (${entry}) for a long entry — drag it above the entry line`
            : `Take-profit must stay below the entry price (${entry}) for a short entry — drag it below the entry line`,
          method: 'replace',
          note: 'Rejected before cancel — order untouched',
        }
      }
    }
    if (curSl != null) {
      const okSl = long ? curSl <= basePx - tick : curSl >= basePx + tick
      if (!okSl) {
        return {
          data: null,
          status: 422,
          mode: host,
          error: long
            ? `Stop-loss must stay below the entry price (${entry}) for a long entry — drag it below the entry line`
            : `Stop-loss must stay above the entry price (${entry}) for a short entry — drag it above the entry line`,
          method: 'replace',
          note: 'Rejected before cancel — order untouched',
        }
      }
    }
  }

  // 2) direct PATCH — ONLY for entry-field changes (or orders without legs).
  // Verified live 2026-10 (queued bracket parent, market closed): Alpaca
  // APPLIES limit/qty changes but SILENTLY DROPS take_profit/stop_loss
  // changes sent on the parent, and a leg-ONLY patch 422s with the
  // misleading "order parameters are not changed" even when the values
  // differ. So any leg change on a bracket parent MUST go through the
  // cancel+re-place rebuild below, or it never lands (the "second SL/TP
  // drag does nothing" bug).
  const touchesLegs = patch.tp != null || patch.sl != null
  const isBracketParent =
    String(orig.order_class || '') === 'bracket' || (orig.legs?.length ?? 0) > 0
  if (!addsLeg && !managedCrypto && !(isBracketParent && touchesLegs)) {
    const body: Record<string, unknown> = {}
    if (patch.limit_price != null && newLimit != null) body.limit_price = fmtPx(newLimit, crypto)
    if (origHasTp) body.take_profit = { limit_price: fmtPx(curTp!, crypto) }
    if (origHasSl) body.stop_loss = { stop_price: fmtPx(curSl!, crypto) }
    if (Object.keys(body).length > 0) {
      const r = await tradeFetch<TradingOrder>(userId, host, `/v2/orders/${orderId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      if (r.data && (r.data as TradingOrder).id) {
        return { data: r.data, status: r.status, mode: host, method: 'replace' }
      }
      if (r.status === 422 && String(r.error || '').includes('not changed')) {
        // only a genuine no-op when EVERY requested value already equals the
        // order's current value — Alpaca also emits this message for changes
        // it refuses to apply (e.g. leg-only patch on a queued bracket),
        // which must fall through to the cancel+re-place rebuild
        const samePx = (a: number | null | undefined, b: number | null | undefined) =>
          a != null && b != null && Math.abs(a - b) < 1e-9
        const noop =
          (patch.limit_price == null || samePx(newLimit, origLimit0)) &&
          (patch.tp == null || samePx(patch.tp, curTp0)) &&
          (patch.sl == null || samePx(patch.sl, curSl0))
        if (noop) {
          return { data: orig, status: 200, mode: host, method: 'replace', note: 'Order already at this value' }
        }
      }
      // real rejection (or a fake "not changed") → cancel+re-place below
    } else {
      return { data: null, status: 400, error: 'nothing to change', mode: host }
    }
  }

  // 2b) pure leg no-op on a rebuilt order (bracket parent or managed crypto
  // plan): the requested TP/SL already equals the current level — don't churn
  // a cancel+re-place cycle for nothing (the chart would flash its lines).
  // The leg values may live in the parent's legs OR the ttb- plan.
  if (touchesLegs && patch.limit_price == null && (isBracketParent || managedCrypto)) {
    const samePx = (a: number | null | undefined, b: number | null | undefined) =>
      a != null && b != null && Math.abs(a - b) < 1e-9
    const unchanged =
      (patch.tp == null || samePx(patch.tp, curTp0)) &&
      (patch.sl == null || samePx(patch.sl, curSl0))
    if (unchanged) {
      return { data: orig, status: 200, mode: host, method: 'replace', note: 'Order already at this value' }
    }
  }

  // 3) cancel + re-place (plan change on crypto, new leg, or rejected PATCH)
  const cancelRes = await cancelOrder(userId, host, orderId)
  if (cancelRes.status !== 204 && cancelRes.status !== 200 && cancelRes.status !== 404) {
    return { data: null, status: cancelRes.status || 502, error: cancelRes.error || 'Cancel failed', mode: host, method: 'cancel-replace' }
  }
  if (cancelRes.status !== 404) await waitUntilCanceled(userId, host, orderId)

  const remaining = (parseFloat(orig.qty) || 0) - (parseFloat(orig.filled_qty) || 0)
  if (!(remaining > 0)) {
    return { data: null, status: 200, mode: host, method: 'cancel-replace', note: 'Entry filled — nothing re-placed' }
  }
  const wantTp = patch.tp ?? curTp
  const wantSl = patch.sl ?? curSl
  const hadPlan = Boolean(plan) || (orig.legs?.length ?? 0) > 0 || patch.tp != null || patch.sl != null
  const buildPlaceBody = (limit: number | null, tp: number | null, sl: number | null): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      symbol: orig.symbol,
      qty: String(remaining),
      side: orig.side,
      type: orig.type,
      time_in_force: orig.time_in_force || 'gtc',
    }
    if (limit != null && (orig.type === 'limit' || orig.type === 'stop_limit')) {
      b.limit_price = fmtPx(limit, crypto)
    }
    if (orig.type === 'stop' && sl != null) b.stop_price = fmtPx(sl, crypto)
    if (hadPlan) {
      if (isCrypto) {
        // re-encode the plan — the supervisor attaches legs from it on fill
        b.client_order_id = encodePlanClientId(host, tp ?? null, sl ?? null)
      } else {
        b.order_class = 'bracket'
        if (tp != null) b.take_profit = { limit_price: fmtPx(tp, false) }
        if (sl != null) b.stop_loss = { stop_price: fmtPx(sl, false) }
      }
    }
    return b
  }

  const r2 = await tradeFetch<TradingOrder>(userId, host, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(buildPlaceBody(newLimit, wantTp, wantSl)),
  })
  if (!(r2.data && (r2.data as TradingOrder).id)) {
    // The family is ALREADY canceled (Alpaca cascades a parent cancel to both
    // legs) — a failed re-place here used to be the "US-stock drag makes both
    // TP/SL disappear" bug. Re-post the ORIGINAL prices so a rejected
    // replacement (validation, transient error) can never lose the exits.
    const rr = await tradeFetch<TradingOrder>(userId, host, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify(buildPlaceBody(origLimit0, origTp0, origSl0)),
    })
    if (rr.data && (rr.data as TradingOrder).id) {
      return {
        data: rr.data,
        status: 200,
        mode: host,
        method: 'cancel-replace',
        note: `Change rejected (${r2.error || 'unknown'}) — original order restored`,
      }
    }
    return { data: null, status: r2.status || 502, error: `Re-place failed after cancel: ${r2.error || 'unknown'}`, mode: host, method: 'cancel-replace' }
  }
  return { data: r2.data, status: r2.status, mode: host, method: 'cancel-replace' }
}

/**
 * Market-close a position. Crypto balances are reserved per open exit order,
 * so lingering SL/TP legs would starve the liquidation (Alpaca sells only
 * qty_available) — cancel the symbol's opposite-side (exit) orders FIRST,
 * then close. Returns the close order and how many exits were cancelled.
 */
export async function closePositionFull(
  userId: string,
  mode: TradeMode,
  symbol: string,
): Promise<{ close: TradeFetchResult<TradingOrder>; canceledExits: number }> {
  const tSym = tradeSymbol(symbol)
  const norm = (s: string) => s.replace('/', '').toUpperCase()
  // snapshot the position side BEFORE closing (long -> sell exits, short -> buy)
  const posRes = await tradeFetch<TradingPosition>(userId, mode, `/v2/positions/${encodeURIComponent(tSym)}`)
  const posSide = posRes.data?.side
  let canceledExits = 0
  // fetch ALL open orders and filter here — Alpaca's `symbols=` query wants
  // the slash form for crypto (BTC/USD) while callers pass either form
  const openRes = await getOpenOrders(userId, mode)
  const orders: TradingOrder[] = (Array.isArray(openRes.data) ? openRes.data : [])
    .filter((o) => norm(o.symbol) === norm(tSym))
  const exitSide = posSide === 'long' ? 'sell' : posSide === 'short' ? 'buy' : null
  for (const o of orders) {
    if (exitSide && o.side !== exitSide) continue // keep same-side (entry) orders
    if (exitSide == null && o.type === 'market') continue // no position info: keep entries
    // `held` legs ride a PENDING (unfilled) entry family on this symbol —
    // canceling them would strip the pending entry of its TP/SL plan (the
    // nested merge now makes them visible here). Skip them.
    if (o.status === 'held') continue
    const c = await cancelOrder(userId, mode, o.id)
    if (c.status === 204 || c.status === 200) canceledExits += 1
  }
  const close = await closePosition(userId, mode, symbol)
  return { close, canceledExits }
}

export async function cancelOrder(userId: string, mode: TradeMode, orderId: string) {
  return tradeFetch<null>(userId, mode, `/v2/orders/${orderId}`, { method: 'DELETE' })
}

// ---------- attach TP/SL to an EXISTING position (chart [TP]/[SL] drag-add) ----------

export interface AttachExitsResult {
  results: TradingOrder[]
  errors: string[]
  oco?: boolean
}

/**
 * Attach a TP and/or SL to an open position — the chart's "+TP"/"+SL" chip
 * drag and the Positions-tab add buttons land here.
 *
 * Stocks (verified against the paper API 2026-10):
 * - order_class=oco REQUIRES take_profit.limit_price AND stop_loss.stop_price
 *   AND an existing position to exit (without one: "oco orders must be exit
 *   orders"; parent must be type=limit). With both legs requested we send the
 *   documented OCO exit body and FALL BACK to separate legs on rejection.
 * - A single leg is a plain limit (TP) / stop (SL) order on the full position.
 * Crypto: ALL advanced order classes are rejected — place split exit legs
 * (50/50 qty, 0.99 fee factor) directly against the position, tagged with a
 * `ttp-` client_order_id (ignored by the OCO supervisor's `tte-` cleanup).
 */
export async function attachExitsToPosition(
  userId: string,
  mode: TradeMode,
  symbol: string,
  exits: { tp?: number; sl?: number },
): Promise<AttachExitsResult> {
  const tSym = tradeSymbol(symbol)
  const hasTp = typeof exits.tp === 'number' && exits.tp > 0
  const hasSl = typeof exits.sl === 'number' && exits.sl > 0
  if (!hasTp && !hasSl) return { results: [], errors: ['no TP/SL price given'] }

  const posRes = await tradeFetch<TradingPosition>(userId, mode, `/v2/positions/${encodeURIComponent(tSym)}`)
  if (!posRes.data) {
    return { results: [], errors: [posRes.error && posRes.error !== 'not found' ? posRes.error : 'Position not found'] }
  }
  const pos = posRes.data
  // crypto-ness comes from the POSITION (callers pass either symbol form —
  // the chart sends the trade symbol BTCUSD, whose crypto-ness the route
  // cannot infer from a slash)
  const isCrypto = pos.asset_class === 'crypto' || pos.symbol.includes('/')
  // orders use the position's own symbol form (crypto keeps the slash)
  const orderSymbol = pos.symbol
  // long position -> sell exits; short position -> buy exits
  const exitSide = pos.side === 'short' ? 'buy' : 'sell'
  const qtyAvail = parseFloat(pos.qty_available) || parseFloat(pos.qty) || 0
  if (!(qtyAvail > 0)) return { results: [], errors: ['position has no available qty'] }

  const results: TradingOrder[] = []
  const errors: string[] = []
  const post = (body: Record<string, unknown>) =>
    tradeFetch<TradingOrder>(userId, mode, '/v2/orders', { method: 'POST', body: JSON.stringify(body) })
  const legQty = (n: number) => String(parseFloat((n * (isCrypto ? 0.99 : 1)).toFixed(8)))

  if (!isCrypto) {
    if (hasTp && hasSl) {
      const r = await post({
        symbol: orderSymbol,
        qty: String(qtyAvail),
        side: exitSide,
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: fmtPx(exits.tp!),
        order_class: 'oco',
        take_profit: { limit_price: fmtPx(exits.tp!) },
        stop_loss: { stop_price: fmtPx(exits.sl!) },
      })
      if (r.data && (r.data as TradingOrder).id) {
        return { results: [r.data], errors, oco: true }
      }
      errors.push(`OCO rejected, placing legs separately: ${r.error || 'failed'}`)
    }
    if (hasTp) {
      const r = await post({
        symbol: orderSymbol, qty: String(qtyAvail), side: exitSide, type: 'limit',
        time_in_force: 'gtc', limit_price: fmtPx(exits.tp!),
      })
      if (r.data && (r.data as TradingOrder).id) results.push(r.data)
      else errors.push(`TP: ${r.error || 'failed'}`)
    }
    if (hasSl) {
      const r = await post({
        symbol: orderSymbol, qty: String(qtyAvail), side: exitSide, type: 'stop',
        time_in_force: 'gtc', stop_price: fmtPx(exits.sl!),
      })
      if (r.data && (r.data as TradingOrder).id) results.push(r.data)
      else errors.push(`SL: ${r.error || 'failed'}`)
    }
    return { results, errors }
  }

  // ---- crypto: emulated split legs (balance is reserved per open sell) ----
  // Each attached leg takes HALF the position (the two legs together cover
  // it), capped by what is still available — Alpaca reserves every open sell
  // against qty_available, so a full-size first leg would make attaching the
  // second one impossible (502 insufficient balance). Legs may be attached
  // independently in any order.
  const posQty = parseFloat(pos.qty) || qtyAvail
  const qty = legQty(Math.min(qtyAvail, posQty / 2))
  const coidBase = `ttp-${Math.random().toString(36).slice(2, 8)}`
  if (hasTp) {
    const r = await post({
      symbol: orderSymbol, qty, side: exitSide, type: 'limit', time_in_force: 'gtc',
      limit_price: fmtPx(exits.tp!, true),
      client_order_id: `${coidBase}-tp`,
    })
    if (r.data && (r.data as TradingOrder).id) results.push(r.data)
    else errors.push(`TP: ${r.error || 'failed'}`)
  }
  if (hasSl) {
    // stop-limit: book-clearing limit offset beyond the stop
    const limP = exitSide === 'sell' ? exits.sl! * 0.999 : exits.sl! * 1.001
    const r = await post({
      symbol: orderSymbol, qty, side: exitSide, type: 'stop_limit', time_in_force: 'gtc',
      stop_price: fmtPx(exits.sl!, true),
      limit_price: fmtPx(limP, true),
      client_order_id: `${coidBase}-sl`,
    })
    if (r.data && (r.data as TradingOrder).id) results.push(r.data)
    else errors.push(`SL: ${r.error || 'failed'}`)
  }
  return { results, errors }
}

export async function closePosition(userId: string, mode: TradeMode, symbol: string) {
  return tradeFetch<TradingOrder>(userId, mode, `/v2/positions/${encodeURIComponent(tradeSymbol(symbol))}`, {
    method: 'DELETE',
  })
}
