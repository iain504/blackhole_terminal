import { NextResponse } from 'next/server'
import { getEconomicCalendar } from '@/lib/calendar'
import { handleError } from '@/lib/api-helpers'

// GET /api/market/calendar[?fresh=1] — weekly economic events (ForexFactory XML/JSON mirror, bundled fallback).
// fresh=1 bypasses the 15-minute server cache (the calendar tab sends it on
// every open so the user always sees the latest data before it is shown).
// The "Actual" column is enriched server-side from ForexFactory's calendar
// page (the schedule mirrors never publish actuals) — see src/lib/calendar.ts.
// NOTE: the lib reports the specific mirror ('forexfactory-xml' / '-json') —
// normalize to the client-facing 'forexfactory' here, otherwise the UI shows
// a "Sample data" badge for perfectly live data.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const fresh = searchParams.get('fresh') === '1'
    const { events, live, source } = await getEconomicCalendar({ fresh })
    return NextResponse.json({
      events,
      source: live ? 'forexfactory' : 'sample',
      detail: source,
    })
  } catch (e) {
    return handleError(e)
  }
}
