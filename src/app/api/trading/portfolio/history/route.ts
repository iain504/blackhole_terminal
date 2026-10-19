import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getPortfolioHistory, resolveTradeMode, isTradeMode } from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'

// GET /api/trading/portfolio/history?mode=paper&range=today|hour|day|week|month|year
// Equity curve for the Positions tab — proxies Alpaca's
// /v2/account/portfolio/history with per-range period/timeframe combos and
// fallbacks. Verified against the live paper API (2026-10):
//   timeframes are 1Min/5Min/15Min/1H/1D (NOT 1Hour/1Day) and any period
//   longer than 30 days ONLY accepts 1D ("invalid timeframe provided: 1H.
//   Valid timeframe for days > 30 is 1D").
//   The 1D period returns the LAST SESSION's grid (Fri 04:00–20:00 ET), NOT a
//   trailing 24h — so a strict "since local midnight" slice is empty on
//   weekends/holidays. `today` therefore falls back to the last session
//   (flagged via `fallback: 'last-session'`) when it has fewer than 2 points.
//
// Ranges:
//   today → since local midnight (1D @ 1Min, sliced by client tzOffset;
//           falls back to the last session when today has no data yet)
//   hour  → last ~60 minutes  (1D @ 1Min, sliced)
//   day   → session           (1D @ 5Min)
//   week  → 7 days            (1W @ 1H, fallback 7D)
//   month → 1 month, daily    (1M @ 1D — hourly is rejected by Alpaca)
//   year  → 1 year, daily     (1A @ 1D, fallbacks 1Y/2A)
const COMBOS: Record<string, [string, string][]> = {
  today: [['1D', '1Min'], ['1D', '5Min']],
  hour: [['1D', '1Min'], ['1D', '5Min']],
  day: [['1D', '5Min'], ['1D', '15Min']],
  week: [['1W', '1H'], ['7D', '1H']],
  month: [['1M', '1D'], ['3M', '1D']],
  year: [['1A', '1D'], ['1Y', '1D'], ['2A', '1D']],
}

const HOUR_POINTS = 60

interface RawHistory {
  timestamp: number[]
  equity?: (number | null)[]
  profit_loss?: (number | null)[]
  profit_loss_pct?: (number | null)[]
  timeframe?: string
  base_value?: number | null
}

interface Built {
  period: string
  timeframe: string
  raw: RawHistory
  points: { t: number; eq: number; pl: number | null; plPct: number | null }[]
}

/** Epoch seconds of "local midnight" given the browser's UTC offset in minutes
 *  (Date#getTimezoneOffset convention: UTC+1 → -60). */
const localMidnightSec = (tzOffsetMin: number): number => {
  const nowSec = Math.floor(Date.now() / 1000)
  return Math.floor((nowSec - tzOffsetMin * 60) / 86400) * 86400 + tzOffsetMin * 60
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const rangeParam = searchParams.get('range') || 'day'
    const range = rangeParam in COMBOS ? rangeParam : 'day'
    const modeEcho = isTradeMode(searchParams.get('mode')) ? searchParams.get('mode') : mode

    // "Today" = since local midnight, using the CLIENT's timezone offset so
    // the slice matches what the user sees on their clock.
    let sinceTs: number | null = null
    if (range === 'today') {
      const tzRaw = Number(searchParams.get('tzOffset'))
      const tzMin = Number.isFinite(tzRaw) && tzRaw >= -840 && tzRaw <= 840 ? tzRaw : 0
      sinceTs = localMidnightSec(tzMin)
    }

    const build = (raw: RawHistory, since: number | null, isHour: boolean): Built['points'] => {
      let ts = raw.timestamp
      let eq = raw.equity || []
      let pl = raw.profit_loss || []
      let plPct = raw.profit_loss_pct || []
      // "Hour" = the trailing 60 minutes of the 1D/1Min series
      if (isHour && ts.length > HOUR_POINTS) {
        const start = ts.length - HOUR_POINTS
        ts = ts.slice(start)
        eq = eq.slice(start)
        pl = pl.slice(start)
        plPct = plPct.slice(start)
      }
      const points: Built['points'] = []
      for (let i = 0; i < ts.length; i++) {
        const e = eq[i]
        if (e == null || !Number.isFinite(e)) continue // market-closed slots
        if (since != null && ts[i] < since) continue // before local midnight (today range)
        points.push({ t: ts[i], eq: e, pl: pl[i] ?? null, plPct: plPct[i] ?? null })
      }
      return points
    }

    const tryCombos = async (
      combos: [string, string][],
      since: number | null,
      isHour: boolean,
    ): Promise<{ noKeys: true } | Built | null> => {
      for (const [period, timeframe] of combos) {
        const r = await getPortfolioHistory(user.id, mode, period, timeframe)
        if (r.error === 'no-keys') return { noKeys: true }
        if (r.data && r.data.timestamp && Array.isArray(r.data.timestamp)) {
          const raw = r.data as RawHistory
          return { period, timeframe: raw.timeframe || timeframe, raw, points: build(raw, since, isHour) }
        }
        // 400/404/empty → try the next period/timeframe combo
      }
      return null
    }

    const noKeysRes = () =>
      NextResponse.json({ range, mode: modeEcho, points: [], error: 'no-keys' })

    let res = await tryCombos(COMBOS[range], sinceTs, range === 'hour')
    if (res && 'noKeys' in res) return noKeysRes()

    // Today fallback: weekends/holidays (or before any fill/equity change
    // today) leave the midnight slice empty — show the last session instead,
    // clearly flagged so the UI can label it honestly.
    let fallback: 'last-session' | null = null
    if (range === 'today' && (!res || res.points.length < 2)) {
      const fb = await tryCombos(COMBOS.day, null, false)
      if (fb && 'noKeys' in fb) return noKeysRes()
      if (fb) {
        res = fb
        fallback = 'last-session'
      }
    }

    if (!res) {
      return NextResponse.json({
        range,
        mode: modeEcho,
        points: [],
        error: 'No equity history available for this range',
      })
    }
    return NextResponse.json({
      range,
      mode: modeEcho,
      period: res.period,
      timeframe: res.timeframe,
      baseValue: res.raw.base_value ?? null,
      points: res.points,
      fallback,
    })
  } catch (e) {
    return handleError(e)
  }
}
