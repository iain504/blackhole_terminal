import { NextResponse } from 'next/server'
import { getQuotes, get52WeekRanges, hasAlpacaKeys } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { cachedJson } from '@/lib/api-cache'
import type { Week52Range } from '@/lib/alpaca'

interface Body {
  symbols: string[]
}

// POST /api/market/quote — batch quotes (stocks + crypto mixed)
//
// v2.11.3 — TTL-cached (5s): six independent client pollers (watchlist,
// quote panel, mobile watchlist, per-pane charts, landing ticker, demo-meta
// check) used to drive an external Binance/Alpaca fetch on EVERY request.
// The cache key includes the caller's has-keys status — the response body
// differs for keyed (real Alpaca snapshots) vs keyless (simulator) users, and
// hasAlpacaKeys is a cheap indexed read vs the external HTTP fan-out.
//
// v2.12.30 — every quote also carries its trailing 52-week high/low when the
// source can compute it (Alpaca weekly bars / Binance 1w klines). The w52
// pass is cached 30min per symbol-set (the annual range barely moves), so
// the pollers' 5s quote cadence never re-hits the bars endpoints.
export async function POST(req: Request) {
  try {
    const body = await readJson<Body>(req)
    const symbols = (body.symbols || [])
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 60)
    if (symbols.length === 0) return NextResponse.json({ quotes: [], meta: { demo: false } })
    const user = await getSessionUser()
    const keyed = user ? await hasAlpacaKeys(user.id) : false
    const result = await cachedJson(`q:${symbols.join(',')}:${keyed ? 'k' : 'n'}`, 5_000, () =>
      getQuotes(symbols, user?.id),
    )
    const { quotes, demo, reason, source } = result
    // v2.12.30 — merge the (cached) 52-week ranges in; fail-open: a w52
    // failure must never fail the quote response
    let enriched = quotes
    try {
      const w52 = await cachedJson<Record<string, Week52Range>>(
        `w52:${symbols.join(',')}:${keyed ? 'k' : 'n'}`,
        1_800_000,
        () => get52WeekRanges(symbols, user?.id),
      )
      if (w52 && Object.keys(w52).length > 0) {
        enriched = quotes.map((q) => {
          const r = w52[q.symbol]
          return r ? { ...q, weekHigh: r.weekHigh, weekLow: r.weekLow } : q
        })
      }
    } catch { /* absent weekHigh/weekLow = honest "source couldn't compute" */ }
    return NextResponse.json({ quotes: enriched, meta: { demo, reason, source } })
  } catch (e) {
    return handleError(e)
  }
}
