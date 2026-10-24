// Alert evaluation engine (Task 3-c) — extracted verbatim from
// POST /api/alerts/check so BOTH the browser poll and the server-side
// supervisor (alerts-supervisor.ts) drive the same logic.
//
// Semantics preserved from the original route:
//   • price alarms compare live quotes; RSI/MACD alarms compute the indicator
//     over recent bars (per the alarm's timeframe + params); trend-line alarms
//     re-project the drawing's line through wall-clock time at every poll.
//   • crossing memory (lastSide): the first check only RECORDS the starting
//     side — a genuine crossing afterwards fires (price alarms are seeded
//     opposite at creation, so they fire when genuinely beyond the level).
//   • per-user scoping everywhere (alerts, quotes, bars, drawings, settings).
//   • Telegram delivery when the user configured token + chat id.
//
// DOUBLE-FIRE SAFETY (the reason this moved into a lib): the route and the
// supervisor may evaluate the SAME alert concurrently (browser tab open while
// the supervisor ticks). Firing is therefore claimed atomically with a
// conditional updateMany — compare-and-swap on the state we evaluated against
// (same race-safe pattern as the strategy bot's armed→placing claim in
// strategy.ts). Only the claimant (updateMany count ≥ 1) pushes the result
// and sends Telegram; the loser skips silently. Side-recording writes are
// likewise guarded with status:'active' so they can never resurrect or
// clobber an already-triggered row.
import { db } from '@/lib/db'
import { getQuotes } from '@/lib/alpaca'

// 5s micro-cache for alert-evaluation quotes: the supervisor (15s) and any
// client polls landing in the same window reuse one Alpaca snapshot round-trip
// per symbol set. Alert checks run on a 15–30s cadence, so ≤5s staleness is
// fine. Order placement NEVER goes through here (it calls getQuotes directly).
let quoteCache: { at: number; key: string; data: Awaited<ReturnType<typeof getQuotes>> } | null = null
async function getQuotesCached(symbols: string[], userId?: string) {
  const key = [...symbols].sort().join(',') + '|' + (userId ?? '')
  if (quoteCache && quoteCache.key === key && Date.now() - quoteCache.at < 5_000) return quoteCache.data
  const data = await getQuotes(symbols, userId)
  quoteCache = { at: Date.now(), key, data }
  return data
}
import { sendTelegram } from '@/lib/api-helpers'
import { decrypt } from '@/lib/crypt'
import { Bar, Timeframe, TIMEFRAMES } from '@/lib/market-types'
import { barsFor } from '@/lib/bars-cache'
import { evalIndicatorSignal, isCross, IndicatorParams, IndEval } from '@/lib/indicator-eval'

interface UserSettings {
  telegramTokenEnc?: string
  telegramChatId?: string
}

export interface AlertRow {
  id: string
  userId: string
  symbol: string
  kind: string
  price: number
  direction: string
  condition: string | null
  timeframe: string
  params: unknown
  status: string
  lastSide: string | null
}

export interface AlertTriggered {
  id: string
  symbol: string
  kind: string
  price: number
  target: number
  direction: string
  message: string
}

export interface AlertsResult {
  triggered: AlertTriggered[]
  checked: number
}

/**
 * Evaluate one indicator alert against the bar series — thin wrapper over the
 * shared engine (same semantics as the strategy bot).
 */
function evalIndicator(a: AlertRow, bars: Bar[]): IndEval | null {
  return evalIndicatorSignal(
    a.kind === 'macd' ? 'macd' : 'rsi',
    a.condition,
    a.direction === 'below' ? 'below' : 'above',
    a.price,
    a.timeframe,
    (a.params as IndicatorParams | null) || null,
    bars,
  )
}

/**
 * Atomically CLAIM a firing: flips active→triggered ONLY if the row is still
 * in exactly the state this evaluation observed (status active + the
 * lastSide snapshot we based the crossing decision on). count 0 = another
 * evaluator (browser poll or supervisor) already fired or the memory moved —
 * the caller must NOT notify.
 */
function claimTrigger(a: AlertRow, firedSide: string) {
  return db.alert.updateMany({
    where: {
      id: a.id,
      status: 'active',
      lastSide: a.lastSide ?? null, // compare-and-swap on the observed memory
    },
    data: { status: 'triggered', triggeredAt: new Date(), lastSide: firedSide },
  })
}

/** Record a side change without firing — only while the alert is still active. */
function recordSide(a: AlertRow, side: string) {
  return db.alert.updateMany({
    where: { id: a.id, status: 'active' },
    data: { lastSide: side },
  })
}

/** Per-user in-flight guard: poll + supervisor must never double-run a full
 * evaluation for the same user (the claim still protects correctness; this
 * just avoids duplicated work/Telegram latency windows). */
const inFlight = new Set<string>()

/**
 * Evaluate all active alerts for one user against live data. Safe to call
 * concurrently (client poll + supervisor): the second caller is a no-op
 * returning the empty shape, and genuine fires are claim-protected.
 */
export async function evaluateAlerts(userId: string): Promise<AlertsResult> {
  if (inFlight.has(userId)) return { triggered: [], checked: 0 }
  inFlight.add(userId)
  try {
    return await evaluateInner(userId)
  } finally {
    inFlight.delete(userId)
  }
}

async function evaluateInner(userId: string): Promise<AlertsResult> {
  const alerts = (await db.alert.findMany({
    where: { userId, status: 'active' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })) as unknown as AlertRow[]
  if (alerts.length === 0) return { triggered: [], checked: 0 }

  const dbUser = await db.user.findUnique({ where: { id: userId } })
  const s = (dbUser?.settings as UserSettings | null) || null
  let telegramToken: string | null = null
  if (s?.telegramTokenEnc) telegramToken = decrypt(s.telegramTokenEnc)
  const telegramChatId = s?.telegramChatId || null
  const notify = async (text: string) => {
    if (telegramToken && telegramChatId) await sendTelegram(telegramToken, telegramChatId, text)
  }

  const triggered: AlertTriggered[] = []

  // ---- price alarms (legacy path) ----
  const priceAlerts = alerts.filter((a) => a.kind !== 'rsi' && a.kind !== 'macd' && a.kind !== 'trend')
  if (priceAlerts.length > 0) {
    const symbols = [...new Set(priceAlerts.map((a) => a.symbol))]
    const { quotes } = await getQuotesCached(symbols, userId)
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]))
    for (const a of priceAlerts) {
      const q = bySymbol.get(a.symbol)
      if (!q) continue
      const side = q.price > a.price ? 'above' : q.price < a.price ? 'below' : a.lastSide
      const crossed =
        a.direction === 'above'
          ? side === 'above' && a.lastSide !== 'above'
          : side === 'below' && a.lastSide !== 'below'
      if (crossed && side) {
        const claim = await claimTrigger(a, side)
        if (claim.count === 0) continue // already fired by the other evaluator
        const message = `Price crossed ${a.direction === 'above' ? 'above' : 'below'} ${a.price} — now ${q.price.toFixed(4)}`
        triggered.push({ id: a.id, symbol: a.symbol, kind: 'price', price: q.price, target: a.price, direction: a.direction, message })
        await notify(
          `🔔 <b>Price Alert</b>\n<b>${a.symbol}</b> is now ${a.direction === 'above' ? '📈 above' : '📉 below'} your alert level\n\nPrice: <b>${q.price.toFixed(4)}</b>\nAlert: ${a.price.toFixed(4)}\nTime: ${new Date().toUTCString()}`,
        )
      } else if (side !== a.lastSide && side) {
        // update stored side so re-entry after leaving re-triggers
        await recordSide(a, side)
      }
    }
  }

  // ---- indicator alarms (rsi / macd) ----
  const indAlerts = alerts.filter((a) => a.kind === 'rsi' || a.kind === 'macd')
  // group by symbol+timeframe so each series is fetched at most once per poll
  const groups = new Map<string, AlertRow[]>()
  for (const a of indAlerts) {
    const tf = TIMEFRAMES[a.timeframe as Timeframe] ? a.timeframe : '1D'
    const key = `${a.symbol}|${tf}`
    const list = groups.get(key) || []
    list.push(a)
    groups.set(key, list)
  }
  for (const [key, list] of groups) {
    const [symbol, tf] = key.split('|')
    let entry
    try {
      entry = await barsFor(symbol, tf as Timeframe, userId)
    } catch {
      continue // data unavailable this cycle — retry next poll
    }
    // NEVER evaluate indicator alarms on fabricated demo bars (the terminal
    // must not alarm off simulated data) — wait for a real series
    if (entry.demo || entry.bars.length < 5) continue
    for (const a of list) {
      const ev = evalIndicator(a, entry.bars)
      if (!ev) continue
      const crossed = isCross(a.direction === 'below' ? 'below' : 'above', ev.side, a.lastSide)
      if (crossed && a.lastSide != null) {
        const claim = await claimTrigger(a, ev.side)
        if (claim.count === 0) continue // already fired by the other evaluator
        triggered.push({
          id: a.id, symbol: a.symbol, kind: a.kind, price: ev.value,
          target: a.price, direction: a.direction, message: ev.message,
        })
        await notify(
          `🔔 <b>${a.kind.toUpperCase()} Alert</b>\n<b>${a.symbol}</b>\n\n${ev.message}\nTime: ${new Date().toUTCString()}`,
        )
      } else if (ev.side !== a.lastSide) {
        // record the current side (also the FIRST check after creation —
        // indicator alarms fire only on a genuine crossing afterwards)
        await recordSide(a, ev.side)
      }
    }
  }

  // ---- trend-line alarms: the trigger level is the (extended) trend line
  // drawing, re-projected through its two points at EVERY poll via wall-clock
  // time — editing/dragging the line moves the alert with it. Crossing
  // semantics match the indicator alarms: the first check only RECORDS the
  // side, a genuine crossing afterwards fires. ----
  const trendAlerts = alerts.filter((a) => a.kind === 'trend')
  if (trendAlerts.length > 0) {
    const drawingIds = [...new Set(trendAlerts.map((a) => (a.params as { drawingId?: string } | null)?.drawingId).filter((x): x is string => typeof x === 'string' && x.length > 0))]
    const drawings = drawingIds.length
      ? await db.drawing.findMany({ where: { id: { in: drawingIds }, userId, kind: 'trend' } })
      : []
    const drawingById = new Map(drawings.map((dr) => [dr.id, dr]))
    const quoteSyms = [...new Set(trendAlerts.map((a) => a.symbol))]
    const { quotes: tQuotes } = await getQuotes(quoteSyms, userId)
    const tQuoteBy = new Map(tQuotes.map((q) => [q.symbol, q]))
    for (const a of trendAlerts) {
      const drawingId = (a.params as { drawingId?: string } | null)?.drawingId
      const dr = drawingId ? drawingById.get(drawingId) : null
      if (!dr) continue // drawing deleted — alert lies dormant (no false fires)
      const pts = Array.isArray(dr.points) ? (dr.points as { time?: number | null; price?: number }[]) : []
      const p1 = pts[0]
      const p2 = pts[1]
      const price1 = p1?.price
      const price2 = p2?.price
      if (!p1 || !p2 || typeof price1 !== 'number' || typeof price2 !== 'number' || !Number.isFinite(price1) || !Number.isFinite(price2)) continue
      let level: number
      const t1 = typeof p1.time === 'number' ? p1.time : null
      const t2 = typeof p2.time === 'number' ? p2.time : null
      if (t1 != null && t2 != null && t1 !== t2) {
        // straight line through both points, evaluated at NOW (extended)
        const now = Math.floor(Date.now() / 1000)
        level = price1 + ((price2 - price1) * (now - t1)) / (t2 - t1)
      } else {
        // vertical-in-time / missing times — degrade to the end point's level
        level = price2
      }
      if (!Number.isFinite(level) || Math.abs(level) > 1e12) continue
      const q = tQuoteBy.get(a.symbol)
      if (!q) continue
      const side = q.price > level ? 'above' : q.price < level ? 'below' : a.lastSide
      if (a.lastSide == null) {
        // FIRST check: record the starting side only — the alert fires on a
        // genuine crossing afterwards (no immediate fire at creation)
        if (side) await recordSide(a, side)
        continue
      }
      const crossed =
        a.direction === 'above'
          ? side === 'above' && a.lastSide !== 'above'
          : side === 'below' && a.lastSide !== 'below'
      if (crossed && side) {
        const claim = await claimTrigger(a, side)
        if (claim.count === 0) continue // already fired by the other evaluator
        const message = `Price crossed ${a.direction === 'above' ? 'above' : 'below'} the trend line (line level ${level.toFixed(4)}) — now ${q.price.toFixed(4)}`
        triggered.push({ id: a.id, symbol: a.symbol, kind: 'trend', price: q.price, target: level, direction: a.direction, message })
        await notify(
          `🔔 <b>Trend-line Alert</b>\n<b>${a.symbol}</b> crossed ${a.direction === 'above' ? '📈 above' : '📉 below'} your trend line\n\nPrice: <b>${q.price.toFixed(4)}</b>\nLine level: ${level.toFixed(4)}\nTime: ${new Date().toUTCString()}`,
        )
      } else if (side !== a.lastSide && side) {
        await recordSide(a, side)
      }
    }
  }

  return { triggered, checked: alerts.length }
}
