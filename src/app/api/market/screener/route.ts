import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { cachedJson, bustApiCache } from '@/lib/api-cache'
import { rateLimit } from '@/lib/rate-limit'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { runUniverseScreen, type ScreenerResult } from '@/lib/screener'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/market/screener[?sync=1]
//
// v2.12.34 — AUTO WATCHLIST for the AI auto-trader: screen the whole
// US-listed equity universe into a ranked Top-50 candidate pool
// (ATR14% 40% · dollar-volume 30% · rel-volume 15% · day-range 15%,
// cross-sectional percentile ranks — see src/lib/screener.ts).
//
// The heavy market-wide compute is identical for every account, so it is
// cached 15 min at the process level (single-flight — concurrent callers
// share one run; stale-while-error serves the last good screen during an
// upstream hiccup). `sync=1` busts the cache first — a manual re-screen is
// rate-limited to 2/min/user because one run costs ~110 snapshot calls.
//
// Per-user persistence (ScreenerPick, ≤ 50 rows) is BEST-EFFORT: it powers
// the panel's list after reload and the scanner's offline pool, but a DB
// failure must never fail the screen — the response still carries the picks.
export async function GET(req: Request) {
  try {
    const user = await requireUser()
    const { searchParams } = new URL(req.url)
    const sync = searchParams.get('sync') === '1'

    if (sync) {
      const rlSync = await rateLimit(`screener-sync:${user.id}`, 2, 60_000)
      if (!rlSync.ok) {
        return NextResponse.json(
          { error: `Too many re-screens — retry in ${rlSync.retryAfterSec}s` },
          { status: 429 },
        )
      }
    } else {
      const rl = await rateLimit(`screener:${user.id}`, 30, 60_000)
      if (!rl.ok) {
        return NextResponse.json(
          { error: `Too many requests — retry in ${rl.retryAfterSec}s` },
          { status: 429 },
        )
      }
    }

    const keyed = await hasAlpacaKeys(user.id)
    const KEY = `screener:v1:${keyed ? 'k' : 'n'}`
    if (sync) bustApiCache(KEY)

    const result = await cachedJson<ScreenerResult>(KEY, 15 * 60_000, () => runUniverseScreen(user.id))

    // best-effort per-user persistence (upsert the picks, prune the rest)
    if (result.picks.length > 0) {
      try {
        const syms = result.picks.map((p) => p.symbol)
        await db.screenerPick.deleteMany({ where: { userId: user.id, symbol: { notIn: syms } } })
        const now = new Date()
        for (const p of result.picks) {
          const row = {
            name: p.name,
            rank: p.rank,
            score: p.score,
            price: p.price,
            atrPct: p.atrPct,
            rangePct: p.rangePct,
            dollarVol: p.dollarVol,
            relVol: p.relVol,
            chgPct: p.chgPct,
            ret20: p.ret20,
            kind: p.kind,
            source: result.source,
            capturedAt: now,
          }
          await db.screenerPick.upsert({
            where: { userId_symbol: { userId: user.id, symbol: p.symbol } },
            create: { userId: user.id, symbol: p.symbol, ...row },
            update: row,
          })
        }
      } catch (e) {
        console.warn('[screener] persist picks failed:', e instanceof Error ? e.message : e)
      }
    }

    return NextResponse.json(result)
  } catch (e) {
    return handleError(e)
  }
}
