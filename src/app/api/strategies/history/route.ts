import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, resolveTradeMode } from '@/lib/trading'
import { handleError } from '@/lib/api-helpers'
import { toDto, StrategyDto } from '@/app/api/strategies/route'
import { matchClosedTrades, indexTradesByOrder } from '@/lib/trade-history'
import { ClosedTrade } from '@/lib/market-types'
import { ensureStrategySupervisor } from '@/lib/strategy'

export interface StrategyFireDto {
  id: string
  ok: boolean
  message: string
  orderId: string | null
  createdAt: string
}

/** One rule + its fire history, attributed trades and P&L aggregates. */
export interface StrategyDetailDto extends StrategyDto {
  fires: StrategyFireDto[]
  /** realized round-trip trades attributed to this rule's fires (newest first) */
  trades: ClosedTrade[]
  realizedPnl: number
  tradeCount: number
  lastFireAt: string | null
  /** fires whose entry order no longer appears in the broker's recent closed orders (500 cap) */
  unresolvedFires: number
}

// GET /api/strategies/history — every strategy rule enriched with its fire
// log, the historical trades its fires produced (entry orderId matched
// against FIFO round-trips of the broker's closed orders) and the current +
// realized P&L aggregates. Powers the Strategy Orders tab.
export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const [rules, logs] = await Promise.all([
      db.strategyRule.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } }),
      db.strategyFireLog.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    ])
    const mode = await resolveTradeMode(user.id)
    ensureStrategySupervisor(user.id, mode)

    // broker round-trips for the strategy's trade mode
    const r = await getClosedOrders(user.id, mode, 500)
    const configured = !!r.data
    const trades = configured ? matchClosedTrades(Array.isArray(r.data) ? r.data : [], 300) : []
    const byOrder = indexTradesByOrder(trades)

    const logsByRule = new Map<string, typeof logs>()
    for (const l of logs) {
      const list = logsByRule.get(l.ruleId)
      if (list) list.push(l)
      else logsByRule.set(l.ruleId, [l])
    }

    const details: StrategyDetailDto[] = rules.map((rule) => {
      const fireLogs = (logsByRule.get(rule.id) || []).map(
        (l): StrategyFireDto => ({
          id: l.id,
          ok: l.ok,
          message: l.message,
          orderId: l.orderId,
          createdAt: l.createdAt.toISOString(),
        }),
      )
      // attribute trades: a fire's entry orderId appears in trade.orderIds
      const attributed = new Map<string, ClosedTrade>()
      let unresolved = 0
      for (const f of fireLogs) {
        if (!f.orderId) continue
        const hits = byOrder.get(f.orderId)
        if (!hits || hits.length === 0) {
          // not among the recent 500 closed orders (either too old, still
          // working, or the order never filled)
          unresolved += 1
          continue
        }
        for (const t of hits) attributed.set(t.id, t)
      }
      const ruleTrades = [...attributed.values()].sort(
        (a, b) => new Date(b.exitAt).getTime() - new Date(a.exitAt).getTime(),
      )
      const realizedPnl = ruleTrades.reduce((acc, t) => acc + t.pnl, 0)
      const lastFireAt = fireLogs[0]?.createdAt ?? rule.triggeredAt?.toISOString() ?? null
      return {
        ...toDto(rule),
        fires: fireLogs,
        trades: ruleTrades,
        realizedPnl,
        tradeCount: ruleTrades.length,
        lastFireAt,
        unresolvedFires: unresolved,
      }
    })

    return NextResponse.json({ mode, configured, rules: details })
  } catch (e) {
    return handleError(e)
  }
}
