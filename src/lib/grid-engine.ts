// Grid Trading engine (Task 9-q) — long spot grid bot with one-sided modes.
//
// ONE module-level interval (5s) drives every active grid: each tick re-reads
// ALL status 'active' rows from the DB (the DB is the single source of truth —
// the same model as algo-engine.ts) and evaluates them SEQUENTIALLY, so a
// restart auto-resumes every active grid and one failing grid can never kill
// the loop.
//
// Mechanics (per evaluation with current price P and persisted lastPrice L):
//   • guards FIRST: whole-grid circuit breakers — triggers resolved EVERY tick
//     via resolveGuards() (Task 10-a: basis 'price' = absolute maxSL/maxTP,
//     basis 'percent' = lowerPrice×(1−maxSL/100) / upperPrice×(1+maxTP/100)).
//     Task 10-g: direction 'sell' MIRRORS the triggers + firing conditions
//     (short SL = above upper fires on P >= trigger, short TP = below lower
//     fires on P <= trigger).
//     P <= slTrigger → close all + stop · P >= tpTrigger → close all + stop
//   • BUY: level i crossed DOWNWARD this tick (L > level[i] >= P) and no open
//     lot exists at that level → market buy qtyPerGrid
//   • SELL (per-lot TP, 'both' only): the lot bought at level i targets
//     level[i+1] (or upperPrice for the last level) — crossed UPWARD this tick
//     → market sell the lot, realized pnl = (sellPrice − entryPrice) × qty
//   • 'buy' grids skip every sell; 'sell' grids skip every buy and instead
//     SELL one lot per UPWARD-crossed level (short ladder, tracked inverted —
//     a close buys the lots back)
//   • the first evaluation after start only SEEDS lastPrice (no trades)
//   • state (levels + open lots + lastPrice) is persisted after EVERY
//     evaluation — crash-safe
//
// Orders go through the same paper-broker pipeline as manual/algo orders
// (placeOrderWithExits in trading.ts); fill records use the order's average
// fill price when the broker reports one, else the level price.
//
// v1.80.4 — RTH-only ORDER gate for STOCK grids (crypto trades 24/7 and is
// never gated): Alpaca REJECTS market orders outside the regular session
// (09:30–16:00 ET, Mon–Fri), and every rejection is an engine failure — a
// stock grid left running overnight used to accumulate a fail-streak and
// park itself as 'error' (or strand lots via a failed guard close). When
// gated: TP sells + level entries are SKIPPED (a crossing during closed
// hours is dropped, not queued — lastPrice keeps tracking so no stale burst
// fires at the open) and the SL/TP guards DEFER (an attempted close would
// fail the same way; the grid stays active and the close fires on the first
// RTH tick if the trigger still holds — static exposure overnight since
// entries are gated too). Manual stops are NEVER gated — user intent wins.
//
// v1.80.8 — quote integrity (the "actual SL is smaller" bug): a transient
// Alpaca DATA-feed failure used to fall through to the price SIMULATOR, and
// the engine fired Max SL on a simulated AAPL quote (~34% under the market),
// closing lots at 228.82 while the broker really filled 342.95. Three layers:
//   1. getQuotes({ trading: true }) — engines NEVER receive simulator prices;
//      a missing real quote DEFERS the grid (no orders, no fail-count).
//   2. Quote sanity gate in evaluateGrid — a >12% single-tick jump vs the
//     last trusted price is deferred; two agreeing suspect ticks (~10s) pass
//     a real crash through. A stale lastPrice (>120s) seeds without trading.
//   3. placeGridMarketOrder polls the broker for the REAL average fill —
//     the reference price is only ever recorded flagged as ESTIMATED.
//
// v1.81.1 — position-sized closes (the "CLOSE FAILED: insufficient balance
// for ETH (requested: 0.7, available: 0.698249999)" bug): crypto fees are
// deducted from the RECEIVED base asset on every buy, so the broker balance
// sits slightly BELOW the tracked lots sum and a full-size close 403s,
// parking the grid as 'error' with lots stuck forever. Three layers:
//   1. closeAndStop sizes the close from the LIVE broker position —
//      min(tracked lots, held) — never overselling the balance nor the
//      grid's own size; a zero/missing position clears the tracked lots
//      honestly instead of erroring.
//   2. ERROR grids can be stopped again — Stop retries the failed close
//      (one click recovery instead of a dead row).
//   3. Per-lot TP sells ('both' grids) are capped by the live balance too —
//      the LAST lot's TP used to 403 on the accumulated fee shortfall.
import { db } from '@/lib/db'
import { getQuotes } from '@/lib/alpaca'
import { getPositionForSymbol, placeOrderWithExits, pollOrderFillPrice, type TradeMode } from '@/lib/trading'
import { isRegularSession } from '@/lib/sessions'

/** Task 89 — the PINNED trade mode of a bot row (default for legacy rows:
 *  'paper' — the only mode every creation path ever allowed). */
const gridModeOf = (m: string | null | undefined): TradeMode => (m === 'live' ? 'live' : 'paper')

const GRID_CYCLE_MS = 5000
const MIN_GRID_COUNT = 2
const MAX_GRID_COUNT = 100
/** consecutive hard failures before a grid is parked as 'error' */
const MAX_CONSECUTIVE_FAILURES = 5

// Task 89 — sizing ceilings. The validator previously checked only qty > 0,
// so qtyPerGrid=1e9 passed every creation path (broker buying power was the
// only backstop). These are hard server-side caps for a personal terminal:
// qty per level, and the WORST-CASE deployment (every level filled at the
// upper price) — the number that actually hits the account in a crash.
export const MAX_QTY_PER_GRID = 1_000_000
export const MAX_GRID_NOTIONAL_USD = 10_000_000

export type GridSpacing = 'arithmetic' | 'geometric'

export function isGridSpacing(v: unknown): v is GridSpacing {
  return v === 'arithmetic' || v === 'geometric'
}

/** Task 10-g — grid direction:
 *  'both' — classic long grid: buy dips to a level, per-lot TP at the next
 *           level up (the pre-10-g behavior).
 *  'buy'  — ladder-accumulate: buy each level as price falls, NO auto-sells.
 *           Lots are marked to market; exits are Max TP / guard / manual stop.
 *  'sell' — distribution / short ladder: SELL one lot per level as price RISES
 *           (on stocks Alpaca nets the sale against held shares or opens a
 *           short). Lots are tracked inverted (mark = entry − price) and a
 *           close (closeOnStop / guard) BUYS them back. Guards MIRROR:
 *           SL sits ABOVE the upper bound, TP BELOW the lower bound.
 */
export type GridDirection = 'both' | 'buy' | 'sell'

export function isGridDirection(v: unknown): v is GridDirection {
  return v === 'both' || v === 'buy' || v === 'sell'
}

export const GRID_DIRECTIONS: readonly GridDirection[] = ['both', 'buy', 'sell']

/** Open lot working memory (persisted inside GridTrade.state). */
export interface GridLot {
  levelIndex: number
  qty: number
  entryPrice: number
}

/** single-tick price deviation (vs the last trusted price) that marks a quote
 *  as suspect — a real crash confirms itself on the next tick(s) instead */
export const QUOTE_JUMP_PCT = 0.12
/** lastPrice older than this is STALE — the next tick is a seed tick only */
export const PRICE_STALE_MS = 120_000

/** GridTrade.state Json shape — survives restarts. */
export interface GridState {
  levels: number[]
  lastPrice: number | null
  /** unix ms — when lastPrice was accepted (staleness seed ticks) */
  lastPriceAt?: number
  lots: GridLot[]
  /** consecutive hard evaluation failures (reset on any success) */
  failCount?: number
  /** last hard-failure message (surfaced in the error stopReason) */
  lastError?: string
  /** v1.80.8 sanity gate — consecutive suspect quotes + the observed price */
  suspect?: number
  suspectPx?: number
}

export function parseGridState(raw: unknown): GridState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<GridState>
  const levels = Array.isArray(s.levels) ? s.levels.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0) : []
  const lots = Array.isArray(s.lots)
    ? s.lots
        .filter((l): l is GridLot => !!l && typeof l === 'object' && typeof (l as GridLot).levelIndex === 'number' && typeof (l as GridLot).qty === 'number' && typeof (l as GridLot).entryPrice === 'number')
        .map((l) => ({ levelIndex: l.levelIndex, qty: l.qty, entryPrice: l.entryPrice }))
    : []
  return {
    levels,
    lastPrice: typeof s.lastPrice === 'number' && Number.isFinite(s.lastPrice) ? s.lastPrice : null,
    lastPriceAt: typeof s.lastPriceAt === 'number' && Number.isFinite(s.lastPriceAt) ? s.lastPriceAt : undefined,
    lots,
    failCount: typeof s.failCount === 'number' ? s.failCount : 0,
    lastError: typeof s.lastError === 'string' ? s.lastError : undefined,
    suspect: typeof s.suspect === 'number' && Number.isFinite(s.suspect) ? s.suspect : 0,
    suspectPx: typeof s.suspectPx === 'number' && Number.isFinite(s.suspectPx) ? s.suspectPx : undefined,
  }
}

// ---------- guard resolution (Task 10-a) ----------

/**
 * Resolve the whole-grid guard triggers from the configured values + basis.
 *   basis 'percent': slTrigger = lowerPrice × (1 − maxSL/100) — a percent drop
 *                    BELOW the range floor · tpTrigger = upperPrice ×
 *                    (1 + maxTP/100) — a percent rise ABOVE the range ceiling.
 *   basis 'price' (or null/unknown basis): the configured values ARE the
 *   absolute-price triggers (legacy behavior).
 * The ENGINE calls this EVERY tick and the backtest per run, so a later config
 * edit (PUT /api/grid/[id]) re-resolves the triggers automatically — no engine
 * restart, no stale absolute price.
 */
export function resolveGuards(g: {
  maxSL: number | null
  maxTP: number | null
  slBasis: string | null
  tpBasis: string | null
  lowerPrice: number
  upperPrice: number
  /** Task 10-g — 'sell' mirrors both triggers to the short side */
  direction?: string | null
}): { slTrigger: number | null; tpTrigger: number | null } {
  const sell = g.direction === 'sell'
  const slTrigger = g.maxSL != null
    ? (g.slBasis === 'percent' && g.maxSL > 0
        ? (sell ? g.upperPrice * (1 + g.maxSL / 100) : g.lowerPrice * (1 - g.maxSL / 100))
        : g.maxSL)
    : null
  const tpTrigger = g.maxTP != null
    ? (g.tpBasis === 'percent' && g.maxTP > 0
        ? (sell ? g.lowerPrice * (1 - g.maxTP / 100) : g.upperPrice * (1 + g.maxTP / 100))
        : g.maxTP)
    : null
  return { slTrigger, tpTrigger }
}

const fmtP = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4))
const fmtPct = (n: number) => String(Math.round(n * 100) / 100)
/** qty for messages/notes — trims float noise without losing real precision
 *  (0.6982499990000001 -> 0.698249999, 0.7 stays 0.7) */
const fmtQty = (n: number) => String(Number.parseFloat(n.toPrecision(10)))

/**
 * v1.81.1 — the close qty: min(tracked lots, what the broker ACTUALLY holds).
 * `held` null = position unknown (fetch failed / no keys) — don't clamp (the
 * broker rejects an oversell; a data hiccup must never shrink an exit).
 * Crypto is FLOOR-quantized to 8dp (toFixed ROUNDS — 0.698249999 would round
 * UP to 0.69825, over-requesting the exact balance that caused the incident);
 * stocks trade whole shares (trading.ts floors entries).
 */
export function sizeCloseQty(tracked: number, held: number | null, isCrypto: boolean): number {
  let q = tracked
  if (held != null && Number.isFinite(held) && held >= 0 && held < tracked) q = held
  if (!isCrypto) return Math.floor(q)
  return Math.floor(Math.floor(q * 1e8) / 1e8 * 1e8) / 1e8
}

/** Guard stop message — includes the percent for percent-basis guards and the
 *  price at which the guard fired (the live price for the engine, the resolved
 *  trigger for the backtest close). Same stems the engine has always used. */
export function guardStopText(kind: 'sl' | 'maxtp', basis: string | null, value: number, price: number): string {
  const pct = basis === 'percent' && value > 0 ? ` ${fmtPct(value)}%` : ''
  return kind === 'sl' ? `Max SL${pct} hit at ${fmtP(price)}` : `Max TP${pct} reached at ${fmtP(price)}`
}

// ---------- shared config validation (Task 10-a) ----------

/**
 * Validate a FULL grid config — ONE source of truth shared by POST /api/grid,
 * PUT /api/grid/[id] and POST /api/grid/backtest so the three can never drift.
 * Basis-aware guards: 'price' keeps the legacy strict ordering 400s (maxSL
 * below the range, maxTP above it); 'percent' requires 0 < maxSL ≤ 90 and
 * 0 < maxTP ≤ 1000. Returns null when valid, else a user-facing 400 message.
 */
export function validateGridConfig(c: {
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: string
  qtyPerGrid: number
  maxSL: number | null
  maxTP: number | null
  slBasis: string | null
  tpBasis: string | null
  isCrypto: boolean
  /** Task 10-g — absent/null reads as 'both'; an unknown string 400s */
  direction?: string | null
}): string | null {
  if (!Number.isFinite(c.lowerPrice) || c.lowerPrice <= 0) return 'Lower price must be a positive number'
  if (!Number.isFinite(c.upperPrice) || c.upperPrice <= c.lowerPrice) return 'Upper price must be greater than the lower price'
  if (c.direction != null && !isGridDirection(c.direction)) return 'direction must be "both", "buy" or "sell"'
  if (!Number.isInteger(c.gridCount) || c.gridCount < MIN_GRID_COUNT || c.gridCount > MAX_GRID_COUNT) {
    return `Grid count must be an integer between ${MIN_GRID_COUNT} and ${MAX_GRID_COUNT}`
  }
  if (!isGridSpacing(c.spacing)) return 'Invalid spacing'
  if (!Number.isFinite(c.qtyPerGrid) || c.qtyPerGrid <= 0) return 'Quantity per grid must be a positive number'
  if (c.qtyPerGrid > MAX_QTY_PER_GRID) return `Quantity per grid must be at most ${MAX_QTY_PER_GRID}`
  // Task 89 — worst-case notional: EVERY level filled at the upper price.
  if (c.qtyPerGrid * c.gridCount * c.upperPrice > MAX_GRID_NOTIONAL_USD) {
    const worst = Math.round(c.qtyPerGrid * c.gridCount * c.upperPrice)
    return `Worst-case deployment ($${worst.toLocaleString('en-US')} = qty × ${c.gridCount} levels × ${fmtP(c.upperPrice)}) exceeds the $${(MAX_GRID_NOTIONAL_USD / 1e6).toFixed(0)}M safety cap — reduce the quantity, the level count, or the range`
  }
  // stocks are floored to whole shares by the broker pipeline (trading.ts) —
  // a fractional stock grid could never fill
  if (!c.isCrypto && c.qtyPerGrid < 1) {
    return 'Stocks require a whole-number quantity per grid (min 1) — crypto supports fractional sizes'
  }
  // guard ordering mirrors for the sell-only (short-ladder) direction:
  // SL is the hard CEILING above upper, TP the profit FLOOR below lower
  const sell = c.direction === 'sell'
  if (c.maxSL != null) {
    if (!Number.isFinite(c.maxSL)) return 'Max SL must be a valid number'
    if ((c.slBasis ?? 'price') === 'percent') {
      if (!(c.maxSL > 0) || c.maxSL > 90) return 'Max SL percent must be greater than 0 and at most 90'
    } else {
      if (c.maxSL <= 0) return 'Max SL must be a positive price'
      if (sell
        ? c.maxSL <= c.upperPrice
        : c.maxSL >= c.lowerPrice)
        return sell
          ? 'Max SL must be ABOVE the upper price (sell-only grid — it is the whole-grid hard ceiling)'
          : 'Max SL must be BELOW the lower price (it is the whole-grid hard floor)'
    }
  }
  if (c.maxTP != null) {
    if (!Number.isFinite(c.maxTP)) return 'Max TP must be a valid number'
    if ((c.tpBasis ?? 'price') === 'percent') {
      if (!(c.maxTP > 0) || c.maxTP > 1000) return 'Max TP percent must be greater than 0 and at most 1000'
    } else {
      if (c.maxTP <= 0) return 'Max TP must be a positive price'
      if (sell
        ? c.maxTP >= c.lowerPrice
        : c.maxTP <= c.upperPrice)
        return sell
          ? 'Max TP must be BELOW the lower price (sell-only grid — it is the whole-grid profit floor)'
          : 'Max TP must be ABOVE the upper price (it is the whole-grid profit ceiling)'
    }
  }
  return null
}

/**
 * The grid levels: exactly `count` prices from `lower` to `upper` inclusive.
 * arithmetic — even step (upper−lower)/(count−1) · geometric — equal ratio
 * (upper/lower)^(1/(count−1)). Throws a user-facing message on bad input.
 */
export function computeLevels(lowerPrice: number, upperPrice: number, gridCount: number, spacing: GridSpacing): number[] {
  if (!Number.isFinite(lowerPrice) || lowerPrice <= 0) throw new Error('Lower price must be a positive number')
  if (!Number.isFinite(upperPrice) || upperPrice <= lowerPrice) throw new Error('Upper price must be greater than the lower price')
  if (!Number.isInteger(gridCount) || gridCount < MIN_GRID_COUNT || gridCount > MAX_GRID_COUNT) {
    throw new Error(`Grid count must be an integer between ${MIN_GRID_COUNT} and ${MAX_GRID_COUNT}`)
  }
  const levels: number[] = []
  if (spacing === 'geometric') {
    const ratio = Math.pow(upperPrice / lowerPrice, 1 / (gridCount - 1))
    for (let i = 0; i < gridCount; i++) levels.push(i === gridCount - 1 ? upperPrice : lowerPrice * Math.pow(ratio, i))
  } else {
    const step = (upperPrice - lowerPrice) / (gridCount - 1)
    for (let i = 0; i < gridCount; i++) levels.push(i === gridCount - 1 ? upperPrice : lowerPrice + step * i)
  }
  return levels
}

// ---------- stats (shared by the API routes) ----------

export interface GridFillLike {
  side: string
  reason: string
  levelIndex: number
  price: number
  qty: number
  pnl: number | null
}

export interface GridRowLike {
  id: string
  symbol: string
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: string
  qtyPerGrid: number
  status: string
  realizedPnl: number
  state: unknown
  startedAt: Date
  stoppedAt: Date | null
  /** Task 10-g — absent (pre-10-g rows) reads as 'both' */
  direction?: string | null
}

export interface GridStats {
  fillsCount: number
  buys: number
  sells: number
  openLots: number
  openQty: number
  /** market value of the open lots at the last known price (null when unknown) */
  openNotional: number | null
  realizedPnl: number
  unrealizedPnl: number | null
  totalPnl: number | null
  durationSec: number
  currentPrice: number | null
  /** % of sell fills with positive realized pnl (null when no sells yet) */
  winRate: number | null
  bestLevel: { levelIndex: number; pnl: number } | null
  worstLevel: { levelIndex: number; pnl: number } | null
  levels: number[]
}

/** Build the display/statistics payload for a grid row from its fills. */
export function computeGridStats(grid: GridRowLike, fills: GridFillLike[]): GridStats {
  const st = parseGridState(grid.state)
  const buys = fills.filter((f) => f.side === 'buy').length
  const sells = fills.filter((f) => f.side === 'sell').length
  const sellsWpnl = fills.filter((f) => f.side === 'sell' && typeof f.pnl === 'number')
  const wins = sellsWpnl.filter((f) => (f.pnl ?? 0) > 0).length
  // per-level realized pnl (buys carry no pnl; the last level of a closed
  // batch can carry the combined pnl of several lots)
  const byLevel = new Map<number, number>()
  for (const f of fills) {
    if (typeof f.pnl !== 'number') continue
    byLevel.set(f.levelIndex, (byLevel.get(f.levelIndex) ?? 0) + f.pnl)
  }
  let best: GridStats['bestLevel'] = null
  let worst: GridStats['worstLevel'] = null
  for (const [levelIndex, pnl] of byLevel) {
    if (!best || pnl > best.pnl) best = { levelIndex, pnl }
    if (!worst || pnl < worst.pnl) worst = { levelIndex, pnl }
  }
  const openQty = st.lots.reduce((acc, l) => acc + l.qty, 0)
  const px = st.lastPrice
  // sell-only grids hold SHORT lots — mark (entry − price), inverted vs long
  const short = grid.direction === 'sell'
  const unrealized = px != null
    ? st.lots.reduce((acc, l) => acc + (short ? (l.entryPrice - px) : (px - l.entryPrice)) * l.qty, 0)
    : null
  const end = grid.stoppedAt ?? new Date()
  return {
    fillsCount: fills.length,
    buys,
    sells,
    openLots: st.lots.length,
    openQty,
    openNotional: px != null ? openQty * px : null,
    realizedPnl: grid.realizedPnl,
    unrealizedPnl: unrealized,
    totalPnl: unrealized != null ? grid.realizedPnl + unrealized : null,
    durationSec: Math.max(0, Math.floor((end.getTime() - grid.startedAt.getTime()) / 1000)),
    currentPrice: px,
    winRate: sellsWpnl.length > 0 ? (wins / sellsWpnl.length) * 100 : null,
    bestLevel: best,
    worstLevel: worst,
    levels: st.levels,
  }
}

// ---------- order plumbing ----------

interface OrderOutcome {
  ok: true
  price: number
  orderId: string
  /** true when the broker never reported a fill and the reference price was
   *  recorded — the fill note says so (honesty over false precision) */
  estimated?: boolean
}
interface OrderFail {
  ok: false
  error: string
}

/** Market order through the SAME pipeline as manual/algo orders. Fill price
 *  = the broker's average fill price — polled for when the placement response
 *  lands before the fill does (market orders usually do) — else `fallbackPrice`
 *  flagged estimated. v1.80.8: the old code recorded the fallback AS the fill,
 *  which is how a transient simulator quote (228.82) got written into the
 *  fill history while the broker actually filled at 342.95. */
async function placeGridMarketOrder(
  userId: string,
  mode: TradeMode,
  gridId: string,
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  fallbackPrice: number,
): Promise<OrderOutcome | OrderFail> {
  if (!(qty > 0)) return { ok: false, error: 'quantity rounds to 0' }
  try {
    const r = await placeOrderWithExits(userId, mode, {
      symbol,
      side,
      qty,
      type: 'market',
      // tag with the grid id prefix so positions/history attribute these as
      // 'grid' (Task 10-k: ttg- client_order_id — works even without TP/SL,
      // which grid market orders never carry)
      sourceRef: gridId.slice(0, 8),
      sourceKind: 'grid',
    })
    if (r.results.length === 0) return { ok: false, error: r.errors[0] || 'order rejected' }
    const o = r.results[0]
    let fp = Number(o.filled_avg_price)
    let estimated = false
    if (!(Number.isFinite(fp) && fp > 0)) {
      const polled = await pollOrderFillPrice(userId, mode, o.id)
      if (polled != null) {
        fp = polled
      } else {
        fp = fallbackPrice
        estimated = true
      }
    }
    return { ok: true, price: Number.isFinite(fp) && fp > 0 ? fp : fallbackPrice, orderId: o.id, estimated }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'order failed' }
  }
}

/** Stocks must trade whole quantities (trading.ts floors) — mirror that here
 *  so fill records carry the ACTUAL order size. */
function effectiveQty(symbol: string, qtyPerGrid: number): number {
  return symbol.includes('/') ? qtyPerGrid : Math.floor(qtyPerGrid)
}

// ---------- stop / close ----------

/**
 * Close every open lot with ONE combined market order (when closeOnStop) and
 * park the grid. Race-safe: the stop is CLAIMED with a conditional updateMany
 * on status 'active' — only the claimant closes (engine guard vs manual stop
 * vs concurrent cycle can never double-close).
 *
 * v1.81.1 — the close qty is sized from the LIVE broker position
 * (min(tracked lots, held)), not from the tracked sum: crypto fees are
 * deducted from the received base asset, so the balance sits below the
 * tracked lots and a full-size close used to 403 ("insufficient balance for
 * ETH (requested: 0.7, available: 0.698249999)"). The claim also covers
 * status 'error' — stopping an error grid RETRIES the failed close.
 */
async function closeAndStop(
  grid: {
    id: string
    userId: string
    symbol: string
    closeOnStop: boolean
    state: unknown
    /** Task 10-g — 'sell' grids hold short lots: the close BUYS them back */
    direction?: string | null
    /** Task 89 — pinned Alpaca account (legacy rows: 'paper') */
    mode?: string | null
    /** prior stopReason — an error row acknowledged without lots keeps its history */
    stopReason?: string | null
  },
  reason: 'sl' | 'maxtp' | 'manual_close' | 'auto_end',
  price: number | null,
  reasonText: string,
): Promise<void> {
  // claim: only one caller wins the active/paused/error → stopped transition
  // (a SUSPENDED grid can still be stopped — Task 18 — its lots close as-is;
  // an ERROR grid stops too — v1.81.1: that IS the retry path after a failed
  // close, with the qty now sized from the live balance)
  const claimed = await db.gridTrade.updateMany({
    where: { id: grid.id, status: { in: ['active', 'paused', 'error'] } },
    data: { status: 'stopped', stoppedAt: new Date() },
  })
  if (claimed.count === 0) return // already stopped elsewhere

  const st = parseGridState(grid.state)
  const px = price ?? st.lastPrice ?? null
  let stopReason = reasonText

  if (st.lots.length > 0) {
    if (grid.closeOnStop && px != null) {
      // Task 89 — the close hits the grid's PINNED account, never the user's
      // current tradeMode: closing on the wrong broker used to either strand
      // the real position ("no broker position — lots cleared") or 403.
      const mode = gridModeOf(grid.mode)
      const short = grid.direction === 'sell'
      const closeSide: 'buy' | 'sell' = short ? 'buy' : 'sell'
      const tracked = st.lots.reduce((acc, l) => acc + l.qty, 0)
      // LIVE position: a long close sells qty_available (open sell exits
      // reserve it); a short buy-back covers |qty| (the net short — buying
      // more would flip the user long). null (fetch failed / no keys) does
      // NOT clamp — the broker rejects an oversell, honesty over guessing.
      const pos = await getPositionForSymbol(grid.userId, mode, grid.symbol).catch(() => null)
      const held = pos
        ? (closeSide === 'sell'
            ? (Number.isFinite(pos.qtyAvailable) ? pos.qtyAvailable : pos.qty)
            : Math.abs(pos.qty))
        : null
      const closeQty = sizeCloseQty(tracked, held, grid.symbol.includes('/'))
      const cappedNote = closeQty < tracked - 1e-8
        ? ` — broker balance is lower than the tracked lots (closed ${fmtQty(closeQty)} of ${fmtQty(tracked)}; fees / partial fills / manual sells)`
        : ''

      if (!(closeQty > 0)) {
        // nothing actually held — the position was closed elsewhere (manually
        // or by reserved exits). Clear the tracked lots honestly instead of
        // ordering a doomed 0-qty close and parking the grid as 'error'.
        await db.gridTrade.update({
          where: { id: grid.id },
          data: {
            stopReason: `${stopReason} — no broker position on ${grid.symbol} (closed elsewhere) — open lots cleared`,
            state: { ...st, lastPrice: px, lastPriceAt: Date.now(), lots: [], failCount: 0 } as unknown as object,
          },
        })
        return
      }

      const r = await placeGridMarketOrder(grid.userId, mode, grid.id, grid.symbol, closeSide, closeQty, px)
      if (r.ok) {
        // pro-rata realized pnl on what was ACTUALLY closed (weighted avg
        // entry × the qty the broker accepted) — when the balance shortfall
        // ate part of the lots, pnl must not claim the unsold remainder
        const avgEntry = tracked > 0 ? st.lots.reduce((acc, l) => acc + l.entryPrice * l.qty, 0) / tracked : 0
        const pnl = (short ? avgEntry - r.price : r.price - avgEntry) * closeQty
        const levelList = [...new Set(st.lots.map((l) => l.levelIndex))].sort((a, b) => a - b).join(',')
        const estNote = r.estimated ? ' — fill ESTIMATED (broker had not reported its average fill)' : ''
        await db.gridFill.create({
          data: {
            gridTradeId: grid.id,
            userId: grid.userId,
            levelIndex: -1, // combined close spans several levels — see note
            side: closeSide,
            reason,
            price: r.price,
            qty: closeQty,
            pnl,
            orderId: r.orderId,
            note: short
              ? `bought back open grid lots (levels ${levelList})${estNote}`
              : `closed open grid lots (levels ${levelList})${estNote}`,
          },
        })
        await db.gridTrade.update({
          where: { id: grid.id },
          data: {
            // atomic increment — a concurrent cycle fill can never be clobbered
            realizedPnl: { increment: pnl },
            stopReason: `${stopReason} — closed ${st.lots.length} lot(s) at ${fmtP(r.price)}${cappedNote}${estNote}`,
            state: { ...st, lastPrice: px, lastPriceAt: Date.now(), lots: [], failCount: 0 } as unknown as object,
          },
        })
        return
      }
      // close order failed — be honest: error status, lots untouched, and the
      // retry is ONE CLICK away (Stop on an error grid re-attempts the close
      // with the qty re-sized from the live balance)
      await db.gridTrade.update({
        where: { id: grid.id },
        data: {
          status: 'error',
          stopReason: `${stopReason} — CLOSE FAILED: ${r.error}. Open lots left untouched — press Stop again to retry (the close qty is sized from the live balance).`,
          state: { ...st, lastPrice: px, failCount: 0 } as unknown as object,
        },
      })
      return
    }
    if (!grid.closeOnStop) {
      stopReason += ' — open grid positions left running (close-on-stop disabled)'
    } else {
      stopReason += ' — open grid positions left running (no live price to close at)'
    }
  } else if (grid.stopReason) {
    // no lots to close (an error row parked for a non-close reason, e.g.
    // engine failures) — keep the ORIGINAL reason when acknowledging the stop
    stopReason += ` — ${grid.stopReason}`
  }
  await db.gridTrade.update({
    where: { id: grid.id },
    data: {
      stopReason,
      state: { ...st, lastPrice: px, failCount: 0 } as unknown as object,
    },
  })
}

/** Manual stop (Grid tab button). Returns false when the grid is not owned.
 *  Paused grids stop too (Task 18) — the claim covers active + paused.
 *  v1.81.1 — ERROR grids stop too: the claim retries the previously FAILED
 *  close (sized from the live balance) instead of leaving the lots stuck. */
export async function stopGridTrade(userId: string, gridId: string, opts?: { reason?: 'manual_close' }): Promise<boolean> {
  const grid = await db.gridTrade.findFirst({ where: { id: gridId, userId } })
  if (!grid) return false
  if (grid.status === 'stopped') return true // already stopped — idempotent
  const st = parseGridState(grid.state)
  let price: number | null = st.lastPrice
  try {
    // trading:true — a manual close is an ORDER decision; a transient data
    // failure must fall back to the state's last REAL price, never a sim quote
    const { quotes } = await getQuotes([grid.symbol], userId, { trading: true })
    const q = quotes.find((x) => x.symbol === grid.symbol)
    if (q && Number.isFinite(q.price) && q.price > 0) price = q.price
  } catch { /* fall back to the state's lastPrice */ }
  const reasonText = grid.status === 'error'
    ? 'Stopped manually — retrying close after a previous CLOSE FAILED'
    : 'Stopped manually'
  await closeAndStop(grid, opts?.reason ?? 'manual_close', price, reasonText)
  return true
}

// ---------- evaluation ----------

/** How the lot of the level-i buy is paid: the NEXT level up (upper edge for the top level). */
function sellTargetOf(levels: number[], levelIndex: number, upperPrice: number): number {
  return levels[levelIndex + 1] ?? upperPrice
}

/** Fresh status re-check before each order — a stop (guard or manual) that
 *  landed mid-tick must not be followed by more orders. */
async function stillActive(gridId: string): Promise<boolean> {
  const row = await db.gridTrade.findUnique({ where: { id: gridId }, select: { status: true } })
  return row?.status === 'active'
}

async function evaluateGrid(grid: {
  id: string
  userId: string
  symbol: string
  lowerPrice: number
  upperPrice: number
  qtyPerGrid: number
  maxSL: number | null
  maxTP: number | null
  slBasis: string | null
  tpBasis: string | null
  closeOnStop: boolean
  realizedPnl: number
  state: unknown
  /** Task 10-g — absent reads as 'both' */
  direction?: string | null
  /** Task 89 — pinned Alpaca account (legacy rows: 'paper') */
  mode?: string | null
  /** Task 18 — planned end: the engine force-stops the grid at this time */
  autoEndAt?: Date | null
}, price: number): Promise<void> {
  const st = parseGridState(grid.state)
  const levels = st.levels
  if (levels.length < 2) {
    // corrupted state — park the grid honestly (never resurrect a stopped row)
    await db.gridTrade.updateMany({
      where: { id: grid.id, status: 'active' },
      data: { status: 'error', stoppedAt: new Date(), stopReason: 'Corrupted grid state (levels missing) — grid parked' },
    })
    return
  }
  const sellGrid = grid.direction === 'sell'
  const buyOnly = grid.direction === 'buy'

  // ---- quote sanity gate (v1.80.8 — the 228.82 incident) ----
  // getQuotes({ trading }) already guarantees keyed engines never see
  // simulator fallbacks; this is the second line of defense against a bad
  // tape print or a stale lastPrice after downtime. A trading decision may
  // only run on a price that is plausible against the last TRUSTED price:
  //   • lastPrice older than PRICE_STALE_MS → SEED tick: accept the quote,
  //     trade nothing (the restart rule — a compressed crossing burst would
  //     otherwise fire every level between the stale and current price)
  //   • fresh lastPrice + |Δ| > QUOTE_JUMP_PCT → suspect tick: defer. If two
  //     consecutive suspect quotes AGREE (within 2%) it was a real crash —
  //     accept and evaluate normally (~10s reaction, not a false close).
  const nowMs = Date.now()
  if (st.lastPrice != null) {
    const fresh = typeof st.lastPriceAt === 'number' && nowMs - st.lastPriceAt < PRICE_STALE_MS
    if (!fresh) {
      await db.gridTrade.updateMany({
        where: { id: grid.id, status: 'active' },
        data: {
          state: {
            ...st, lastPrice: price, lastPriceAt: nowMs, suspect: 0, suspectPx: undefined, failCount: 0,
          } as unknown as object,
        },
      })
      return
    }
    const dev = Math.abs(price / st.lastPrice - 1)
    if (dev > QUOTE_JUMP_PCT) {
      const agree = (st.suspect ?? 0) > 0
        && typeof st.suspectPx === 'number'
        && Math.abs(price / st.suspectPx - 1) < 0.02
      if (!agree) {
        const suspectCount = (st.suspect ?? 0) + 1
        await db.gridTrade.updateMany({
          where: { id: grid.id, status: 'active' },
          data: {
            state: {
              ...st,
              suspect: suspectCount,
              suspectPx: price,
              lastError: `Quote sanity gate: ${fmtP(price)} is ${(dev * 100).toFixed(1)}% from the last trusted ${fmtP(st.lastPrice)} — tick deferred`,
            } as unknown as object,
          },
        })
        console.warn(`[grid] ${grid.symbol}: suspect quote ${fmtP(price)} (${(dev * 100).toFixed(1)}% vs ${fmtP(st.lastPrice)}) — deferred tick #${suspectCount}`)
        return
      }
      // two independent ticks agree — real move; fall through and trade on it
      console.warn(`[grid] ${grid.symbol}: suspect price confirmed on a second tick (${fmtP(price)}) — accepting`)
    }
  }
  st.suspect = 0
  st.suspectPx = undefined
  st.lastPriceAt = nowMs

  // v1.80.4 — RTH-only order gate: stocks submit ONLY inside the regular
  // session; crypto (symbol contains '/') trades 24/7. See the module header.
  const ordersOpen = grid.symbol.includes('/') || isRegularSession(Math.floor(Date.now() / 1000))

  // ---- guards FIRST (whole-grid circuit breakers) ----
  // Triggers are RESOLVED EVERY TICK (price vs percent basis) so a config edit
  // via PUT /api/grid/[id] re-arms the guards on the next 5s cycle — the DB is
  // the single source of truth, no engine-side cache. Sell-only mirrors the
  // firing conditions (short SL fires ABOVE, TP fires BELOW).
  // Gated ticks DEFER the guards (no closeAndStop): the close is a market
  // order the broker would reject outside RTH, and a failed close strands
  // lots in a parked 'error' grid — deferring keeps the grid active so the
  // close fires at the first RTH tick if the trigger still holds.
  const { slTrigger, tpTrigger } = resolveGuards({
    maxSL: grid.maxSL,
    maxTP: grid.maxTP,
    slBasis: grid.slBasis,
    tpBasis: grid.tpBasis,
    lowerPrice: grid.lowerPrice,
    upperPrice: grid.upperPrice,
    direction: grid.direction,
  })
  if (ordersOpen && slTrigger != null && (sellGrid ? price >= slTrigger : price <= slTrigger)) {
    await closeAndStop(grid, 'sl', price, guardStopText('sl', grid.slBasis, grid.maxSL ?? 0, price))
    return
  }
  if (ordersOpen && tpTrigger != null && (sellGrid ? price <= tpTrigger : price >= tpTrigger)) {
    await closeAndStop(grid, 'maxtp', price, guardStopText('maxtp', grid.tpBasis, grid.maxTP ?? 0, price))
    return
  }

  // ---- planned end (Task 18 — auto grids): due date + orders open → stop now.
  // Same RTH deferral as the guards for stocks: a close market order placed
  // outside the session would be rejected and strand lots in an 'error' grid.
  if (grid.autoEndAt != null && Date.now() >= grid.autoEndAt.getTime()) {
    if (ordersOpen) {
      await closeAndStop(
        grid, 'auto_end', price,
        `Auto grid reached its planned end (started with a ${grid.autoEndAt.toISOString().slice(0, 10)} expiry)`,
      )
      return
    }
    // stock grid outside RTH — keep running; the close fires at the first
    // in-session tick (stopReason stays absent until it actually fires)
  }

  const L = st.lastPrice
  // Task 89 — the grid trades on its PINNED account forever; the user's
  // current Settings → tradeMode can never migrate a running grid.
  const mode = gridModeOf(grid.mode)

  // ---- SELL signals first (free capacity before adding lots) — per-lot TP:
  // the lot bought at level i pays at level[i+1] ?? upperPrice, on an UPWARD
  // crossing of that target this tick. 'both' only — buy-only never sells and
  // sell-only has no buy-backs.
  let sellSkipped = false // a balance-skipped TP must not clear lastError below
  if (!sellGrid && !buyOnly && L != null && ordersOpen) {
    for (const lot of [...st.lots]) {
      const target = sellTargetOf(levels, lot.levelIndex, grid.upperPrice)
      if (!(L < target && price >= target)) continue
      if (!(await stillActive(grid.id))) return // stopped mid-tick — stand down
      // v1.81.1 — cap the per-lot TP sell by the LIVE broker balance: crypto
      // fees are deducted from the RECEIVED base asset on every buy, so the
      // held qty sits slightly below the tracked lot size and the LAST TP
      // sell 403s ("insufficient balance"), failing the whole tick. Sell
      // min(lot, held); a zero balance (closed / reserved elsewhere) keeps
      // the lot tracked and skips the sell instead of parking the grid.
      const pos = await getPositionForSymbol(grid.userId, mode, grid.symbol).catch(() => null)
      const held = pos && pos.side !== 'short'
        ? (Number.isFinite(pos.qtyAvailable) ? pos.qtyAvailable : pos.qty)
        : null
      const sellQty = sizeCloseQty(lot.qty, held, grid.symbol.includes('/'))
      if (!(sellQty > 0)) {
        sellSkipped = true
        st.lastError = `TP sell at ${fmtP(target)} skipped — broker balance for ${grid.symbol} is 0 (closed or reserved elsewhere)`
        continue
      }
      const r = await placeGridMarketOrder(grid.userId, mode, grid.id, grid.symbol, 'sell', sellQty, target)
      if (!r.ok) throw new Error(`TP sell at ${fmtP(target)} failed: ${r.error}`)
      const pnl = (r.price - lot.entryPrice) * sellQty
      st.lots = st.lots.filter((l) => l !== lot)
      await db.gridFill.create({
        data: {
          gridTradeId: grid.id,
          userId: grid.userId,
          levelIndex: lot.levelIndex,
          side: 'sell',
          reason: 'tp',
          price: r.price,
          qty: sellQty,
          pnl,
          orderId: r.orderId,
          note: `grid TP — target level ${fmtP(target)}${sellQty < lot.qty - 1e-8 ? ` — sold ${fmtQty(sellQty)} of ${fmtQty(lot.qty)} (broker balance after fees)` : ''}${r.estimated ? ' — fill ESTIMATED (broker had not reported its average fill)' : ''}`,
        },
      })
      // persist the removed lot + realized pnl IMMEDIATELY (crash-safe: a
      // later failed order in this tick must not re-sell the same lot) —
      // conditional on status so a concurrent stop can't be overwritten
      await db.gridTrade.updateMany({
        where: { id: grid.id, status: 'active' },
        data: {
          state: st as unknown as object,
          realizedPnl: { increment: pnl },
        },
      })
    }
  }

  // ---- level-entry signals (one lot per level) ----
  //   both/buy: level crossed DOWNWARD this tick → market buy qtyPerGrid
  //   sell:     level crossed UPWARD this tick → market sell qtyPerGrid
  //             (short ladder — the lot is tracked inverted; a close buys back)
  // Gated ticks skip entries entirely: a crossing during closed hours is
  // DROPPED (lastPrice tracks below, so nothing stale fires at the open).
  if (L != null && ordersOpen) {
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]
      if (sellGrid) {
        if (!(L < level && price >= level)) continue
      } else {
        if (!(L > level && price <= level)) continue
      }
      if (st.lots.some((l) => l.levelIndex === i)) continue
      if (!(await stillActive(grid.id))) return // stopped mid-tick — stand down
      const qty = effectiveQty(grid.symbol, grid.qtyPerGrid)
      const r = await placeGridMarketOrder(grid.userId, mode, grid.id, grid.symbol, sellGrid ? 'sell' : 'buy', qty, level)
      if (!r.ok) throw new Error(`Grid ${sellGrid ? 'sell' : 'buy'} at ${fmtP(level)} failed: ${r.error}`)
      st.lots.push({ levelIndex: i, qty, entryPrice: r.price })
      await db.gridFill.create({
        data: {
          gridTradeId: grid.id,
          userId: grid.userId,
          levelIndex: i,
          side: sellGrid ? 'sell' : 'buy',
          reason: 'grid',
          price: r.price,
          qty,
          orderId: r.orderId,
          note: sellGrid
            ? `grid level ${i + 1}/${levels.length} at ${fmtP(level)} (sell-only)${r.estimated ? ' — fill ESTIMATED (broker had not reported its average fill)' : ''}`
            : `grid level ${i + 1}/${levels.length} at ${fmtP(level)}${r.estimated ? ' — fill ESTIMATED (broker had not reported its average fill)' : ''}`,
        },
      })
      // persist the new lot IMMEDIATELY (crash-safe: a later failed order in
      // this tick must not re-buy the same level)
      await db.gridTrade.updateMany({ where: { id: grid.id, status: 'active' }, data: { state: st as unknown as object } })
    }
  }

  // ---- persist working memory after EVERY evaluation (crash-safe) —
  // conditional on status so a concurrent stop's state is never clobbered
  st.lastPrice = price
  st.failCount = 0
  if (!sellSkipped) st.lastError = undefined
  await db.gridTrade.updateMany({ where: { id: grid.id, status: 'active' }, data: { state: st as unknown as object } })
}

// ---------- engine loop (ONE interval for every grid) ----------

type GlobalWithGrid = typeof globalThis & {
  __ttGridEngine?: { timer: ReturnType<typeof setInterval>; busy: boolean }
}

async function gridCycle(entry: { busy: boolean }): Promise<void> {
  if (entry.busy) return
  entry.busy = true
  try {
    const grids = await db.gridTrade.findMany({ where: { status: 'active' } })
    if (grids.length === 0) return
    // one quote round-trip per user per tick (grids can belong to any user)
    const byUser = new Map<string, Set<string>>()
    for (const g of grids) {
      const set = byUser.get(g.userId) ?? new Set<string>()
      set.add(g.symbol)
      byUser.set(g.userId, set)
    }
    const priceByKey = new Map<string, number>()
    for (const [userId, symbols] of byUser) {
      try {
        // v1.80.8 — trading:true: the engine makes ORDER decisions, so a
        // transient data-feed failure must return a MISSING quote, never the
        // simulator's price (the 228.82 incident: a 429 fed the engine a sim
        // AAPL quote ~34% under the market and Max SL closed lots on it)
        const { quotes } = await getQuotes([...symbols], userId, { trading: true })
        for (const q of quotes) {
          if (Number.isFinite(q.price) && q.price > 0) priceByKey.set(`${userId}|${q.symbol}`, q.price)
        }
      } catch (e) {
        console.warn('[grid] quote fetch failed:', e instanceof Error ? e.message : e)
      }
    }
    // SEQUENTIAL evaluation — a failing grid must never kill the loop
    for (const grid of grids) {
      try {
        const price = priceByKey.get(`${grid.userId}|${grid.symbol}`)
        if (price == null) {
          // missing real quote → DEFER (same philosophy as the RTH gate):
          // static exposure, no orders, no fail-count — a data hiccup must
          // not park the grid as 'error' and must never trade on a guess
          const st = parseGridState(grid.state)
          const note = 'No real quote this tick (data feed hiccup) — evaluation deferred'
          if (st.lastError !== note) {
            await db.gridTrade.updateMany({
              where: { id: grid.id, status: 'active' },
              data: { state: { ...st, lastError: note } as unknown as object },
            }).catch(() => { /* row gone */ })
          }
          console.warn(`[grid] ${grid.symbol}: no real quote this tick — deferred`)
          continue
        }
        await evaluateGrid(grid, price)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[grid] evaluation failed for ${grid.symbol}:`, msg)
        try {
          const st = parseGridState(grid.state)
          const failCount = (st.failCount ?? 0) + 1
          if (failCount >= MAX_CONSECUTIVE_FAILURES) {
            // park as 'error' — conditional on status so a just-stopped grid
            // is never resurrected or overwritten
            const parked = await db.gridTrade.updateMany({
              where: { id: grid.id, status: 'active' },
              data: {
                status: 'error',
                stoppedAt: new Date(),
                stopReason: `Engine error — parked after ${failCount} failed cycles: ${msg}`,
                state: { ...st, failCount, lastError: msg } as unknown as object,
              },
            })
            if (parked.count > 0) console.warn(`[grid] parked ${grid.symbol} after ${failCount} failures`)
          } else {
            await db.gridTrade.updateMany({
              where: { id: grid.id, status: 'active' },
              data: { state: { ...st, failCount, lastError: msg } as unknown as object },
            })
          }
        } catch { /* row gone */ }
      }
    }
  } catch (e) {
    console.warn('[grid] cycle failed:', e instanceof Error ? e.message : e)
  } finally {
    entry.busy = false
  }
}

/** Start (once) the module-level grid interval — idempotent, unref'd. */
export function ensureGridEngine(): void {
  const g = globalThis as GlobalWithGrid
  if (g.__ttGridEngine) return
  const entry: { timer: ReturnType<typeof setInterval>; busy: boolean } = { timer: null as unknown as ReturnType<typeof setInterval>, busy: false }
  entry.timer = setInterval(() => void gridCycle(entry), GRID_CYCLE_MS)
  if (typeof entry.timer === 'object' && entry.timer !== null && 'unref' in entry.timer) {
    (entry.timer as { unref: () => void }).unref()
  }
  g.__ttGridEngine = entry
  void gridCycle(entry) // first pass right away
  console.log(`[grid] engine started (every ${GRID_CYCLE_MS / 1000}s)`)
}

// ---------- lifecycle ----------

export interface StartGridInput {
  userId: string
  symbol: string
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: GridSpacing
  qtyPerGrid: number
  maxSL: number | null
  maxTP: number | null
  /** 'price' | 'percent' (Task 10-a) — how maxSL/maxTP are expressed */
  slBasis?: string
  tpBasis?: string
  /** Task 10-g — 'both' | 'buy' | 'sell' (default 'both') */
  direction?: string
  closeOnStop: boolean
  /** Task 89 — the Alpaca account this grid trades on, pinned for its whole
   *  life (creation routes refuse live, so this is 'paper' today) */
  mode?: TradeMode
  /** Task 18 — auto-grid provenance (the watchlist scan's plan snapshot) */
  auto?: boolean
  autoPlan?: unknown
  /** planned end — the engine force-stops the grid when now ≥ autoEndAt */
  autoEndAt?: Date | null
}

/** Validate + create + start a grid trade (engine auto-resumes via the loop). */
export async function startGridTrade(input: StartGridInput) {
  const levels = computeLevels(input.lowerPrice, input.upperPrice, input.gridCount, input.spacing)
  const state: GridState = { levels, lastPrice: null, lots: [], failCount: 0 }
  const grid = await db.gridTrade.create({
    data: {
      userId: input.userId,
      symbol: input.symbol,
      mode: input.mode === 'live' ? 'live' : 'paper',
      lowerPrice: input.lowerPrice,
      upperPrice: input.upperPrice,
      gridCount: input.gridCount,
      spacing: input.spacing,
      qtyPerGrid: input.qtyPerGrid,
      maxSL: input.maxSL,
      maxTP: input.maxTP,
      slBasis: input.slBasis ?? 'price',
      tpBasis: input.tpBasis ?? 'price',
      direction: isGridDirection(input.direction) ? input.direction : 'both',
      closeOnStop: input.closeOnStop,
      status: 'active',
      auto: input.auto ?? false,
      autoPlan: (input.autoPlan ?? undefined) as object | undefined,
      autoEndAt: input.autoEndAt ?? null,
      state: state as unknown as object,
    },
  })
  ensureGridEngine()
  return grid
}

/** Task 89 — creation dedup: an ACTIVE or PAUSED grid on the same symbol
 *  already exists → a second one would double every level crossing's order
 *  volume (double-submit, bundle re-import, repeated auto scans). Creation
 *  routes surface this as a clean rejection instead of a second grid. */
export async function findConflictingGrid(userId: string, symbol: string): Promise<{ id: string; symbol: string } | null> {
  return db.gridTrade.findFirst({
    where: { userId, symbol, status: { in: ['active', 'paused'] } },
    select: { id: true, symbol: true },
  })
}

/** Delete a grid and its fills (only legal for non-active grids — route enforces). */
export async function deleteGridTrade(gridId: string): Promise<void> {
  await db.gridFill.deleteMany({ where: { gridTradeId: gridId } })
  await db.gridTrade.delete({ where: { id: gridId } }).catch(() => { /* already gone */ })
}
