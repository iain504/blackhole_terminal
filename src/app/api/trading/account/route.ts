import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAccount, resolveTradeMode, isTradeMode, TradingAccount } from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

// GET /api/trading/account?mode=paper|live — full account snapshot for the
// Positions tab: balance, buying power, daily P&L + every detail field.
// TradeTicket consumes equity/cash/buyingPower (strings) — kept as-is.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const { data, status, error } = await getAccount(user.id, mode)
    if (!data) {
      return NextResponse.json(
        { error: error || 'Trading API unavailable', mode, configured: error !== 'no-keys' },
        { status: status || 502 },
      )
    }
    const a = data as TradingAccount & Record<string, unknown>
    const equity = num(data.equity)
    const lastEquity = num(a.last_equity)
    const dailyPl = equity != null && lastEquity != null ? equity - lastEquity : null
    return NextResponse.json({
      mode: isTradeMode(searchParams.get('mode')) ? searchParams.get('mode') : mode,
      account: {
        // legacy string fields (TradeTicket)
        status: data.status,
        equity: data.equity,
        cash: data.cash,
        buyingPower: data.buying_power,
        currency: data.currency,
        // extended numeric fields (Positions tab)
        accountNumber: a.account_number ?? null,
        portfolioValue: num(a.portfolio_value),
        lastEquity,
        dailyPl,
        dailyPlPct: dailyPl != null && lastEquity ? (dailyPl / lastEquity) * 100 : null,
        regtBuyingPower: num(a.regt_buying_power),
        daytradeBuyingPower: num(a.daytrading_buying_power),
        nonMarginableBuyingPower: num(a.non_marginable_buying_power),
        daytradeCount: a.daytrade_count ?? null,
        multiplier: a.multiplier ?? null,
        shortingEnabled: a.shorting_enabled ?? null,
        tradingBlocked: a.trading_blocked ?? null,
        transfersBlocked: a.transfers_blocked ?? null,
        accountBlocked: a.account_blocked ?? null,
        patternDayTrader: a.pattern_day_trader ?? null,
        initialMargin: num(a.initial_margin),
        maintenanceMargin: num(a.maintenance_margin),
        sma: num(a.sma),
        createdAt: a.created_at ?? null,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}
