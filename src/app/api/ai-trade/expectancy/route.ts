import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, resolveTradeMode, isNoKeysError, isKeysUnreadableError } from '@/lib/trading'
import { matchFifo } from '@/lib/trade-history'
import { computeExpectancy, recoveryGainPct, expectancyNote, type ExpectancyInput } from '@/lib/met-engine'
import { handleError } from '@/lib/api-helpers'

// v2.12.61 — 期望值審計 (M.E.T. Ch.16 homework, applied to the terminal).
// 「將自己的數字計出來 才可以回答 你那套交易系統真的賺到錢嗎」 — this route
// FIFO-matches the broker's closed orders (the SAME walk the trade-history
// route uses, so the two never disagree) and computes the honest statistics:
// win rate, avg win/loss, realized payoff, per-trade expectancy, Profit
// Factor, breakeven win rate, compounded cumulative return + max drawdown,
// and the longest losing streak (Ch.12's risk-of-ruin context). Two samples:
// ALL closed trades of the account, and the AI-source subset (entry orders
// tagged tta- by the auto-trader) — Ch.16 counts every SYSTEM trade, and our
// system's own ledger is the tta- subset. Pure math lives in met-engine.ts.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const daysRaw = Number(searchParams.get('days'))
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.round(daysRaw)) : 180
    const cutoff = Date.now() - days * 86_400_000

    const r = await getClosedOrders(user.id, mode, 500)
    if (!r.data) {
      if (isNoKeysError(r.error)) return NextResponse.json({ mode, days, configured: false, overall: null, ai: null })
      if (isKeysUnreadableError(r.error)) return NextResponse.json({ mode, days, configured: true, authError: true, overall: null, ai: null })
      return NextResponse.json({ error: r.error || 'Closed orders fetch failed' }, { status: r.status || 502 })
    }
    const orders = Array.isArray(r.data) ? r.data : []
    const fm = matchFifo(orders, 1000)
    const inWindow: ExpectancyInput[] = fm.trades
      .filter((t) => Date.parse(t.exitAt || '') >= cutoff)
      .map((t) => ({ pnl: t.pnl, pnlPct: t.pnlPct, side: t.side, source: t.source, symbol: t.symbol, exitAt: t.exitAt }))
    const aiRows = inWindow.filter((t) => t.source === 'ai')

    const overall = computeExpectancy(inWindow)
    const ai = aiRows.length > 0 ? computeExpectancy(aiRows) : null
    return NextResponse.json({
      mode,
      days,
      configured: true,
      overall,
      ai,
      // Ch.13 — the asymmetry table: 蝕 50% 要賺 100% 才回本
      recovery: [5, 10, 20, 30, 50].map((l) => ({ lossPct: l, needPct: Number(recoveryGainPct(l).toFixed(1)) })),
      note: expectancyNote(overall),
      aiNote: ai ? expectancyNote(ai) : null,
    })
  } catch (e) {
    return handleError(e)
  }
}
