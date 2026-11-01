// v2.5.0 — Market Sentiment Engine API.
//   GET  /api/sentiment?symbol=AAPL&scope=symbol|market&hours=48&headlines=20
//        → symbol snapshot + score history + recent scored headlines +
//          market-wide leaderboard (the autopilot's 100+12 universe) + job state
//   POST /api/sentiment { action: 'scan', symbols?: string[] }
//        → start the ingest+score sweep (≤3 symbols inline, larger in background)
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import {
  startSentimentScan, getScanState, getSentimentSummary,
  getSentimentHistory, getHeadlines, backfillSentimentHistory,
  startFleetSentimentRefresher,
} from '@/lib/sentiment-engine'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    await requireUser()
    // v2.7.0 — panel traffic bootstraps the fleet refresher (globalThis-guarded)
    startFleetSentimentRefresher()
    const sp = req.nextUrl.searchParams
    const symbol = (sp.get('symbol') || '').trim().toUpperCase() || null
    const scope = sp.get('scope') === 'market' ? 'market' : 'symbol'
    const hours = parseInt(sp.get('hours') || '48', 10) || 48
    const hlLimit = Math.min(parseInt(sp.get('headlines') || '20', 10) || 20, 50)

    const summary = scope === 'market'
      ? await getSentimentSummary()
      : ((await getSentimentSummary(symbol ? [symbol] : undefined)).slice(0, 1))

    const [history, headlines, state] = await Promise.all([
      symbol ? getSentimentHistory(symbol, hours) : Promise.resolve([]),
      getHeadlines(symbol, hlLimit),
      Promise.resolve(getScanState()),
    ])

    return NextResponse.json({ summary, history, headlines, state, symbol })
  } catch (e) {
    return handleError(e)
  }
}

interface SentimentPostBody {
  action?: 'scan' | 'backfill'
  symbols?: string[]
  days?: number
}

export async function POST(req: NextRequest) {
  try {
    await requireUser()
    const body = await readJson<SentimentPostBody>(req)
    // v2.7.0 — IC maturation: rebuild the hourly bucket history from the
    // headline journal (create-only; live buckets are never overwritten)
    if (body?.action === 'backfill') {
      const res = await backfillSentimentHistory(body.days ?? 10)
      return NextResponse.json({ ok: true, ...res })
    }
    if (body?.action !== 'scan') {
      return NextResponse.json({ error: 'Unknown action — use { action: "scan" } or { action: "backfill" }' }, { status: 400 })
    }
    const res = await startSentimentScan(body.symbols)
    if (!res.started && res.state.running) {
      return NextResponse.json(
        { error: 'A sentiment scan is already running', state: res.state },
        { status: 409 },
      )
    }
    return NextResponse.json({ ok: true, inline: res.inline, state: res.state })
  } catch (e) {
    return handleError(e)
  }
}
