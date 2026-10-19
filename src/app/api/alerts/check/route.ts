import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getQuotes, getBars } from '@/lib/alpaca'
import { rsi as rsiCalc, macd as macdCalc } from '@/lib/indicators'
import { sendTelegram, handleError } from '@/lib/api-helpers'
import { Bar, Timeframe, TIMEFRAMES } from '@/lib/market-types'

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

interface IndicatorParams {
  period?: number
  fast?: number
  slow?: number
  signal?: number
}

interface IndEval {
  side: 'above' | 'below'
  value: number
  message: string
}

/** Bars cache — the check endpoint is polled by EVERY open tab every 30s;
 * a short TTL collapses concurrent polls for the same series into one fetch. */
const barsCache = new Map<string, { bars: Bar[]; demo: boolean; at: number }>()
const BARS_TTL_MS = 20000

async function barsFor(symbol: string, tf: Timeframe, userId: string) {
  const key = `${symbol}|${tf}`
  const hit = barsCache.get(key)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit
  const res = await getBars(symbol, tf, userId)
  const entry = { bars: res.bars, demo: Boolean(res.demo), at: Date.now() }
  barsCache.set(key, entry)
  return entry
}

const tfLabel = (tf: string) => TIMEFRAMES[tf as Timeframe]?.label ?? tf

/**
 * Evaluate one indicator alert against the bar series (chronological; the last
 * bar is the forming bar, so `last` tracks live while `prev` is the last CLOSED
 * bar). Returns the current side + a human message, or null when there is not
 * enough data.
 */
function evalIndicator(a: AlertRow, bars: Bar[]): IndEval | null {
  const closes = bars.map((b) => b.close)
  if (a.kind === 'rsi') {
    const period = Number((a.params as IndicatorParams | null)?.period) || 14
    const series = rsiCalc(closes, period)
    const last = series[series.length - 1]
    const prev = series[series.length - 2]
    if (last == null || prev == null) return null
    const level = a.price
    const side: 'above' | 'below' = last > level ? 'above' : 'below'
    return {
      side,
      value: last,
      message: `RSI(${period}) crossed ${a.direction === 'above' ? 'above' : 'below'} ${level} — now ${last.toFixed(1)} · ${tfLabel(a.timeframe)}`,
    }
  }
  // ---- macd ----
  const p = (a.params as IndicatorParams | null) || {}
  const fast = Number(p.fast) || 12
  const slow = Number(p.slow) || 26
  const signal = Number(p.signal) || 9
  const m = macdCalc(closes, fast, slow, signal)
  const lastM = m.macd[m.macd.length - 1]
  const prevM = m.macd[m.macd.length - 2]
  const label = `MACD(${fast},${slow},${signal})`
  if (a.condition === 'bull_cross' || a.condition === 'bear_cross') {
    const lastS = m.signal[m.signal.length - 1]
    const prevS = m.signal[m.signal.length - 2]
    if (lastM == null || prevM == null || lastS == null || prevS == null) return null
    const side: 'above' | 'below' = lastM > lastS ? 'above' : 'below'
    return {
      side,
      value: lastM,
      message: `${label} ${a.condition === 'bull_cross' ? 'bullish' : 'bearish'} crossover — macd ${lastM.toFixed(4)} ${side === 'above' ? '>' : '<'} signal ${lastS.toFixed(4)} · ${tfLabel(a.timeframe)}`,
    }
  }
  // cross_above / cross_below a fixed level (default zero line)
  if (lastM == null || prevM == null) return null
  const level = a.price
  const side: 'above' | 'below' = lastM > level ? 'above' : 'below'
  return {
    side,
    value: lastM,
    message: `${label} crossed ${a.direction === 'above' ? 'above' : 'below'} ${level} — now ${lastM.toFixed(4)} · ${tfLabel(a.timeframe)}`,
  }
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

    // ---- price alarms (legacy path, unchanged) ----
    const priceAlerts = alerts.filter((a) => a.kind !== 'rsi' && a.kind !== 'macd')
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
        const crossed =
          a.direction === 'above'
            ? ev.side === 'above' && a.lastSide !== 'above'
            : ev.side === 'below' && a.lastSide !== 'below'
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

    return NextResponse.json({ triggered, checked: alerts.length })
  } catch (e) {
    return handleError(e)
  }
}
