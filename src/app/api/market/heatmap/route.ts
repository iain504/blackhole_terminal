import { NextResponse } from 'next/server'
import { getQuotes } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { US_HEAT_GROUPS, CRYPTO_UNIVERSE, HeatGroup, HeatSymbol } from '@/lib/market-types'

// GET /api/market/heatmap — % change for US stock groups + crypto.
// Symbols with NO quote data (dead feed / unknown ticker) return
// { symbol, pct: null, price: null } so the client renders them as visibly
// empty ("–" + muted tooltip) instead of a fake-flat 0% market.
export async function GET() {
  try {
    const user = await getSessionUser()
    const allSymbols = [
      ...US_HEAT_GROUPS.flatMap((g) => g.symbols),
      ...CRYPTO_UNIVERSE,
    ]
    const { quotes, demo } = await getQuotes(allSymbols, user?.id)
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]))
    const tileFor = (s: string): HeatSymbol => {
      const q = bySymbol.get(s)
      return q
        ? { symbol: s, pct: q.changePct, price: q.price }
        : { symbol: s, pct: null, price: null }
    }

    const us: HeatGroup[] = US_HEAT_GROUPS.map((g) => ({
      name: g.name,
      symbols: g.symbols.map(tileFor),
    }))
    const crypto: HeatGroup[] = [
      {
        name: 'Crypto (7×24)',
        symbols: CRYPTO_UNIVERSE.map(tileFor),
      },
    ]
    return NextResponse.json({ us, crypto, demo })
  } catch (e) {
    return handleError(e)
  }
}
