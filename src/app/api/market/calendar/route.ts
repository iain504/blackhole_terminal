import { NextResponse } from 'next/server'
import { getEconomicCalendar } from '@/lib/calendar'
import { handleError } from '@/lib/api-helpers'

// GET /api/market/calendar — weekly economic events (ForexFactory mirror, bundled fallback)
export async function GET() {
  try {
    const { events, live } = await getEconomicCalendar()
    return NextResponse.json({ events, source: live ? 'forexfactory' : 'sample' })
  } catch (e) {
    return handleError(e)
  }
}
