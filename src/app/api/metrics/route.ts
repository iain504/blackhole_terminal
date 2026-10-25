// GET /api/metrics (Task 11-c) — OPTIONAL Prometheus scrape endpoint
// (text/plain; version=0.0.4). DISABLED by default: ENABLE_METRICS=1 opts in,
// because the payload (version, uptime, run counts) is mild but real
// information disclosure. Like /api/health it is unauthenticated — scrapers
// cannot do cookie auth — so keep it behind the reverse proxy when enabled.
//
// Values mirror /api/health (same 5s cache discipline); every sub-read is
// individually guarded so one broken dependency never hides the rest.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { APP_VERSION } from '@/generated/version'
import { rateLimitStore } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const ENABLED = process.env.ENABLE_METRICS === '1'
const CACHE_TTL_MS = 5000

let cache: { at: number; body: string } | null = null

function num(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`
}

async function render(): Promise<string> {
  const mem = process.memoryUsage()
  let dbUp = 0
  let algoRuns = -1
  let gridRuns = -1
  try {
    await db.$queryRaw`SELECT 1`
    dbUp = 1
  } catch {
    dbUp = 0
  }
  if (dbUp) {
    try {
      algoRuns = await db.algoRun.count({ where: { status: 'running' } })
    } catch {
      algoRuns = -1
    }
    try {
      gridRuns = await db.gridTrade.count({ where: { status: 'active' } })
    } catch {
      gridRuns = -1
    }
  }
  const info = `# HELP blackhole_build_info Build metadata (value is always 1)\n# TYPE blackhole_build_info gauge\nblackhole_build_info{version="${APP_VERSION.display}",sha="${APP_VERSION.sha}",branch="${APP_VERSION.branch}"} 1\n`
  return (
    info +
    num('blackhole_uptime_seconds', 'Process uptime in seconds', Math.round(process.uptime())) +
    num('blackhole_memory_rss_mb', 'Resident set size in megabytes', Math.round(mem.rss / (1024 * 1024))) +
    num('blackhole_memory_heap_mb', 'V8 heap used in megabytes', Math.round(mem.heapUsed / (1024 * 1024))) +
    num('blackhole_db_up', '1 when the database answers SELECT 1', dbUp) +
    num('blackhole_algo_runs_running', 'Algo runs in status=running (-1 unknown)', algoRuns) +
    num('blackhole_grid_trades_active', 'Grid trades in status=active (-1 unknown)', gridRuns) +
    num('blackhole_rate_limit_store_up', '1 when rate limits are served from the DB (0 = in-memory fallback)', rateLimitStore() === 'db' ? 1 : 0)
  )
}

export async function GET() {
  if (!ENABLED) {
    // 404, not 403 — the endpoint simply does not exist until opted into.
    return NextResponse.json({ error: 'metrics disabled (set ENABLE_METRICS=1)' }, { status: 404 })
  }
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return new NextResponse(cache.body, {
        headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    const body = await render()
    cache = { at: Date.now(), body }
    return new NextResponse(body, {
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'metrics render failed' }, { status: 500 })
  }
}
