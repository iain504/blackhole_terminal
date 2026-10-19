import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getPortfolioHistory, resolveTradeMode, isTradeMode } from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'

// GET /api/trading/portfolio/history?mode=paper&range=hour|day|week|month|year
// Equity curve for the Positions tab — proxies Alpaca's
// /v2/account/portfolio/history with per-range period/timeframe combos and
// fallbacks. Verified against the live paper API (2026-10):
//   timeframes are 1Min/5Min/15Min/1H/1D (NOT 1Hour/1Day) and any period
//   longer than 30 days ONLY accepts 1D ("invalid timeframe provided: 1H.
//   Valid timeframe for days > 30 is 1D").
//
// Ranges:
//   hour  → last ~60 minutes  (1D @ 1Min, sliced)
//   day   → session           (1D @ 5Min)
//   week  → 7 days            (1W @ 1H, fallback 7D)
//   month → 1 month, daily    (1M @ 1D — hourly is rejected by Alpaca)
//   year  → 1 year, daily     (1A @ 1D, fallbacks 1Y/2A)
const COMBOS: Record<string, [string, string][]> = {
  hour: [['1D', '1Min'], ['1D', '5Min']],
  day: [['1D', '5Min'], ['1D', '15Min']],
  week: [['1W', '1H'], ['7D', '1H']],
  month: [['1M', '1D'], ['3M', '1D']],
  year: [['1A', '1D'], ['1Y', '1D'], ['2A', '1D']],
}

const HOUR_POINTS = 60

export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const rangeParam = searchParams.get('range') || 'day'
    const range = rangeParam in COMBOS ? rangeParam : 'day'
    const modeEcho = isTradeMode(searchParams.get('mode')) ? searchParams.get('mode') : mode

    for (const [period, timeframe] of COMBOS[range]) {
      const r = await getPortfolioHistory(user.id, mode, period, timeframe)
      if (r.error === 'no-keys') {
        return NextResponse.json({ range, mode: modeEcho, points: [], error: 'no-keys' })
      }
      if (r.data && r.data.timestamp && Array.isArray(r.data.timestamp)) {
        const raw = r.data
        let ts = raw.timestamp
        let eq = raw.equity || []
        let pl = raw.profit_loss || []
        let plPct = raw.profit_loss_pct || []
        // "Hour" = the trailing 60 minutes of the 1D/1Min series
        if (range === 'hour' && ts.length > HOUR_POINTS) {
          const start = ts.length - HOUR_POINTS
          ts = ts.slice(start)
          eq = eq.slice(start)
          pl = pl.slice(start)
          plPct = plPct.slice(start)
        }
        const points: { t: number; eq: number; pl: number | null; plPct: number | null }[] = []
        for (let i = 0; i < ts.length; i++) {
          const e = eq[i]
          if (e == null || !Number.isFinite(e)) continue // market-closed slots
          points.push({ t: ts[i], eq: e, pl: pl[i] ?? null, plPct: plPct[i] ?? null })
        }
        return NextResponse.json({
          range,
          mode: modeEcho,
          period,
          timeframe: raw.timeframe || timeframe,
          baseValue: raw.base_value ?? null,
          points,
        })
      }
      // 400/404/empty → try the next period/timeframe combo
    }
    return NextResponse.json({
      range,
      mode: modeEcho,
      points: [],
      error: 'No equity history available for this range',
    })
  } catch (e) {
    return handleError(e)
  }
}
