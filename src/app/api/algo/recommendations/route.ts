// GET  /api/algo/recommendations (Task 90) — the "Recommended setups" feed for
// the Backtest page: the persisted sweep result (AlgoRecoCache) when present,
// else the baked-in static list; plus live refresh-job progress.
//
// POST /api/algo/recommendations — START a refresh: re-runs the full-catalog
// sweep matrix (7 symbols × 3 timeframes at max history, realistic costs) as
// an in-process background job (a full pass takes a few minutes — bar fetching
// dominates) and rewrites the cache when it finishes. Mutex-guarded: a second
// POST while one runs is a 409 with the current progress.
//
// GET response: {
//   running, done, total, startedAt?, lastError?,
//   generatedAt, method, source: 'db'|'baked', rows: AlgoRecommendation[]
// }
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { getRecoFeed, getRecoJobState, startRecoRefresh } from '@/lib/algo-reco'
import { rateLimit } from '@/lib/rate-limit'
import { memoryGuard, memoryGuardResponse } from '@/lib/mem-guard'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await requireUser()
    const job = getRecoJobState()
    const feed = await getRecoFeed()
    return NextResponse.json({
      running: job.running,
      done: job.done,
      total: job.total,
      startedAt: job.startedAt || null,
      lastError: job.error,
      generatedAt: feed.generatedAt,
      method: feed.method,
      source: feed.source,
      rows: feed.rows,
    })
  } catch (e) {
    return handleError(e)
  }
}

export async function POST(_req: NextRequest) {
  try {
    const user = await requireUser()
    // Task 3-d — throttle: a full matrix pass is a multi-minute CPU+data job;
    // 1 refresh per user per 10 min (the mutex below stops concurrency, this
    // stops repetition).
    const rl = rateLimit(`reco:${user.id}`, 1, 10 * 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `A refresh was started recently — retry in ${rl.retryAfterSec}s`, retryAfterSec: rl.retryAfterSec },
        { status: 429 },
      )
    }
    // Task 9-l — heap guard BEFORE spawning the multi-minute matrix job: the
    // sweep fetches 21 deep bar windows into caches and sims them; over the
    // heap ceiling that is a fatal process death. 503 while the heap is hot.
    const mem = memoryGuard(0.7)
    if (!mem.ok) {
      return NextResponse.json(memoryGuardResponse(mem), { status: 503, headers: { 'retry-after': '60' } })
    }
    const started = startRecoRefresh(user.id)
    const job = getRecoJobState()
    if (!started) {
      return NextResponse.json(
        { error: 'A recommendations refresh is already running', running: true, done: job.done, total: job.total },
        { status: 409 },
      )
    }
    return NextResponse.json({ started: true, running: true, done: 0, total: job.total })
  } catch (e) {
    return handleError(e)
  }
}
