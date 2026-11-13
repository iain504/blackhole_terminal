import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAssetInfo, resolveTradeMode, AssetInfo } from '@/lib/trading'
import { rateLimit } from '@/lib/rate-limit'
import { handleError } from '@/lib/api-helpers'

// GET /api/trading/assets?mode=paper&symbols=AAPL,BTC/USD,VIX
//
// v2.12.23 — batch tradability probe for the AI auto-trader. It used to
// evaluate and FIRE at symbols the broker cannot trade at all (VIX →
// "trading is not supported for us_index asset class") and to short spot
// crypto (BTC/USD SELL → "insufficient balance … available: 0"). The engine
// now asks here FIRST: each symbol resolves through getAssetInfo (Alpaca
// GET /v2/assets/{symbol}, cached server-side 6h including 404s) into
// { tradable, shortable, assetClass }.
//
// Contract with the engine:
// - missing/null entries = probe failed transiently (no keys / auth
//   breaker / network) → the engine degrades to its own static filters
//   and gates nothing extra;
// - tradable:false → the engine drops the symbol before any bars/model
//   call (VIX never burns tokens again);
// - shortable:false → the symbol stays evaluable, but a SHORT verdict is
//   rejected ("spot crypto cannot short") before any order goes out.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const rl = await rateLimit(`assets:${user.id}`, 30, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many requests — retry in ${rl.retryAfterSec}s` },
        { status: 429 },
      )
    }
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const symbols = (searchParams.get('symbols') || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9./:-]{1,15}$/.test(s))
      .slice(0, 50) // v2.12.40 — matches the scanner pool cap (maxSymbols 50);
                    // the old 30 left tail symbols unprobed (crypto sells
                    // slipped past the noShort set)
    if (symbols.length === 0) {
      return NextResponse.json({ error: 'symbols query param required (comma-separated)' }, { status: 400 })
    }
    const settled = await Promise.allSettled(symbols.map((s) => getAssetInfo(user.id, mode, s)))
    const assets: Record<string, AssetInfo> = {}
    let failed = 0
    symbols.forEach((s, i) => {
      const r = settled[i]
      if (r.status === 'fulfilled' && r.value) assets[s] = r.value
      else failed++
    })
    const allFailed = failed === symbols.length
    return NextResponse.json({
      mode,
      assets,
      // honest signal: every lookup failed transiently (no keys / breaker /
      // network) — the engine should NOT treat missing entries as verdicts
      ...(allFailed ? { probeFailed: true } : {}),
    })
  } catch (e) {
    return handleError(e)
  }
}
