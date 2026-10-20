import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { TIMEFRAMES, Timeframe } from '@/lib/market-types'

export interface AlertDto {
  id: string
  symbol: string
  kind: string // 'price' | 'rsi' | 'macd'
  price: number // trigger level (price / rsi level / macd cross level)
  direction: string // 'above' | 'below'
  condition: string | null // macd: bull_cross | bear_cross | cross_above | cross_below
  timeframe: string // bar timeframe for indicator alarms ('1D')
  params: { period?: number; fast?: number; slow?: number; signal?: number } | null
  color: string
  status: string
  note: string | null
  triggeredAt: string | null
  createdAt: string
}

export function toDto(a: {
  id: string; symbol: string; kind: string; price: number; direction: string
  condition: string | null; timeframe: string; params: unknown
  color: string; status: string; note: string | null
  triggeredAt: Date | null; createdAt: Date
}): AlertDto {
  return {
    id: a.id, symbol: a.symbol, kind: a.kind, price: a.price,
    direction: a.direction, condition: a.condition, timeframe: a.timeframe,
    params: (a.params as AlertDto['params']) ?? null,
    color: a.color, status: a.status, note: a.note,
    triggeredAt: a.triggeredAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }
}

// GET /api/alerts — all alerts for user
export async function GET() {
  try {
    const user = await requireUser()
    const rows = await db.alert.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ alerts: rows.map(toDto) })
  } catch (e) {
    return handleError(e)
  }
}

interface CreateBody {
  symbol: string
  kind?: string // 'price' (default) | 'rsi' | 'macd' | 'trend'
  price?: number // price alerts: the level; rsi: 0-100 level; macd cross modes: macd-line level; trend: the line's projected level at creation (display)
  direction?: string // 'above' | 'below'
  condition?: string // macd: 'bull_cross' | 'bear_cross' | 'cross_above' | 'cross_below'
  timeframe?: string // indicator alarms: bar timeframe
  params?: { period?: number; fast?: number; slow?: number; signal?: number; drawingId?: string }
  color?: string
  note?: string
}

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}
const validTf = (tf: string | undefined): Timeframe =>
  tf && TIMEFRAMES[tf as Timeframe] ? (tf as Timeframe) : '1D'

// POST /api/alerts — create (price alarm, RSI alarm, or MACD alarm)
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJson<CreateBody>(req)
    const symbol = (body.symbol || '').toUpperCase()
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })

    const kind = body.kind === 'rsi' || body.kind === 'macd' || body.kind === 'trend' ? body.kind : 'price'
    const count = await db.alert.count({ where: { userId: user.id } })
    if (count >= 100) return NextResponse.json({ error: 'Alert limit reached (100)' }, { status: 400 })

    const color = body.color || '#f59e0b'
    const note = body.note?.slice(0, 200) || null

    if (kind === 'rsi') {
      // trigger when RSI crosses the level in the chosen direction
      const level = Number(body.price)
      if (!Number.isFinite(level) || level <= 0 || level >= 100) {
        return NextResponse.json({ error: 'RSI level must be between 0 and 100' }, { status: 400 })
      }
      const direction = body.direction === 'below' ? 'below' : 'above'
      const a = await db.alert.create({
        data: {
          userId: user.id, symbol, kind, price: level, direction,
          timeframe: validTf(body.timeframe),
          params: { period: clampInt(body.params?.period, 2, 200, 14) },
          color, note,
          lastSide: null, // first check records the side without triggering
        },
      })
      return NextResponse.json({ alert: toDto(a) })
    }

    if (kind === 'macd') {
      // bull_cross/bear_cross: macd line crosses the SIGNAL line (no level);
      // cross_above/cross_below: macd line crosses the `price` level (0 = zero line)
      const cond = ['bull_cross', 'bear_cross', 'cross_above', 'cross_below'].includes(body.condition || '')
        ? body.condition!
        : 'bull_cross'
      const level = Number(body.price)
      const usesLevel = cond === 'cross_above' || cond === 'cross_below'
      if (usesLevel && !Number.isFinite(level)) {
        return NextResponse.json({ error: 'macd cross level required' }, { status: 400 })
      }
      const direction = cond === 'bull_cross' || cond === 'cross_above' ? 'above' : 'below'
      let fast = clampInt(body.params?.fast, 1, 200, 12)
      let slow = clampInt(body.params?.slow, 2, 400, 26)
      if (slow <= fast) slow = fast + 1
      const signal = clampInt(body.params?.signal, 1, 200, 9)
      const a = await db.alert.create({
        data: {
          userId: user.id, symbol, kind, price: usesLevel ? level : 0, direction,
          condition: cond, timeframe: validTf(body.timeframe),
          params: { fast, slow, signal },
          color, note,
          lastSide: null,
        },
      })
      return NextResponse.json({ alert: toDto(a) })
    }

    if (kind === 'trend') {
      // TREND-LINE alarm — fires when price crosses the (extended) trend line
      // drawing. Bound to the drawing via params.drawingId; the check engine
      // re-projects the line through its two points at every poll, so the
      // level MOVES with the line (editing the line moves the alert with it).
      const drawingId = typeof body.params?.drawingId === 'string' ? body.params.drawingId : ''
      if (!drawingId) return NextResponse.json({ error: 'drawingId required for trend alarms' }, { status: 400 })
      const drawing = await db.drawing.findFirst({ where: { id: drawingId, userId: user.id } })
      if (!drawing || drawing.kind !== 'trend') {
        return NextResponse.json({ error: 'trend drawing not found' }, { status: 404 })
      }
      if (drawing.symbol !== symbol) {
        return NextResponse.json({ error: 'drawing belongs to a different symbol' }, { status: 400 })
      }
      const level = Number(body.price)
      if (!Number.isFinite(level) || Math.abs(level) > 1e9) {
        return NextResponse.json({ error: 'numeric level required' }, { status: 400 })
      }
      const direction = body.direction === 'below' ? 'below' : 'above'
      const a = await db.alert.create({
        data: {
          userId: user.id, symbol, kind, price: level, direction,
          timeframe: validTf(body.timeframe),
          params: { drawingId },
          color: /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color! : '#f59e0b',
          note: body.note?.slice(0, 200) || 'Trend line',
          lastSide: null, // first check records the side without triggering
        },
      })
      return NextResponse.json({ alert: toDto(a) })
    }

    // ---- price alarm (legacy shape, unchanged semantics) ----
    const price = Number(body.price)
    if (!Number.isFinite(price)) {
      return NextResponse.json({ error: 'numeric price required' }, { status: 400 })
    }
    const direction = body.direction === 'below' ? 'below' : 'above'
    const a = await db.alert.create({
      data: {
        userId: user.id, symbol, kind: 'price', price, direction,
        color, note,
        lastSide: direction === 'above' ? 'below' : 'above',
      },
    })
    return NextResponse.json({ alert: toDto(a) })
  } catch (e) {
    return handleError(e)
  }
}
