import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { kronosHealth, kronosHitRate, realizePendingForecasts } from '@/lib/kronos'
import { db } from '@/lib/db'

// GET /api/kronos/status — sidecar health + the model's REALIZED accuracy.
// Also lazily resolves pending journal entries whose horizon-end bar now
// exists (the accountability loop: every forecast eventually gets a grade).
export async function GET() {
  try {
    const user = await getSessionUser()
    // realization is user-agnostic (forecasts are graded against market data)
    const resolved = await realizePendingForecasts().catch(() => 0)
    const health = await kronosHealth()
    const hitRate = await kronosHitRate()
    const recent = await db.kronosForecast.findMany({
      where: user ? { userId: user.id } : {},
      orderBy: { madeAt: 'desc' },
      take: 12,
      select: {
        id: true, symbol: true, tf: true, model: true, madeAt: true, barTime: true,
        horizonBars: true, lastClose: true, endP50: true, upProb: true, bandPct: true,
        realizedClose: true, hit: true, absErrPct: true, realizedAt: true, tfSec: true,
      },
    })
    return NextResponse.json({
      available: !!health?.ready,
      loading: !!health?.loading,
      error: health?.error ?? null,
      lanes: health?.lanes ?? {},
      uptimeSec: health?.uptimeSec ?? null,
      hitRate,
      resolvedNow: resolved,
      recent,
    })
  } catch (e) {
    return handleError(e)
  }
}
