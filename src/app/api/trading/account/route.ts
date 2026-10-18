import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAccount, resolveTradeMode, isTradeMode } from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'

// GET /api/trading/account?mode=paper|live — account status for the trade ticket
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
    return NextResponse.json({
      mode: isTradeMode(searchParams.get('mode')) ? searchParams.get('mode') : mode,
      account: {
        status: data.status,
        equity: data.equity,
        cash: data.cash,
        buyingPower: data.buying_power,
        currency: data.currency,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}
