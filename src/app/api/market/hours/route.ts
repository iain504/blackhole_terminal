import { NextResponse } from 'next/server'
import { getMarketHours } from '@/lib/market-hours'
import { getSessionUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { isValidSymbolFormat } from '@/lib/market-types'

interface Body {
  symbols: string[]
}

// POST /api/market/hours — market session status per symbol (Task 35).
// US equities: Alpaca /v2/clock + /v1/calendar (pre/post/regular/closed).
// Crypto: Alpaca /v2/assets status — crypto trades 24/7 (open vs closed).
export async function POST(req: Request) {
  try {
    const body = await readJson<Body>(req)
    const symbols = (body.symbols || [])
      .map((s) => String(s).trim().toUpperCase())
      .filter((s) => s && isValidSymbolFormat(s))
      .slice(0, 30)
    if (symbols.length === 0) {
      return NextResponse.json({ hours: {}, meta: { demo: false } })
    }
    const user = await getSessionUser()
    const response = await getMarketHours(symbols, user?.id)
    return NextResponse.json(response)
  } catch (e) {
    return handleError(e)
  }
}
