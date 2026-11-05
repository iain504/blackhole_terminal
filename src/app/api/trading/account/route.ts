import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAccount, resolveTradeMode, isTradeMode, isNoKeysError, isKeysUnreadableError, TradingAccount } from '@/lib/trading'
import { describeAlpacaKeys } from '@/lib/alpaca'
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
    // v2.12.3 — a broker-auth failure must NEVER leave this route as HTTP 401:
    // the account snapshot is polled from the terminal root seconds after
    // login (AccountOverview + TradeTicket), and the client's global 401
    // watcher treats ANY trading-route 401 as session death — the "auto
    // logout in 2 seconds" hosted report, round two (v2.12.2 fixed
    // fills/history; the toast then named THIS route). Return the Task-36
    // contract instead: 200 + structured authError, which the Positions tab
    // renders as the keys banner. Covers BOTH shapes tradeFetch produces:
    // the engaged breaker ({data:null,status:401,'auth-backoff:…'}) and the
    // live rejection ({data:<parsed 401 body>,status:401}).
    if (status === 401) {
      // v2.12.4 — name the pair in the banner too: the user can compare the
      // masked key id against their Alpaca dashboard without opening logs.
      const keysDesc = await describeAlpacaKeys(user.id, mode)
      return NextResponse.json({
        mode: isTradeMode(searchParams.get('mode')) ? searchParams.get('mode') : mode,
        account: null,
        configured: true,
        authError: {
          mode,
          message: `${mode === 'live' ? 'LIVE' : 'Paper'} keys rejected by Alpaca — account snapshot is paused until the keys are fixed (Settings → API keys). [using ${keysDesc}]`,
        },
      })
    }
    if (!data) {
      // v2.12.6 — saved pair couldn't be decrypted (APP_ENCRYPTION_SECRET
      // changed): the "whatever key I input, it still uses the env one" case.
      // Actionable re-save banner instead of a silent env substitution.
      if (isKeysUnreadableError(error)) {
        const keysDesc = await describeAlpacaKeys(user.id, mode)
        return NextResponse.json({
          mode: isTradeMode(searchParams.get('mode')) ? searchParams.get('mode') : mode,
          account: null,
          configured: true,
          authError: {
            mode,
            message: `Your saved ${mode === 'live' ? 'LIVE' : 'Paper'} keys couldn't be decrypted — re-enter them in Settings → API keys and save again. [using ${keysDesc}]`,
          },
        })
      }
      return NextResponse.json(
        { error: error || 'Trading API unavailable', mode, configured: !isNoKeysError(error) },
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
