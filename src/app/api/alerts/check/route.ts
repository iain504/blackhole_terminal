import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getQuotes } from '@/lib/alpaca'
import { sendTelegram, handleError } from '@/lib/api-helpers'
import { Bar, Timeframe, TIMEFRAMES } from '@/lib/market-types'
import { barsFor } from '@/lib/bars-cache'
import { evalIndicatorSignal, isCross, IndicatorParams, IndEval } from '@/lib/indicator-eval'

interface UserSettings {
  telegramTokenEnc?: string
  telegramChatId?: string
}

interface AlertRow {
  id: string
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

// POST /api/alerts/check — poll engine: evaluate active alarms against live
// data. Price alarms compare live quotes; RSI/MACD alarms compute the
// indicator over recent bars (per the alarm's timeframe + params) and fire on
// a genuine crossing (the first check only records the starting side).
// Client calls this periodically (every ~30s). Triggers Telegram when configured.
export async function POST() {
  try {
    const user = await requireUser()
    const alerts = (await db.alert.findMany({
      where: { userId: user.id, status: 'active' },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })) as unknown as AlertRow[]
    if (alerts.length === 0) return NextResponse.json({ triggered: [], checked: 0 })

    const dbUser = await db.user.findUnique({ where: { id: user.id } })
    const s = (dbUser?.settings as UserSettings | null) || null
    let telegramToken: string | null = null
    if (s?.telegramTokenEnc) {
      const { decrypt } = await import('@/lib/crypt')
      telegramToken = decrypt(s.telegramTokenEnc)
    }
    const telegramChatId = s?.telegramChatId || null
    const notify = async (text: string) => {
      if (telegramToken && telegramChatId) await sendTelegram(telegramToken, telegramChatId, text)
    }

    const triggered: {
      id: string; symbol: string; kind: string; price: number
      target: number; direction: string; message: string
    }[] = []

    // ---- price alarms (legacy path, unchanged) + trend-line alarms ----
    // trend alerts are handled separately below (their level MOVES with the
    // line drawing); everything else that is not an indicator alarm takes the
    // static price path
    const priceAlerts = alerts.filter((a) => a.kind !== 'rsi' && a.kind !== 'macd' && a.kind !== 'trend')
    if (priceAlerts.length > 0) {
      const symbols = [...new Set(priceAlerts.map((a) => a.symbol))]
      const { quotes } = await getQuotes(symbols, user.id)
      const bySymbol = new Map(quotes.map((q) => [q.symbol, q]))
      for (const a of priceAlerts) {
        const q = bySymbol.get(a.symbol)
        if (!q) continue
        const side = q.price > a.price ? 'above' : q.price < a.price ? 'below' : a.lastSide
        const crossed =
          a.direction === 'above'
            ? side === 'above' && a.lastSide !== 'above'
            : side === 'below' && a.lastSide !== 'below'
        if (crossed) {
          await db.alert.update({
            where: { id: a.id },
            data: { status: 'triggered', triggeredAt: new Date(), lastSide: side },
          })
          const message = `Price crossed ${a.direction === 'above' ? 'above' : 'below'} ${a.price} — now ${q.price.toFixed(4)}`
          triggered.push({ id: a.id, symbol: a.symbol, kind: 'price', price: q.price, target: a.price, direction: a.direction, message })
          await notify(
            `🔔 <b>Price Alert</b>\n<b>${a.symbol}</b> is now ${a.direction === 'above' ? '📈 above' : '📉 below'} your alert level\n\nPrice: <b>${q.price.toFixed(4)}</b>\nAlert: ${a.price.toFixed(4)}\nTime: ${new Date().toUTCString()}`,
          )
        } else if (side !== a.lastSide && side) {
          // update stored side so re-entry after leaving re-triggers
          await db.alert.update({ where: { id: a.id }, data: { lastSide: side } })
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
        entry = await barsFor(symbol, tf as Timeframe, user.id)
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
          await db.alert.update({
            where: { id: a.id },
            data: { status: 'triggered', triggeredAt: new Date(), lastSide: ev.side },
          })
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
          await db.alert.update({ where: { id: a.id }, data: { lastSide: ev.side } })
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
        ? await db.drawing.findMany({ where: { id: { in: drawingIds }, userId: user.id, kind: 'trend' } })
        : []
      const drawingById = new Map(drawings.map((dr) => [dr.id, dr]))
      const quoteSyms = [...new Set(trendAlerts.map((a) => a.symbol))]
      const { quotes: tQuotes } = await getQuotes(quoteSyms, user.id)
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
          if (side) await db.alert.update({ where: { id: a.id }, data: { lastSide: side } })
          continue
        }
        const crossed =
          a.direction === 'above'
            ? side === 'above' && a.lastSide !== 'above'
            : side === 'below' && a.lastSide !== 'below'
        if (crossed) {
          await db.alert.update({
            where: { id: a.id },
            data: { status: 'triggered', triggeredAt: new Date(), lastSide: side },
          })
          const message = `Price crossed ${a.direction === 'above' ? 'above' : 'below'} the trend line (line level ${level.toFixed(4)}) — now ${q.price.toFixed(4)}`
          triggered.push({ id: a.id, symbol: a.symbol, kind: 'trend', price: q.price, target: level, direction: a.direction, message })
          await notify(
            `🔔 <b>Trend-line Alert</b>\n<b>${a.symbol}</b> crossed ${a.direction === 'above' ? '📈 above' : '📉 below'} your trend line\n\nPrice: <b>${q.price.toFixed(4)}</b>\nLine level: ${level.toFixed(4)}\nTime: ${new Date().toUTCString()}`,
          )
        } else if (side !== a.lastSide && side) {
          await db.alert.update({ where: { id: a.id }, data: { lastSide: side } })
        }
      }
    }

    return NextResponse.json({ triggered, checked: alerts.length })
  } catch (e) {
    return handleError(e)
  }
}
