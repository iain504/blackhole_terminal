import { NextResponse } from 'next/server'
import { getQuotes } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'

interface Body {
  symbols: string[]
}

// POST /api/market/quote — batch quotes (stocks + crypto mixed)
export async function POST(req: Request) {
  try {
    const body = await readJson<Body>(req)
    const symbols = (body.symbols || [])
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 60)
    if (symbols.length === 0) return NextResponse.json({ quotes: [], meta: { demo: false } })
    const user = await getSessionUser()
    const { quotes, demo, reason } = await getQuotes(symbols, user?.id)
    return NextResponse.json({ quotes, meta: { demo, reason } })
  } catch (e) {
    return handleError(e)
  }
}
