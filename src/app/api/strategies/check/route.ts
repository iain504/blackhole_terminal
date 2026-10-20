import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { evaluateStrategies, ensureStrategySupervisor } from '@/lib/strategy'
import { resolveTradeMode } from '@/lib/trading'

// POST /api/strategies/check — poll engine: evaluate armed strategy rules for
// this user and place the orders whose conditions fire. The client terminal
// polls every ~20s; an in-process supervisor (warmed by GET /api/strategies
// and here) keeps rules evaluating server-side even with no tab open.
// Returns the fires of THIS request so the UI can toast them.
export async function POST() {
  try {
    const user = await requireUser()
    const mode = await resolveTradeMode(user.id)
    ensureStrategySupervisor(user.id, mode)
    const fires = await evaluateStrategies(user.id, mode)
    return NextResponse.json({ fired: fires, checked: true })
  } catch (e) {
    return handleError(e)
  }
}
