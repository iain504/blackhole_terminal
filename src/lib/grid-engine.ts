// Grid Trading engine (Task 9-q) — long-only spot grid bot.
//
// ONE module-level interval (5s) drives every active grid: each tick re-reads
// ALL status 'active' rows from the DB (the DB is the single source of truth —
// the same model as algo-engine.ts) and evaluates them SEQUENTIALLY, so a
// restart auto-resumes every active grid and one failing grid can never kill
// the loop.
//
// Mechanics (v1, per evaluation with current price P and persisted lastPrice L):
//   • guards FIRST: maxSL (P <= maxSL → close all + stop) / maxTP (P >= maxTP
//     → close all + stop) — whole-grid absolute-price circuit breakers
//   • BUY: level i crossed DOWNWARD this tick (L > level[i] >= P) and no open
//     lot exists at that level → market buy qtyPerGrid
//   • SELL (per-lot TP): the lot bought at level i targets level[i+1] (or
//     upperPrice for the last level) — crossed UPWARD this tick → market sell
//     the lot, realized pnl = (sellPrice − entryPrice) × qty
//   • the first evaluation after start only SEEDS lastPrice (no trades)
//   • state (levels + open lots + lastPrice) is persisted after EVERY
//     evaluation — crash-safe
//
// Orders go through the same paper-broker pipeline as manual/algo orders
// (placeOrderWithExits in trading.ts); fill records use the order's average
// fill price when the broker reports one, else the level price.
import { db } from '@/lib/db'
import { getQuotes } from '@/lib/alpaca'
import { placeOrderWithExits, resolveTradeMode, type TradeMode } from '@/lib/trading'

const GRID_CYCLE_MS = 5000
const MIN_GRID_COUNT = 2
const MAX_GRID_COUNT = 100
/** consecutive hard failures before a grid is parked as 'error' */
const MAX_CONSECUTIVE_FAILURES = 5

export type GridSpacing = 'arithmetic' | 'geometric'

export function isGridSpacing(v: unknown): v is GridSpacing {
  return v === 'arithmetic' || v === 'geometric'
}

/** Open lot working memory (persisted inside GridTrade.state). */
export interface GridLot {
  levelIndex: number
  qty: number
  entryPrice: number
}

/** GridTrade.state Json shape — survives restarts. */
export interface GridState {
  levels: number[]
  lastPrice: number | null
  lots: GridLot[]
  /** consecutive hard evaluation failures (reset on any success) */
  failCount?: number
  /** last hard-failure message (surfaced in the error stopReason) */
  lastError?: string
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
    lots,
    failCount: typeof s.failCount === 'number' ? s.failCount : 0,
    lastError: typeof s.lastError === 'string' ? s.lastError : undefined,
  }
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
  const unrealized = px != null ? st.lots.reduce((acc, l) => acc + (px - l.entryPrice) * l.qty, 0) : null
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
}
interface OrderFail {
  ok: false
  error: string
}

/** Market order through the SAME pipeline as manual/algo orders. Fill price
 *  = the broker's average fill price when reported, else `fallbackPrice`. */
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
      // tag with the grid id prefix so the trade history can attribute these
      sourceRef: gridId.slice(0, 8),
    })
    if (r.results.length === 0) return { ok: false, error: r.errors[0] || 'order rejected' }
    const o = r.results[0]
    const fp = Number(o.filled_avg_price)
    return { ok: true, price: Number.isFinite(fp) && fp > 0 ? fp : fallbackPrice, orderId: o.id }
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
 * Close every open lot with ONE combined market sell (when closeOnStop) and
 * park the grid. Race-safe: the stop is CLAIMED with a conditional updateMany
 * on status 'active' — only the claimant closes (engine guard vs manual stop
 * vs concurrent cycle can never double-close).
 */
async function closeAndStop(
  grid: {
    id: string
    userId: string
    symbol: string
    closeOnStop: boolean
    state: unknown
  },
  reason: 'sl' | 'maxtp' | 'manual_close',
  price: number | null,
  reasonText: string,
): Promise<void> {
  // claim: only one caller wins the active → stopped transition
  const claimed = await db.gridTrade.updateMany({
    where: { id: grid.id, status: 'active' },
    data: { status: 'stopped', stoppedAt: new Date() },
  })
  if (claimed.count === 0) return // already stopped elsewhere

  const st = parseGridState(grid.state)
  const px = price ?? st.lastPrice ?? null
  let stopReason = reasonText

  if (st.lots.length > 0) {
    if (grid.closeOnStop && px != null) {
      const mode = await resolveTradeMode(grid.userId)
      const qty = st.lots.reduce((acc, l) => acc + l.qty, 0)
      const r = await placeGridMarketOrder(grid.userId, mode, grid.id, grid.symbol, 'sell', qty, px)
      if (r.ok) {
        const pnl = st.lots.reduce((acc, l) => acc + (r.price - l.entryPrice) * l.qty, 0)
        const levelList = [...new Set(st.lots.map((l) => l.levelIndex))].sort((a, b) => a - b).join(',')
        await db.gridFill.create({
          data: {
            gridTradeId: grid.id,
            userId: grid.userId,
            levelIndex: -1, // combined close spans several levels — see note
            side: 'sell',
            reason,
            price: r.price,
            qty,
            pnl,
            orderId: r.orderId,
            note: `closed all open grid lots (levels ${levelList})`,
          },
        })
        await db.gridTrade.update({
          where: { id: grid.id },
          data: {
            // atomic increment — a concurrent cycle fill can never be clobbered
            realizedPnl: { increment: pnl },
            stopReason: `${stopReason} — closed ${st.lots.length} lot(s) at ${fmtP(r.price)}`,
            state: { ...st, lastPrice: px, lots: [], failCount: 0 } as unknown as object,
          },
        })
        return
      }
      // close order failed — be honest: error status, lots untouched
      await db.gridTrade.update({
        where: { id: grid.id },
        data: {
          status: 'error',
          stopReason: `${stopReason} — CLOSE FAILED: ${r.error}. Open lots left untouched.`,
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
  }
  await db.gridTrade.update({
    where: { id: grid.id },
    data: {
      stopReason,
      state: { ...st, lastPrice: px, failCount: 0 } as unknown as object,
    },
  })
}

const fmtP = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4))

/** Manual stop (Grid tab button). Returns false when the grid is not owned. */
export async function stopGridTrade(userId: string, gridId: string, opts?: { reason?: 'manual_close' }): Promise<boolean> {
  const grid = await db.gridTrade.findFirst({ where: { id: gridId, userId } })
  if (!grid) return false
  if (grid.status !== 'active') return true // already stopped — idempotent
  const st = parseGridState(grid.state)
  let price: number | null = st.lastPrice
  try {
    const { quotes } = await getQuotes([grid.symbol], userId)
    const q = quotes.find((x) => x.symbol === grid.symbol)
    if (q && Number.isFinite(q.price) && q.price > 0) price = q.price
  } catch { /* fall back to the state's lastPrice */ }
  await closeAndStop(grid, opts?.reason ?? 'manual_close', price, 'Stopped manually')
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
  closeOnStop: boolean
  realizedPnl: number
  state: unknown
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

  // ---- guards FIRST (whole-grid circuit breakers) ----
  if (grid.maxSL != null && price <= grid.maxSL) {
    await closeAndStop(grid, 'sl', price, `Max SL hit at ${fmtP(price)}`)
    return
  }
  if (grid.maxTP != null && price >= grid.maxTP) {
    await closeAndStop(grid, 'maxtp', price, `Max TP reached at ${fmtP(price)}`)
    return
  }

  const L = st.lastPrice
  const mode = await resolveTradeMode(grid.userId)

  // ---- SELL signals first (free capacity before adding lots) — per-lot TP:
  // the lot bought at level i pays at level[i+1] ?? upperPrice, on an UPWARD
  // crossing of that target this tick
  if (L != null) {
    for (const lot of [...st.lots]) {
      const target = sellTargetOf(levels, lot.levelIndex, grid.upperPrice)
      if (!(L < target && price >= target)) continue
      if (!(await stillActive(grid.id))) return // stopped mid-tick — stand down
      const r = await placeGridMarketOrder(grid.userId, mode, grid.id, grid.symbol, 'sell', lot.qty, target)
      if (!r.ok) throw new Error(`TP sell at ${fmtP(target)} failed: ${r.error}`)
      const pnl = (r.price - lot.entryPrice) * lot.qty
      st.lots = st.lots.filter((l) => l !== lot)
      await db.gridFill.create({
        data: {
          gridTradeId: grid.id,
          userId: grid.userId,
          levelIndex: lot.levelIndex,
          side: 'sell',
          reason: 'tp',
          price: r.price,
          qty: lot.qty,
          pnl,
          orderId: r.orderId,
          note: `grid TP — target level ${fmtP(target)}`,
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

    // ---- BUY signals: level crossed DOWNWARD this tick, no lot there yet
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]
      if (!(L > level && price <= level)) continue
      if (st.lots.some((l) => l.levelIndex === i)) continue
      if (!(await stillActive(grid.id))) return // stopped mid-tick — stand down
      const qty = effectiveQty(grid.symbol, grid.qtyPerGrid)
      const r = await placeGridMarketOrder(grid.userId, mode, grid.id, grid.symbol, 'buy', qty, level)
      if (!r.ok) throw new Error(`Grid buy at ${fmtP(level)} failed: ${r.error}`)
      st.lots.push({ levelIndex: i, qty, entryPrice: r.price })
      await db.gridFill.create({
        data: {
          gridTradeId: grid.id,
          userId: grid.userId,
          levelIndex: i,
          side: 'buy',
          reason: 'grid',
          price: r.price,
          qty,
          orderId: r.orderId,
          note: `grid level ${i + 1}/${levels.length} at ${fmtP(level)}`,
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
  st.lastError = undefined
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
        const { quotes } = await getQuotes([...symbols], userId)
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
        if (price == null) throw new Error('no live price for symbol')
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
  closeOnStop: boolean
}

/** Validate + create + start a grid trade (engine auto-resumes via the loop). */
export async function startGridTrade(input: StartGridInput) {
  const levels = computeLevels(input.lowerPrice, input.upperPrice, input.gridCount, input.spacing)
  const state: GridState = { levels, lastPrice: null, lots: [], failCount: 0 }
  const grid = await db.gridTrade.create({
    data: {
      userId: input.userId,
      symbol: input.symbol,
      lowerPrice: input.lowerPrice,
      upperPrice: input.upperPrice,
      gridCount: input.gridCount,
      spacing: input.spacing,
      qtyPerGrid: input.qtyPerGrid,
      maxSL: input.maxSL,
      maxTP: input.maxTP,
      closeOnStop: input.closeOnStop,
      status: 'active',
      state: state as unknown as object,
    },
  })
  ensureGridEngine()
  return grid
}

/** Delete a grid and its fills (only legal for non-active grids — route enforces). */
export async function deleteGridTrade(gridId: string): Promise<void> {
  await db.gridFill.deleteMany({ where: { gridTradeId: gridId } })
  await db.gridTrade.delete({ where: { id: gridId } }).catch(() => { /* already gone */ })
}
