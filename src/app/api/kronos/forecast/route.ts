import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { getBars } from '@/lib/alpaca'
import { isCryptoSymbol, TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import {
  journalForecast, kronosHealth, kronosPollJob, kronosSubmitForecast, type KronosBar,
} from '@/lib/kronos'

// ---------------------------------------------------------------------------
// Kronos chart forecast — job-based end to end (forecast = ~8-50s of CPU):
//   POST /api/kronos/forecast  {symbol, tf, horizon, model?}
//     → fetches REAL bars via the app's own pipeline (demo data refused),
//       submits a sidecar job, returns { jobId, meta }.
//   GET  /api/kronos/forecast?job=ID → poll; on completion the forecast is
//     journaled (accountability) and returned with provenance.
// The browser draws p10/p50/p90 + P(up); it NEVER waits on a held connection.
// ---------------------------------------------------------------------------

interface JobMeta {
  userId?: string
  symbol: string
  tf: Timeframe
  market: 'stock' | 'crypto'
  horizon: number
  model: string
  createdAt: number
}
const jobs = new Map<string, JobMeta>()
const JOB_TTL_MS = 15 * 60_000
function gcJobs(): void {
  const now = Date.now()
  for (const [k, v] of jobs) if (now - v.createdAt > JOB_TTL_MS) jobs.delete(k)
}

// one in-flight job per (symbol|tf|horizon|bar) — double-clicks share it
const inflight = new Map<string, string>()
const INFLIGHT_TTL_MS = 15 * 60_000
const inflightAt = new Map<string, number>()

export async function POST(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Sign in to use Kronos forecasts' }, { status: 401 })
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const symbol = String(body.symbol || '').trim().toUpperCase()
    const tfParam = String(body.tf || '5m') as Timeframe
    const tf: Timeframe = TIMEFRAMES[tfParam] ? tfParam : '5m'
    const horizon = Math.max(6, Math.min(Number(body.horizon) || 24, 64))
    const model = body.model === 'small' ? 'small' : 'mini'
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })

    const health = await kronosHealth()
    if (!health?.ok) return NextResponse.json({ error: 'Kronos sidecar not reachable — is mini-services/kronos-service running?' }, { status: 503 })
    if (!health.ready) return NextResponse.json({ error: 'Kronos model still loading — try again in a minute' }, { status: 503 })

    // REAL bars only — the app's own pipeline (alpaca/binance, demo refused)
    const res = await getBars(symbol, tf, user.id, {})
    const bars = Array.isArray(res.bars) ? res.bars : []
    if (res.demo || bars.length < 64) {
      return NextResponse.json({ error: 'Not enough live history for a Kronos forecast (demo feed or short history)' }, { status: 400 })
    }
    const ctx = bars.slice(-512)
    const payloadBars: KronosBar[] = ctx.map((b) => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))

    gcJobs()
    const dedupKey = `${symbol}|${tf}|${horizon}|${ctx[ctx.length - 1]!.time}`
    const existing = inflight.get(dedupKey)
    if (existing && Date.now() - (inflightAt.get(dedupKey) ?? 0) < INFLIGHT_TTL_MS) {
      return NextResponse.json({ jobId: existing, meta: { symbol, tf, horizon, model, lastTime: ctx[ctx.length - 1]!.time, cached: true } })
    }

    const jobId = await kronosSubmitForecast({
      bars: payloadBars,
      horizon,
      samples: 8,
      market: isCryptoSymbol(symbol) ? 'crypto' : 'stock',
      tfSec: TIMEFRAMES[tf].seconds,
      model: model as 'mini' | 'small',
    })
    if (!jobId) return NextResponse.json({ error: 'Kronos sidecar refused the job' }, { status: 502 })
    jobs.set(jobId, { userId: user.id, symbol, tf, market: isCryptoSymbol(symbol) ? 'crypto' : 'stock', horizon, model, createdAt: Date.now() })
    inflight.set(dedupKey, jobId)
    inflightAt.set(dedupKey, Date.now())
    return NextResponse.json({ jobId, meta: { symbol, tf, horizon, model, lastTime: ctx[ctx.length - 1]!.time, bars: payloadBars.length } })
  } catch (e) {
    return handleError(e)
  }
}

export async function GET(req: Request) {
  try {
    await getSessionUser() // any signed-in session may poll; the jobId is the capability
    const { searchParams } = new URL(req.url)
    const jobId = (searchParams.get('job') || '').trim()
    if (!jobId) return NextResponse.json({ error: 'job required' }, { status: 400 })
    const st = await kronosPollJob(jobId)
    if (!st.done) return NextResponse.json({ done: false })
    const meta = jobs.get(jobId)
    if (st.result && meta) {
      await journalForecast({ userId: meta.userId, symbol: meta.symbol, tf: meta.tf, market: meta.market, result: st.result })
      jobs.delete(jobId)
      inflight.forEach((v, k) => { if (v === jobId) { inflight.delete(k); inflightAt.delete(k) } })
    }
    if (st.error) return NextResponse.json({ done: true, error: st.error })
    return NextResponse.json({ done: true, result: st.result })
  } catch (e) {
    return handleError(e)
  }
}
