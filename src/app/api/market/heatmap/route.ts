import { NextResponse } from 'next/server'
import { getQuotes } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { US_HEAT_GROUPS, CRYPTO_UNIVERSE, HeatGroup } from '@/lib/market-types'

// GET /api/market/heatmap — % change for US stock groups + crypto
export async function GET() {
  try {
    const user = await getSessionUser()
    const allSymbols = [
      ...US_HEAT_GROUPS.flatMap((g) => g.symbols),
      ...CRYPTO_UNIVERSE,
    ]
    const { quotes, demo } = await getQuotes(allSymbols, user?.id)
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]))

    const us: HeatGroup[] = US_HEAT_GROUPS.map((g) => ({
      name: g.name,
      symbols: g.symbols
        .map((s) => {
          const q = bySymbol.get(s)
          return q ? { symbol: s, pct: q.changePct, price: q.price } : { symbol: s, pct: 0, price: 0 }
        }),
    }))
    const crypto: HeatGroup[] = [
      {
        name: 'Crypto (7×24)',
        symbols: CRYPTO_UNIVERSE.map((s) => {
          const q = bySymbol.get(s)
          return q ? { symbol: s, pct: q.changePct, price: q.price } : { symbol: s, pct: 0, price: 0 }
        }),
      },
    ]
    return NextResponse.json({ us, crypto, demo })
  } catch (e) {
    return handleError(e)
  }
}
