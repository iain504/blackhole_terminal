import { NextResponse } from 'next/server'
import { getQuotes, hasAlpacaKeys } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { cachedJson } from '@/lib/api-cache'

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
    return NextResponse.json({ quotes, meta: { demo, reason, source } })
  } catch (e) {
    return handleError(e)
  }
}
