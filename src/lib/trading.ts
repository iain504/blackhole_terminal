// Alpaca Trading API client (server-side only): paper + live order routing,
// positions, bracket/OCO exits, order replacement for SL/TP drag updates.
//
// Verified against the paper API (2026-10):
// - Stocks support order_class=bracket (entry + BOTH legs) and oto (entry +
//   ONE leg — bracket 422s "bracket orders require take_profit.limit_price"
//   when only stop_loss or only take_profit is sent).
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
  updated_at?: string | null
  replaces: string | null
  replaced_by?: string | null
  legs: TradingOrder[] | null
  client_order_id?: string
  asset_class?: string
  /** 'simple' | 'bracket' | 'oco' | 'oto' (Alpaca v2 order class) */
  order_class?: string
  /** bracket/OCO family id — legs of one family share it with the parent */
  group_id?: string | null
  /** 'entry' | 'take_profit' | 'stop_loss' (role inside the family) */
  group_role?: string | null
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

/** Parsed net position for ONE symbol (the grid close / per-lot exit sizing
 *  helper). 404 → a CONFIDENT zero (flat); any other failure → null = UNKNOWN
 *  — callers must treat null as "don't clamp" (the broker rejects an oversell
 *  anyway; a data hiccup must never silently shrink an exit). */
export interface SymbolPosition {
  side: 'long' | 'short' | null
  /** signed net qty (negative = short) */
  qty: number
  /** qty free to SELL against a long — open sell exits already reserve it */
  qtyAvailable: number
}

export async function getPositionForSymbol(userId: string, mode: TradeMode, symbol: string): Promise<SymbolPosition | null> {
  const r = await tradeFetch<TradingPosition>(userId, mode, `/v2/positions/${encodeURIComponent(tradeSymbol(symbol))}`)
  // 404 = definitively FLAT on this account → a CONFIDENT zero (the close path
  // clears the tracked lots; the broker truly holds nothing). Any OTHER non-OK
  // is UNKNOWN → null: tradeFetch surfaces the ERROR JSON as `data` on non-OK
  // responses (401/403/429 bodies are truthy), and a fabricated zero position
  // would silently "close" lots the broker still holds.
  if (r.status === 404) return { side: null, qty: 0, qtyAvailable: 0 }
  const p = r.status >= 200 && r.status < 300 ? r.data : null
  if (!p || typeof p.qty !== 'string') return null
  const qty = Number.parseFloat(p.qty)
  const qa = Number.parseFloat(p.qty_available)
  return {
    side: p.side === 'short' ? 'short' : p.side === 'long' ? 'long' : null,
    qty: Number.isFinite(qty) ? qty : 0,
    qtyAvailable: Number.isFinite(qa) ? qa : Number.isFinite(qty) ? qty : 0,
  }
}

/** Statuses that count as "still working" when merging the held-leg recovery
 *  sweep into the open-order list. 'held' = the armed sibling of a live OCO
 *  pair — Alpaca keeps exactly ONE leg working (status new/open) and holds
 *  the other one. */
const WORKING_ORDER_STATUSES = new Set([
  'new', 'accepted', 'pending_new', 'accepted_for_bidding', 'pending_replace', 'held', 'done_for_day',
])

export async function getOpenOrders(userId: string, mode: TradeMode, symbol?: string, heldSymbols?: string[]) {
  const q = symbol ? `&symbols=${encodeURIComponent(symbol)}` : ''
  // Alpaca hides bracket legs from the DEFAULT (nested=false) list: an open
  // bracket parent comes back with legs=null, so pending-entry TP/SL (and any
  // exit mapped from legs) is invisible to callers. The nested=true variant
  // nests the legs under the parent — but a FILLED parent's ACTIVE legs only
  // show in the flat list. Fetch BOTH and merge by id (nested wins when it
  // carries legs) so both shapes are always covered.
  // Held exit legs of FILLED bracket families: Alpaca excludes 'held' orders
  // from status=open UNLESS they nest under an OPEN parent — and the parent of
  // a filled bracket is itself closed, so the armed stop-loss leg (status
  // 'held', flat in the list, no parent) is INVISIBLE to a status=open query.
  // It shows up only in status=all. Recover it with a symbols-scoped sweep
  // (limited to symbols that actually have positions → small payload) and
  // merge by id. Without this, an algo/manual stock bracket shows its TP on
  // the position but the SL column stays empty ("+ SL") even though the stop
  // is very much live on the broker.
  const sweepSyms = [...new Set((heldSymbols ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 30)
  const [flat, nested, sweep] = await Promise.all([
    tradeFetch<TradingOrder[]>(userId, mode, `/v2/orders?status=open&limit=100${q}`),
    tradeFetch<TradingOrder[]>(userId, mode, `/v2/orders?status=open&limit=100&nested=true${q}`),
    // (parallel with the open fetches — the sweep list is known upfront)
    sweepSyms.length > 0
      ? tradeFetch<TradingOrder[]>(
          userId,
          mode,
          `/v2/orders?status=all&limit=500&direction=desc&symbols=${encodeURIComponent(sweepSyms.join(','))}`,
        )
      : Promise.resolve({ data: [] as TradingOrder[], status: 0 }),
  ])
  const flatRows: TradingOrder[] = Array.isArray(flat.data) ? flat.data : []
  const nestedRows: TradingOrder[] = Array.isArray(nested.data) ? nested.data : []
  const sweepRows: TradingOrder[] = (Array.isArray(sweep.data) ? sweep.data : []).filter((o) =>
    WORKING_ORDER_STATUSES.has(o.status),
  )
  if (nestedRows.length === 0 && sweepRows.length === 0) return flat
  const byId = new Map<string, TradingOrder>()
  for (const o of [...flatRows, ...sweepRows]) byId.set(o.id, o)
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
  /** short algo source tag (first 8 of the AlgoRun id) — embeds `ttr-` attribution in the client_order_id */
  sourceRef?: string
  /** Task 10-k — which pipeline placed the order: 'algo' (default) embeds
   * `ttr-`, 'grid' embeds `ttg-` in the client_order_id so positions/history
   * can attribute the trade to a grid. */
  sourceKind?: 'algo' | 'grid'
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
  // Alpaca requires a whole-number quantity for non-fractional assets: every
  // STOCK order qty is rounded DOWN to an integer (crypto stays fractional).
  const qty = isCrypto ? body.qty : Math.floor(body.qty)
  if (!(qty > 0)) {
    return { results: [], errors: ['Quantity rounds to 0 — stocks require a whole number (min 1 share)'] }
  }
  const entry: Record<string, unknown> = {
    symbol: tradeSymbol(body.symbol),
    qty: String(qty),
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
    // Stocks: bracket handles entry + legs atomically. Alpaca's 'bracket'
    // class REQUIRES BOTH legs — sending stop_loss alone (or take_profit
    // alone) 422s with "bracket orders require take_profit.limit_price" and
    // the WHOLE entry dies (a VWAP/BB algo run configured with only SL 1%
    // used to submit nothing at all, and manual one-sided tickets failed the
    // same way). A one-sided exit plan must use 'oto' (one-triggers-other).
    const hasTp = typeof body.take_profit === 'number' && body.take_profit > 0
    const hasSl = typeof body.stop_loss === 'number' && body.stop_loss > 0
    if (hasTp || hasSl) {
      entry.order_class = hasTp && hasSl ? 'bracket' : 'oto'
      if (hasTp) entry.take_profit = { limit_price: body.take_profit!.toFixed(2) }
      if (hasSl) entry.stop_loss = { stop_price: body.stop_loss!.toFixed(2) }
      // encode the plan for the chart's pending display: Alpaca materializes
      // bracket LEGS only when the entry activates, so a queued (weekend /
      // pre-market) bracket would otherwise render without its TP/SL lines
      entry.client_order_id = encodePlanClientId(mode, hasTp ? body.take_profit! : null, hasSl ? body.stop_loss! : null, body.sourceRef, body.sourceKind)
    } else if (body.sourceRef) {
      // Task 10-k — source-tagged orders WITHOUT exits (grid market orders)
      // used to lose their attribution entirely (the tag was only written
      // alongside a TP/SL plan) → grid fills rendered as "Manual". Tag them
      // anyway: same grammar, tp/sl segments decode to null.
      entry.client_order_id = encodePlanClientId(mode, null, null, body.sourceRef, body.sourceKind)
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
    entry.client_order_id = encodePlanClientId(mode, hasTp ? body.take_profit! : null, hasSl ? body.stop_loss! : null, body.sourceRef, body.sourceKind)
  } else if (body.sourceRef) {
    // Task 10-k — keep source attribution on exit-less orders (grid fills)
    entry.client_order_id = encodePlanClientId(mode, null, null, body.sourceRef, body.sourceKind)
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

/**
 * Encode the OCO/bracket plan (mode + TP/SL prices) into the entry's
 * client_order_id. Grammar (Alpaca caps client_order_id at 48 chars):
 *   manual/plan entry:  ttb-<m>-tp<enc>-sl<enc>-<rand6>
 *   ALGO RUN entry:     ttr-<m>-<runRef>-tp<enc>-sl<enc>-<rand4>
 *   GRID entry (10-k):  ttg-<m>-<gridRef>-tp<enc>-sl<enc>-<rand4>
 * `ttb-` powers the chart's pending TP/SL display and the crypto OCO
 * supervisor; `ttr-` additionally carries the first 8 chars of the AlgoRun id
 * so every trade can be attributed Manual vs Algo (which strategy); `ttg-`
 * carries the first 8 chars of the GridTrade id (sourceKind 'grid').
 */
export function encodePlanClientId(mode: TradeMode, tp: number | null, sl: number | null, runRef?: string | null, sourceKind?: 'algo' | 'grid'): string {
  const tpE = tp != null && tp > 0 ? encP(tp) : '0'
  const slE = sl != null && sl > 0 ? encP(sl) : '0'
  if (runRef) {
    const prefix = sourceKind === 'grid' ? 'ttg' : 'ttr'
    const coid = `${prefix}-${mode[0]}-${runRef}-tp${tpE}-sl${slE}-${Math.random().toString(36).slice(2, 6)}`
    if (coid.length <= 48) return coid
    // absurd prices (≥$100k with both legs) can overflow the 48-char cap —
    // fall back to the manual grammar (attribution lost, order stays valid)
  }
  return `ttb-${mode[0]}-tp${tpE}-sl${slE}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Decode the plan (and the algo/grid source tag) from a `ttb-…`/`ttr-…`/
 * `ttg-…` client_order_id. Returns null when the order was not placed by this
 * terminal (external orders — Alpaca dashboard, mobile app — carry uuid coids).
 */
export function parseCryptoPlan(clientOrderId: string | undefined | null): { tp: number | null; sl: number | null; runRef: string | null; gridRef: string | null } | null {
  const coid = clientOrderId || ''
  const pos = (s: string | undefined) => {
    const v = s ? parseInt(s, 10) / 1e6 : 0
    return v > 0 ? v : null
  }
  const algo = /^ttr-[a-z]-([a-z0-9]{6,12})-tp(\d+)-sl(\d+)-/.exec(coid)
  if (algo) return { tp: pos(algo[2]), sl: pos(algo[3]), runRef: algo[1], gridRef: null }
  const grid = /^ttg-[a-z]-([a-z0-9]{6,12})(?:-tp(\d+)-sl(\d+))?-/.exec(coid)
  if (grid) return { tp: pos(grid[2]), sl: pos(grid[3]), runRef: null, gridRef: grid[1] }
  const m = /^ttb-[a-z](?:-tp(\d+))?(?:-sl(\d+))?-/.exec(coid)
  if (!m) return null
  return { tp: pos(m[1]), sl: pos(m[2]), runRef: null, gridRef: null }
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
// last attach-backoff state per entry id — when a failed attach is followed
// by an UNCHANGED state (same position qty + missing-leg set) the supervisor
// does not re-POST every cycle; any state change enables one fresh attempt
const attachWarnSig = new Map<string, string>()

/** Supervised (user,mode) pairs — survives dev hot reloads via globalThis. */
function supervisedSet(): Set<string> {
  const g = globalThis as { __ttOcoSupervised?: Set<string> }
  if (!g.__ttOcoSupervised) g.__ttOcoSupervised = new Set<string>()
  return g.__ttOcoSupervised
}

/** Stock bracket parents already leg-healed (one-shot) — survives hot reloads. */
function healedSet(): Set<string> {
  const g = globalThis as { __ttOcoHealed?: Set<string> }
  if (!g.__ttOcoHealed) g.__ttOcoHealed = new Set<string>()
  return g.__ttOcoHealed
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

    // (a) OCO cleanup: a managed exit leg dies with its position. Covers BOTH
    // leg tags: `tte-` (supervisor-placed after an entry fills) and `ttp-`
    // (user-attached via chart drag / +TP/+SL). A leftover exit against a
    // closed position used to survive and later fire against the NEW
    // position's balance — one source of the crypto "insufficient balance"
    // 403 noise.
    for (const o of orders) {
      if (!isCrypto(o) || !OCO_OPEN_STATUSES.includes(o.status)) continue
      const coid0 = o.client_order_id || ''
      if (!(coid0.startsWith('tte-') || coid0.startsWith('ttp-'))) continue
      if (!posSet.has(norm(o.symbol))) {
        const r = await cancelOrder(userId, mode, o.id)
        console.log(`[oco] canceled orphaned exit ${coid0} (${o.symbol}) -> ${r.status}`)
      }
    }

    // (b) attach exit legs to managed entries that have FILLED. Skips when
    // the POSITION is gone (closing via another exit used to leave the
    // supervisor POSTing a doomed leg every cycle — the repeating
    // "insufficient balance for BTC (available: 0)" 403 spam) and backs off
    // when nothing relevant changed since the last failed attempt (the
    // position qty and the missing-leg set are the signature — any change
    // re-enables one attempt).
    for (const o of orders) {
      if (!isCrypto(o) || o.status !== 'filled') continue
      const plan = parseCryptoPlan(o.client_order_id)
      if (!plan || (plan.tp == null && plan.sl == null)) continue
      const wantTp = plan.tp != null && !knownCoids.has(exitLegClientId(o.id, 'tp'))
      const wantSl = plan.sl != null && !knownCoids.has(exitLegClientId(o.id, 'sl'))
      if (!wantTp && !wantSl) continue
      const pos = positions.find((p) => norm(p.symbol) === norm(o.symbol))
      if (!pos || !(parseFloat(pos.qty) > 0)) continue // position closed — nothing to protect
      const stateSig = `${parseFloat(pos.qty)}|${wantTp ? 'tp' : ''}${wantSl ? 'sl' : ''}`
      if (attachWarnSig.get(o.id) === stateSig) continue // same state, last attempt failed — back off
      const errs = await placeCryptoExitLegs(
        userId,
        mode,
        o,
        wantTp ? plan.tp! : undefined,
        wantSl ? plan.sl! : undefined,
      )
      if (errs.length) {
        attachWarnSig.set(o.id, stateSig)
        console.warn(`[oco] exit attach failed for ${o.id} (${o.symbol}):`, errs.join('; '), '— backed off until the state changes')
      } else {
        attachWarnSig.delete(o.id)
        console.log(`[oco] attached exits to filled entry ${o.id} (${o.symbol}) tp=${plan.tp} sl=${plan.sl}`)
      }
    }

    // (c) STOCK bracket leg-heal: a filled bracket parent whose exit legs are
    // ALL canceled leaves a NAKED position. Verified live 2026-10 (ECHO): a
    // PATCH-replace of a partially filled parent races its own cancel — the
    // original fills after being superseded, Alpaca cancels the legs instead
    // of activating them, and the replacement can fail + reverse. Re-attach
    // the planned exits once, within a short window after the fill so
    // deliberate later cancels are respected; never fight exits that already
    // exist (the user may have re-added them manually).
    const HEAL_WINDOW_MS = 15 * 60 * 1000
    const nowMs = Date.now()
    for (const o of orders) {
      if (isCrypto(o) || o.status !== 'filled') continue
      // one-sided plans are placed as order_class 'oto' (see placeOrderWithExits)
      // — their filled parents need the same naked-position leg-heal
      const oc = String(o.order_class || '')
      if (oc !== 'bracket' && oc !== 'oto' && o.group_role !== 'entry') continue
      const filledAt = o.filled_at ? Date.parse(o.filled_at) : NaN
      if (!Number.isFinite(filledAt) || nowMs - filledAt > HEAL_WINDOW_MS) continue
      const family = orders.filter((x) => x.group_id && x.group_id === o.group_id && x.id !== o.id)
      if (family.length === 0) continue
      if (family.some((l) => OCO_OPEN_STATUSES.includes(l.status))) continue // legs alive
      const tpLeg = family.find((l) => l.group_role === 'take_profit')
      const slLeg = family.find((l) => l.group_role === 'stop_loss')
      const tp = tpLeg ? parseFloat(tpLeg.limit_price || '') : NaN
      const sl = slLeg ? parseFloat(slLeg.stop_price || '') : NaN
      if (!Number.isFinite(tp) && !Number.isFinite(sl)) continue
      const healKey = `${userId}|${mode}|${o.id}`
      if (healedSet().has(healKey)) continue
      if (!posSet.has(norm(o.symbol))) {
        healedSet().add(healKey) // position gone — nothing to protect
        continue
      }
      const openNow = await getOpenOrders(userId, mode, o.symbol)
      const rows: TradingOrder[] = Array.isArray(openNow.data) ? openNow.data : []
      const exitSide = o.side === 'buy' ? 'sell' : 'buy'
      const hasExit = rows.some(
        (x) =>
          norm(x.symbol) === norm(o.symbol) &&
          x.side === exitSide &&
          OCO_OPEN_STATUSES.includes(x.status) &&
          x.status !== 'held',
      )
      if (hasExit) {
        healedSet().add(healKey) // already protected manually — respect it
        continue
      }
      const r = await attachExitsToPosition(userId, mode, o.symbol, {
        tp: Number.isFinite(tp) ? tp : undefined,
        sl: Number.isFinite(sl) ? sl : undefined,
      })
      healedSet().add(healKey)
      if (r.results.length > 0) {
        console.log(`[oco] healed naked position ${o.symbol} from filled bracket ${o.id} (tp=${tp} sl=${sl})`)
      } else {
        console.warn(`[oco] leg-heal failed for ${o.symbol} (${o.id}):`, r.errors.join('; '))
      }
    }

    // (d) crypto PARTIAL-EXIT heal: an exit leg that partially filled and then
    // died (filled/canceled/expired) leaves the REMAINING position without
    // that protection — the user had to re-drag the SL after every partial
    // fill (the BTC/USD report). Re-place the same kind at the same price for
    // what is left (half-position sizing, same as the attach path), once per
    // dead leg. Bounded to RECENT deaths (30 min) so a stale price is never
    // resurrected onto an unrelated future position. Skipped when the
    // position is gone or the user already re-added a same-kind exit.
    const EXIT_HEAL_WINDOW_MS = 30 * 60 * 1000
    for (const o of orders) {
      if (!isCrypto(o) || OCO_OPEN_STATUSES.includes(o.status)) continue
      const coid = o.client_order_id || ''
      if (!(coid.startsWith('ttp-') || coid.startsWith('tte-'))) continue
      if (!(coid.endsWith('-tp') || coid.endsWith('-sl'))) continue
      const filledQty = parseFloat(o.filled_qty) || 0
      if (filledQty <= 0) continue // canceled without any fill — nothing happened
      const deadAt = Date.parse(o.updated_at || o.filled_at || o.created_at || '') || 0
      if (!deadAt || nowMs - deadAt > EXIT_HEAL_WINDOW_MS) continue // too old — leave history alone
      const healKey = `${userId}|${mode}|${o.id}`
      if (healedSet().has(healKey)) continue
      healedSet().add(healKey) // one-shot per dead leg (a heal leg gets its own id)
      const kind: 'tp' | 'sl' = coid.endsWith('-tp') ? 'tp' : 'sl'
      const px = parseFloat((kind === 'tp' ? o.limit_price : o.stop_price) || '')
      if (!Number.isFinite(px) || px <= 0) continue
      const posRes = await tradeFetch<TradingPosition>(userId, mode, `/v2/positions/${encodeURIComponent(o.symbol)}`)
      const pos = posRes.data
      if (!pos || !(Math.abs(parseFloat(pos.qty) || 0) > 0)) continue // position gone
      const exitSide = pos.side === 'short' ? 'buy' : 'sell'
      const openRes = await getOpenOrders(userId, mode, o.symbol)
      const rows: TradingOrder[] = Array.isArray(openRes.data) ? openRes.data : []
      const hasSameKind = rows.some(
        (x) =>
          norm(x.symbol) === norm(o.symbol) &&
          x.side === exitSide &&
          OCO_OPEN_STATUSES.includes(x.status) &&
          x.status !== 'held' &&
          (kind === 'tp' ? x.type === 'limit' : x.type === 'stop' || x.type === 'stop_limit'),
      )
      if (hasSameKind) continue // already protected (user re-added / sibling alive)
      const avail = Math.abs(parseFloat(pos.qty_available) || 0) || Math.abs(parseFloat(pos.qty) || 0)
      const posQty = Math.abs(parseFloat(pos.qty) || 0)
      const qty = String(parseFloat((Math.max(0, Math.min(avail, posQty / 2)) * 0.99).toFixed(8)))
      if (!(parseFloat(qty) > 0)) continue
      const healCoid = `ttp-heal-${Math.random().toString(36).slice(2, 8)}-${kind}`
      const body =
        kind === 'tp'
          ? {
              symbol: o.symbol, qty, side: exitSide, type: 'limit', time_in_force: 'gtc',
              limit_price: fmtPx(px, true), client_order_id: healCoid,
            }
          : {
              symbol: o.symbol, qty, side: exitSide, type: 'stop_limit', time_in_force: 'gtc',
              stop_price: fmtPx(px, true),
              limit_price: fmtPx(exitSide === 'sell' ? px * 0.999 : px * 1.001, true),
              client_order_id: healCoid,
            }
      const r = await tradeFetch<TradingOrder>(userId, mode, '/v2/orders', { method: 'POST', body: JSON.stringify(body) })
      if (r.data && (r.data as TradingOrder).id) {
        console.log(`[oco] healed partial-filled ${kind.toUpperCase()} leg ${o.id} (${o.symbol}, filled ${filledQty}) — re-placed for the remaining position`)
      } else {
        console.warn(`[oco] partial-exit heal failed for ${o.symbol} ${kind}:`, r.error || r.status)
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
  // stocks only — whole shares required (round down, never up)
  const qty = Math.floor(body.qty)
  if (!(qty > 0)) {
    return { data: null, error: 'Quantity rounds to 0 — stocks require a whole number (min 1 share)', status: 422 }
  }
  return tradeFetch<TradingOrder>(userId, mode, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: tradeSymbol(body.symbol),
      qty: String(qty),
      side: body.side,
      type: 'trailing_stop',
      time_in_force: 'gtc',
      trail_percent: body.trail_percent.toFixed(2),
    }),
  })
}

/** Rebuild an open exit order body from an existing order (used by the
 * cancel+re-place fallback and OCO-sibling regeneration).
 *
 * `availQty` (optional) clamps the re-placed qty to what the account can
 * actually deliver RIGHT NOW: partial fills of the exit itself shrink the
 * position, and re-placing the full ORIGINAL qty after a partial close is a
 * guaranteed 403 ("insufficient balance for BTC"). The clamp uses the
 * order's own unfilled remainder AND the caller-supplied side-aware
 * position capacity (whichever is smaller). */
function exitBodyFrom(
  orig: TradingOrder,
  patch: { stop_price?: number; limit_price?: number; trail_percent?: number },
  availQty?: number,
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
  // qty: the order's own remaining (original minus what it already filled);
  // an exit that partially filled must not re-place its FULL original size
  const origQty = parseFloat(orig.qty) || 0
  const filledQty = parseFloat(orig.filled_qty) || 0
  let qty = filledQty > 0 ? Math.max(0, origQty - filledQty) : origQty
  if (typeof availQty === 'number' && Number.isFinite(availQty) && availQty >= 0) {
    qty = Math.min(qty, availQty)
  }
  // stocks are non-fractionable — a re-placed exit is always whole shares
  if (!isCrypto) qty = Math.floor(qty)
  if (!(qty > 0)) return null
  const body: Record<string, unknown> = {
    symbol: orig.symbol,
    qty: String(parseFloat(qty.toFixed(8))),
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
/**
 * True when the order already carries every value the patch asks for (each
 * compared at the precision the PATCH body was formatted with).
 *
 * REQUIRED before trusting Alpaca's 422 "order parameters are not changed":
 * Alpaca emits that same message when it IGNORES a field — and it refuses
 * trail_percent changes on a trailing_stop PATCH entirely (verified 2026-10,
 * Task 67: PATCH {trail_percent:"2.5"} on a trail-2% order → 422 "not
 * changed"). Without the value check the shortcut swallowed the edit and the
 * trail never moved; with it, the request falls through to the
 * cancel+re-place fallback, which re-places the order with the new trail.
 */
function patchAlreadyApplied(
  cur: TradingOrder,
  patch: { stop_price?: number; limit_price?: number; trail_percent?: number; crypto?: boolean },
): boolean {
  const closeTo = (curVal: string | null | undefined, want: number) => {
    if (curVal == null) return false
    const c = parseFloat(curVal)
    if (!Number.isFinite(c)) return false
    const dp = patch.crypto ? (want >= 1 ? 6 : 8) : want >= 1 ? 2 : 4
    return Math.abs(c - want) <= Math.pow(10, -dp) / 2 + 1e-9
  }
  if (patch.trail_percent != null && !closeTo(cur.trail_percent, patch.trail_percent)) return false
  if (patch.stop_price != null && !closeTo(cur.stop_price, patch.stop_price)) return false
  if (patch.limit_price != null && !closeTo(cur.limit_price, patch.limit_price)) return false
  return true
}

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
    // cancel+re-place cycle. But VERIFY the current values first — Alpaca
    // fires this message even when it silently ignored the field (trailing
    // stop % — see patchAlreadyApplied).
    if (r.status === 422 && String(r.error || '').includes('not changed')) {
      const cur = await tradeFetch<TradingOrder>(userId, m, `/v2/orders/${orderId}`)
      if (cur.data && patchAlreadyApplied(cur.data, patch)) {
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
        if (retry.status === 422 && String(retry.error || '').includes('not changed') && patchAlreadyApplied(od, patch)) {
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
    // The exit PARTIALLY filled and then died (filled/canceled/expired): the
    // remaining position is naked, and re-dragging the line should place a
    // NEW exit at the dragged price for what is LEFT — not dead-end with a
    // 409. (The BTC/USD report: after a partial SL fill the position had no
    // SL, and every re-drag was refused.)
    const filledQty = parseFloat(orig.filled_qty) || 0
    if (filledQty > 0 && patch.trail_percent == null) {
      const isTpIntent = patch.limit_price != null && orig.type === 'limit'
      const isSlIntent = patch.stop_price != null && (orig.type === 'stop' || orig.type === 'stop_limit')
      const px = isTpIntent
        ? (patch.limit_price as number)
        : isSlIntent
          ? (patch.stop_price as number)
          : null
      if (px != null && px > 0) {
        const pos = await tradeFetch<TradingPosition>(userId, errHost, `/v2/positions/${encodeURIComponent(orig.symbol)}`)
        if (pos.data && Math.abs(parseFloat(pos.data.qty) || 0) > 0) {
          const r = await attachExitsToPosition(userId, errHost, orig.symbol, isTpIntent ? { tp: px } : { sl: px })
          if (r.results.length > 0) {
            return {
              data: r.results[0],
              status: 200,
              mode: errHost,
              method: 'cancel-replace',
              note: `Previous exit had partially filled (${filledQty}) — a new one was attached for the remaining position`,
            }
          }
          return {
            data: null,
            status: 502,
            error: friendlyExitQtyError(`Could not re-attach after the partial fill: ${r.errors.join('; ')}`),
            mode: errHost,
            method: 'cancel-replace',
          }
        }
      }
    }
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
  // Wait for the cancel to SETTLE before re-placing: Alpaca releases the
  // order's qty reservation asynchronously — an immediate re-place used to
  // 403 with "insufficient balance" while the old order still held the qty.
  await waitUntilCanceled(userId, errHost, targetId)

  // Side-aware capacity of the position AFTER the cancel (partial fills of
  // this exit may have shrunk the position; the freed reservation changes
  // qty_available). The re-place qty is clamped to it — re-placing the full
  // original size after a partial close was a guaranteed 403.
  let availQty: number | undefined
  const posAfter = await tradeFetch<TradingPosition>(userId, errHost, `/v2/positions/${encodeURIComponent(orig.symbol)}`)
  if (posAfter.data) {
    const p = posAfter.data
    const qa = parseFloat(p.qty_available)
    const pq = Math.abs(parseFloat(p.qty) || 0)
    availQty = p.side === 'short' ? pq : Number.isFinite(qa) ? qa : pq
    if (!(availQty > 0)) availQty = 0
  } else {
    availQty = 0 // position closed while we were replacing — nothing to protect
  }

  const newBody = exitBodyFrom(orig, patch, availQty)
  if (!newBody) {
    return {
      data: null,
      status: 409,
      error: availQty === 0
        ? 'Nothing left to protect — the position is closed or fully reserved'
        : `Unsupported exit type ${orig.type} for re-place`,
      mode: errHost,
      method: 'cancel-replace',
    }
  }
  // re-place on the host the order actually lives on (`mode` can differ when
  // the PATCH self-healed across paper/live)
  const r2 = await tradeFetch<TradingOrder>(userId, errHost, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(newBody),
  })
  if (!(r2.data && (r2.data as TradingOrder).id)) {
    return { data: null, status: r2.status || 502, error: friendlyExitQtyError(`Re-place failed after cancel: ${r2.error || 'unknown'}`), mode: errHost, method: 'cancel-replace' }
  }

  // heal the sibling if the cancel cascaded (OCO group cancellation) — its
  // qty is clamped the same way (recompute the capacity AFTER the main
  // re-place consumed its reservation)
  let note: string | undefined
  if (sibling) {
    const stillOpen = await tradeFetch<TradingOrder>(userId, errHost, `/v2/orders/${sibling.id}`)
    const gone = !stillOpen.data || ['canceled', 'cancelled', 'expired', 'rejected'].includes(String(stillOpen.data.status))
    if (gone) {
      let sibAvail: number | undefined
      const posSib = await tradeFetch<TradingPosition>(userId, errHost, `/v2/positions/${encodeURIComponent(orig.symbol)}`)
      if (posSib.data) {
        const p = posSib.data
        const qa = parseFloat(p.qty_available)
        const pq = Math.abs(parseFloat(p.qty) || 0)
        sibAvail = p.side === 'short' ? pq : Number.isFinite(qa) ? qa : pq
      } else {
        sibAvail = 0
      }
      const sibBody = exitBodyFrom(sibling, {}, sibAvail)
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

/**
 * Poll the order until the async cancel lands (buying power frees up).
 * Alpaca cancels are ASYNC and can take seconds while the market keeps
 * filling the order (verified live 2026-10: a bracket cancel took >5s) —
 * poll up to ~5s so callers that re-place right after don't double-position.
 */
async function waitUntilCanceled(userId: string, host: TradeMode, orderId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((res) => setTimeout(res, 500))
    const r = await tradeFetch<TradingOrder>(userId, host, `/v2/orders/${orderId}`)
    const s = String(r.data?.status || '')
    if (['canceled', 'cancelled', 'expired', 'rejected'].includes(s)) return
    if (!r.data) return // gone / unreachable — best effort
  }
}

/** Alpaca error text for "the position qty is already reserved by open exits". */
export function friendlyExitQtyError(msg: string): string {
  if (/insufficient qty available for order/i.test(msg)) {
    return (
      msg +
      ' — your open TP/SL exit orders reserve the position quantity. Cancel the existing exit first, or use the position row\u2019s [+TP]/[+SL] buttons (they rebuild both exits as one OCO).'
    )
  }
  // crypto exits (SELL legs) reject with "insufficient balance for <ASSET>"
  // when the position shrank below the requested size — nearly always the
  // residue of PARTIAL fills (the SL filled part of the position already)
  if (/insufficient balance for /i.test(msg)) {
    return (
      msg +
      ' — the remaining position is smaller than the exit size (partial fills reduced it). The qty is recalculated from the live position — try again.'
    )
  }
  return msg
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
  // A PARTIALLY FILLED order must NEVER take the direct-PATCH replace path:
  // Alpaca's replace asynchronously cancels the working order and mirrors its
  // fills onto the replacement. Verified live 2026-10 (ECHO bracket, entry
  // drag at 7/10 filled): the original's remaining shares filled BEFORE the
  // cancel landed, Alpaca canceled the family's TP/SL legs instead of
  // activating them, and the replacement failed + reversed — a NAKED
  // position. Route the edit through the controlled cancel+re-place below.
  const filledQty0 = parseFloat(orig.filled_qty) || 0
  const partiallyFilled = filledQty0 > 0
  if (partiallyFilled) {
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
  if (!addsLeg && !managedCrypto && !partiallyFilled && !(isBracketParent && touchesLegs)) {
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

  // 3) cancel + re-place (plan change on crypto, new leg, rejected PATCH, or
  // a PARTIALLY FILLED order — never direct-PATCH those, see above)
  const cancelRes = await cancelOrder(userId, host, orderId)
  if (cancelRes.status !== 204 && cancelRes.status !== 200 && cancelRes.status !== 404) {
    return { data: null, status: cancelRes.status || 502, error: cancelRes.error || 'Cancel failed', mode: host, method: 'cancel-replace' }
  }
  if (cancelRes.status !== 404) await waitUntilCanceled(userId, host, orderId)

  // Re-read the order AFTER the cancel lands: a fill can race the cancel
  // (verified live), so the pre-cancel filled_qty can understate reality.
  let filledQty = filledQty0
  const finalRes = await tradeFetch<TradingOrder>(userId, host, `/v2/orders/${orderId}`)
  if (finalRes.data) {
    const fq = parseFloat(finalRes.data.filled_qty)
    if (Number.isFinite(fq) && fq > filledQty) filledQty = fq
    if (String(finalRes.data.status) === 'filled') filledQty = parseFloat(finalRes.data.qty) || filledQty
  }
  const remaining = (parseFloat(orig.qty) || 0) - filledQty
  const wantTp = patch.tp ?? curTp
  const wantSl = patch.sl ?? curSl
  const hadPlan = Boolean(plan) || (orig.legs?.length ?? 0) > 0 || patch.tp != null || patch.sl != null

  // Protect the shares that ALREADY filled before the cancel landed — they
  // left the pending family behind, and with it their TP/SL legs. Skipped
  // when exits are already open (legs may have activated in a fill race;
  // never fight orders that exist).
  const protectFilledPortion = async (): Promise<string | undefined> => {
    if (!(filledQty > 0) || !hadPlan) return undefined
    const openNow = await getOpenOrders(userId, host, orig.symbol)
    const rows: TradingOrder[] = Array.isArray(openNow.data) ? openNow.data : []
    const normSym = (s: string) => s.replace('/', '').toUpperCase()
    const exitSide = orig.side === 'buy' ? 'sell' : 'buy'
    const hasExit = rows.some(
      (o) =>
        normSym(o.symbol) === normSym(orig.symbol) &&
        o.side === exitSide &&
        OCO_OPEN_STATUSES.includes(o.status) &&
        o.status !== 'held',
    )
    if (hasExit) return undefined
    if (isCrypto) {
      const pseudoEntry: TradingOrder = { ...orig, filled_qty: String(filledQty), status: 'filled' }
      const errs = await placeCryptoExitLegs(userId, host, pseudoEntry, wantTp ?? undefined, wantSl ?? undefined)
      return errs.length ? errs.join('; ') : undefined
    }
    const r = await attachExitsToPosition(userId, host, orig.symbol, {
      tp: wantTp ?? undefined,
      sl: wantSl ?? undefined,
    })
    return r.results.length ? undefined : r.errors.join('; ') || 'exit attach failed'
  }

  if (!(remaining > 0)) {
    // fully filled while the cancel was in flight — protect, re-place nothing
    const warn = await protectFilledPortion()
    return {
      data: null,
      status: 200,
      mode: host,
      method: 'cancel-replace',
      note: warn
        ? `Entry filled during edit — exits attach failed: ${warn}`
        : hadPlan
          ? 'Entry filled during edit — exits attached'
          : 'Entry filled — nothing re-placed',
    }
  }
  const buildPlaceBody = (limit: number | null, tp: number | null, sl: number | null, qty: number): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      symbol: orig.symbol,
      qty: String(qty),
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
        // re-encode the plan — the supervisor attaches legs from it on fill;
        // keep the original's algo source tag so edits never de-attribute a run
        b.client_order_id = encodePlanClientId(host, tp ?? null, sl ?? null, plan?.runRef ?? undefined)
      } else {
        // mirror placeOrderWithExits: a one-sided plan must rebuild as 'oto' —
        // a bracket with a single leg 422s ("bracket orders require
        // take_profit.limit_price") and the re-place dies with no exits
        b.order_class = tp != null && sl != null ? 'bracket' : 'oto'
        if (tp != null) b.take_profit = { limit_price: fmtPx(tp, false) }
        if (sl != null) b.stop_loss = { stop_price: fmtPx(sl, false) }
      }
    }
    return b
  }

  const r2 = await tradeFetch<TradingOrder>(userId, host, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(buildPlaceBody(newLimit, wantTp, wantSl, remaining)),
  })
  if (!(r2.data && (r2.data as TradingOrder).id)) {
    // The family is ALREADY canceled (Alpaca cascades a parent cancel to both
    // legs) — a failed re-place here used to be the "US-stock drag makes both
    // TP/SL disappear" bug. Re-post the ORIGINAL prices so a rejected
    // replacement (validation, transient error) can never lose the exits.
    const rr = await tradeFetch<TradingOrder>(userId, host, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify(buildPlaceBody(origLimit0, origTp0, origSl0, remaining)),
    })
    const warn = await protectFilledPortion()
    const warnSuffix = warn ? ` — filled shares left unprotected: ${warn}` : ''
    if (rr.data && (rr.data as TradingOrder).id) {
      return {
        data: rr.data,
        status: 200,
        mode: host,
        method: 'cancel-replace',
        note: `Change rejected (${r2.error || 'unknown'}) — original order restored${warnSuffix}`,
      }
    }
    return { data: null, status: r2.status || 502, error: `Re-place failed after cancel: ${r2.error || 'unknown'}${warnSuffix}`, mode: host, method: 'cancel-replace' }
  }
  const warn = await protectFilledPortion()
  return {
    data: r2.data,
    status: r2.status,
    mode: host,
    method: 'cancel-replace',
    note: warn ? `Filled shares could not be protected separately: ${warn}` : undefined,
  }
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

/**
 * Fetch ONE order by id (Task 83 — Trade Advisor order-status polling /
 * cancel button). Tries the requested host first, then the other mode's host
 * (same paper/live id-space fallback the replace helpers use) so a drag-time
 * host mismatch can never 404 a live order.
 */
export async function getOrderById(userId: string, mode: TradeMode, orderId: string) {
  const hosts: TradeMode[] = mode === 'paper' ? ['paper', 'live'] : ['live', 'paper']
  let last: TradeFetchResult<TradingOrder> | null = null
  for (const m of hosts) {
    const r = await tradeFetch<TradingOrder>(userId, m, `/v2/orders/${orderId}`)
    if (r.data && (r.data as TradingOrder).id) return { ...r, mode: m }
    last = r
  }
  return { data: null, status: last?.status || 404, error: last?.error || 'Order not found on paper or live', mode }
}

/**
 * Poll an order for its REAL average fill price. A market order returns from
 * POST before the fill lands — `filled_avg_price` in the placement response
 * is usually empty, and the v1.80.7 grid incident recorded the reference
 * quote as the fill while the broker actually filled ~34% away (the quote
 * itself was a transient simulator fallback). Engine callers now poll a few
 * hundred ms for the broker's own number; a canceled/rejected order that can
 * never fill returns null so the caller can fail honestly.
 */
export async function pollOrderFillPrice(
  userId: string,
  mode: TradeMode,
  orderId: string,
  attempts = 3,
  delayMs = 400,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs))
    const r = await getOrderById(userId, mode, orderId)
    const o = r.data
    if (!o) continue
    const fp = Number(o.filled_avg_price)
    if (Number.isFinite(fp) && fp > 0) return fp
    const st = String(o.status || '')
    if (st === 'canceled' || st === 'rejected' || st === 'expired') return null
  }
  return null
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
 * Stocks (verified against the paper API 2026-10, the "manual SL fails with
 * insufficient qty after a manual TP" bug):
 * - order_class=oco REQUIRES take_profit.limit_price AND stop_loss.stop_price
 *   AND an existing position to exit (without one: "oco orders must be exit
 *   orders"; parent must be type=limit). With both legs requested we send the
 *   documented OCO exit body.
 * - Two SEPARATE exit orders can never coexist: every exit-side order
 *   reserves qty_available, so leg #2 is rejected with "insufficient qty
 *   available for order". When an exit already exists we therefore CANCEL it
 *   and rebuild BOTH legs as a single OCO (the linked-pair form Alpaca's own
 *   bracket children use) — adding an SL to a position that has a TP (or
 *   editing either one) works without ever over-reserving.
 * - qty_available "0" is a REAL zero (fully reserved) and must not fall back
 *   to the full qty — the falsy `||` chain used to bypass the guard and send
 *   an order Alpaca was guaranteed to reject.
 * - SHORT positions are the OPPOSITE (verified live 2026-10: SPCX short
 *   reports qty="-10", qty_available="0"): their exits are BUY orders that
 *   reserve buying power, NEVER the position qty. The exit size is |qty| —
 *   gating on qty_available used to refuse EVERY short-side attach with
 *   "Position has no available qty" (the user's drag/+SL bug).
 * Crypto: ALL advanced order classes are rejected — place split exit legs
 * (50/50 qty, 0.99 fee factor) directly against the position, tagged with a
 * `ttp-` client_order_id (cleaned up + partial-fill-healed by the supervisor
 * together with the `tte-` legs).
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
  let pos: TradingPosition = posRes.data
  // crypto-ness comes from the POSITION (callers pass either symbol form —
  // the chart sends the trade symbol BTCUSD, whose crypto-ness the route
  // cannot infer from a slash)
  const isCrypto = pos.asset_class === 'crypto' || pos.symbol.includes('/')
  // orders use the position's own symbol form (crypto keeps the slash)
  const orderSymbol = pos.symbol
  // long position -> sell exits; short position -> buy exits
  const exitSide = pos.side === 'short' ? 'buy' : 'sell'
  // qty_available "0" is a real zero (fully reserved by open exits) — NEVER
  // fall back to the full qty on a falsy check
  const availOf = (p: TradingPosition): number => {
    const v = Number.parseFloat(p.qty_available)
    return Number.isFinite(v) ? v : Number.parseFloat(p.qty) || 0
  }

  const results: TradingOrder[] = []
  const errors: string[] = []
  const post = (body: Record<string, unknown>) =>
    tradeFetch<TradingOrder>(userId, mode, '/v2/orders', { method: 'POST', body: JSON.stringify(body) })

  if (!isCrypto) {
    const normSym = (s: string) => s.replace('/', '').toUpperCase()
    const isOpen = (s: string) => OCO_OPEN_STATUSES.includes(s)
    const openRes = await getOpenOrders(userId, mode, tSym)
    const rows: TradingOrder[] = Array.isArray(openRes.data) ? openRes.data : []
    // exits of THIS position (skip `held` legs — they ride a still-pending
    // entry family and hold no qty of the open position)
    const exitsHere = rows.filter(
      (o) => normSym(o.symbol) === normSym(tSym) && o.side === exitSide && isOpen(o.status) && o.status !== 'held',
    )
    const existingTp = exitsHere.find((o) => o.type === 'limit')
    const existingSl = exitsHere.find((o) => o.type === 'stop' || o.type === 'stop_limit')
    const existingTrail = exitsHere.find((o) => o.type === 'trailing_stop')
    if (existingTrail) {
      // an OCO cannot carry a trailing leg — refuse instead of tearing down
      // the user's trailing stop
      return {
        results: [],
        errors: ['Position already has a trailing stop — cancel it first, then attach a plain TP/SL'],
      }
    }
    // cancel the existing plain exits so the reservation frees up; snapshots
    // allow a restore if the rebuild fails (never leave the user worse off)
    const oldExits = [existingTp, existingSl].filter((o): o is TradingOrder => Boolean(o))
    for (const o of oldExits) {
      const c = await cancelOrder(userId, mode, o.id)
      if (c.status === 204 || c.status === 200 || c.status === 404) continue
      errors.push(`Could not cancel the existing ${o.type} exit: ${c.error || c.status}`)
    }
    if (errors.length > 0) return { results, errors }
    if (oldExits.length > 0) {
      for (const o of oldExits) await waitUntilCanceled(userId, mode, o.id)
      // re-read the position — the freed reservation may change qty_available
      // (only LONG exits are SELL orders that reserve it; a short's
      // qty_available stays "0" no matter what is canceled)
      if (pos.side !== 'short') {
        const pos2 = await tradeFetch<TradingPosition>(userId, mode, `/v2/positions/${encodeURIComponent(tSym)}`)
        if (pos2.data) pos = pos2.data
      }
    }
    // Exit capacity is SIDE-AWARE:
    // - LONG: qty_available (open SELL exits reserve it; "0" = fully reserved)
    // - SHORT: |qty| — exits are BUY orders reserving buying power, never the
    //   position qty (Alpaca reports qty_available "0" for shorts)
    const qtyAvail = pos.side === 'short'
      ? Math.abs(Number.parseFloat(pos.qty) || 0)
      : availOf(pos)
    if (!(qtyAvail > 0)) {
      // something ELSE still reserves the position — restore what we canceled
      for (const o of oldExits) {
        const body = exitBodyFrom(o, {})
        if (body) await post(body)
      }
      return {
        results,
        errors: ['Position has no available qty — another open order is reserving it (restore attempted)'],
      }
    }

    const restoreOld = async () => {
      for (const o of oldExits) {
        const body = exitBodyFrom(o, {})
        if (body) await post(body)
      }
    }

    // Adding ONE leg while the SIBLING exists must rebuild BOTH as a single
    // OCO: separate legs can never coexist (qty reservation), and canceling
    // the old exit without re-placing it would strip the protection it
    // provided (the "+SL removed my TP" bug). The sibling price comes from
    // the canceled snapshot.
    const sibTp = existingTp ? parseFloat(existingTp.limit_price || '') : NaN
    const sibSl = existingSl ? parseFloat(existingSl.stop_price || '') : NaN
    const tpPx = hasTp ? exits.tp! : Number.isFinite(sibTp) ? sibTp : undefined
    const slPx = hasSl ? exits.sl! : Number.isFinite(sibSl) ? sibSl : undefined

    if (tpPx != null && slPx != null) {
      const r = await post({
        symbol: orderSymbol,
        qty: String(qtyAvail),
        side: exitSide,
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: fmtPx(tpPx),
        order_class: 'oco',
        take_profit: { limit_price: fmtPx(tpPx) },
        stop_loss: { stop_price: fmtPx(slPx) },
      })
      if (r.data && (r.data as TradingOrder).id) {
        return { results: [r.data], errors, oco: true }
      }
      await restoreOld()
      errors.push(`OCO rejected: ${r.error || 'failed'}`)
      return { results, errors }
    }
    if (tpPx != null) {
      const r = await post({
        symbol: orderSymbol, qty: String(qtyAvail), side: exitSide, type: 'limit',
        time_in_force: 'gtc', limit_price: fmtPx(tpPx),
      })
      if (r.data && (r.data as TradingOrder).id) results.push(r.data)
      else {
        await restoreOld()
        errors.push(`TP: ${r.error || 'failed'}`)
      }
    } else if (slPx != null) {
      const r = await post({
        symbol: orderSymbol, qty: String(qtyAvail), side: exitSide, type: 'stop',
        time_in_force: 'gtc', stop_price: fmtPx(slPx),
      })
      if (r.data && (r.data as TradingOrder).id) results.push(r.data)
      else {
        await restoreOld()
        errors.push(`SL: ${r.error || 'failed'}`)
      }
    }
    return { results, errors }
  }

  // ---- crypto: emulated split legs (balance is reserved per open sell) ----
  // Each attached leg takes HALF the position (the two legs together cover
  // it), capped by what is still available — Alpaca reserves every open sell
  // against qty_available, so a full-size first leg would make attaching the
  // second one impossible (502 insufficient balance). Legs may be attached
  // independently in any order.
  const legQty = (n: number) => String(parseFloat((n * 0.99).toFixed(8)))
  // shorts would carry a negative qty — Alpaca crypto is long-only, but stay
  // defensive: capacity is |qty| clamped by what is still unreserved
  const qtyAvail = Math.abs(availOf(pos))
  const posQty = Math.abs(Number.parseFloat(pos.qty) || 0) || qtyAvail
  const qty = legQty(Math.max(0, Math.min(qtyAvail, posQty / 2)))
  if (!(parseFloat(qty) > 0)) {
    return { results, errors: ['Position has no available qty — open exit orders reserve the balance'] }
  }
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
