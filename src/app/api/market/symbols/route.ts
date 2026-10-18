import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { getSymbolUniverse, searchSymbols, resolveSymbolExact, isValidSymbolFormat } from '@/lib/symbols'

// GET /api/market/symbols?q=SPA          → prediction list for the watchlist /
//                                           chart symbol search (symbols starting
//                                           with the query, then contains / name
//                                           matches, exact kept first)
// GET /api/market/symbols?q=AAPL&exact=1 → { valid } existence check used when
//                                           adding a symbol to a watchlist
//
// Exact matching is AUTHORITATIVE: a universe-cache miss falls back to a
// direct GET /v2/assets/{symbol} Alpaca lookup, so fresh listings (e.g. SPCX)
// resolve even before the bulk list refreshes.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    const url = new URL(req.url)
    const q = (url.searchParams.get('q') || '').trim().toUpperCase()
    if (!q || !isValidSymbolFormat(q)) {
      return NextResponse.json({ symbols: [], valid: false, source: 'none' })
    }

    if (url.searchParams.get('exact') === '1') {
      const hit = await resolveSymbolExact(q, user?.id)
      return NextResponse.json({
        valid: hit != null,
        name: hit?.name ?? null,
        exchange: hit?.exchange ?? null,
        crypto: hit?.crypto ?? false,
      })
    }

    const { entries, source } = await getSymbolUniverse(user?.id)
    // exact match (universe, crypto majors, or direct Alpaca lookup — the
    // lookup result is merged into the universe cache for future searches)
    const exact = await resolveSymbolExact(q, user?.id)
    const matches = searchSymbols(entries, q, exact ? 11 : 12)
    if (!exact && matches.length === 0) {
      return NextResponse.json({ symbols: [], source })
    }
    return NextResponse.json({ symbols: exact ? [exact, ...matches].slice(0, 12) : matches, source })
  } catch (e) {
    return handleError(e)
  }
}
