import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { CRYPTO_UNIVERSE } from '@/lib/market-types'
import { getSymbolUniverse, searchSymbols, findExactSymbol, isValidSymbolFormat, SymbolEntry } from '@/lib/symbols'

// GET /api/market/symbols?q=SPA          → prediction list for the watchlist input
//                                           (symbols starting with the query, then
//                                           contains / name matches, exact kept first)
// GET /api/market/symbols?q=AAPL&exact=1 → { valid } existence check used when
//                                           adding a symbol to a watchlist
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    const url = new URL(req.url)
    const q = (url.searchParams.get('q') || '').trim().toUpperCase()
    if (!q || !isValidSymbolFormat(q)) {
      return NextResponse.json({ symbols: [], valid: false, source: 'none' })
    }
    const { entries, source } = await getSymbolUniverse(user?.id)
    const cryptoEntry = (s: string): SymbolEntry =>
      ({ symbol: s, name: 'Crypto pair', exchange: 'CRYPTO', crypto: true })

    if (url.searchParams.get('exact') === '1') {
      const hit = findExactSymbol(entries, q) ?? (CRYPTO_UNIVERSE.includes(q) ? cryptoEntry(q) : null)
      return NextResponse.json({ valid: hit != null, source })
    }

    const exact = findExactSymbol(entries, q) ?? (CRYPTO_UNIVERSE.includes(q) ? cryptoEntry(q) : null)
    const matches = searchSymbols(entries, q, exact ? 11 : 12)
    if (!exact && matches.length === 0) {
      // crypto prefix fallback (crypto majors are not in the equity asset list)
      const cryptoHits = CRYPTO_UNIVERSE.filter((s) => s !== q && s.startsWith(q)).map(cryptoEntry)
      return NextResponse.json({ symbols: cryptoHits.slice(0, 12), source })
    }
    return NextResponse.json({ symbols: exact ? [exact, ...matches].slice(0, 12) : matches, source })
  } catch (e) {
    return handleError(e)
  }
}
