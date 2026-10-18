import { NextResponse } from 'next/server'
import { getEconomicCalendar } from '@/lib/calendar'
import { handleError } from '@/lib/api-helpers'

// GET /api/market/calendar[?fresh=1] — weekly economic events (ForexFactory XML/JSON mirror, bundled fallback).
// fresh=1 bypasses the 15-minute server cache (used right after a watched
// event's time passes so the published "actual" value shows up immediately).
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const fresh = searchParams.get('fresh') === '1'
    const { events, live, source } = await getEconomicCalendar({ fresh })
    return NextResponse.json({
      events,
      source: live ? (source ?? 'forexfactory') : 'sample',
    })
  } catch (e) {
    return handleError(e)
  }
}
