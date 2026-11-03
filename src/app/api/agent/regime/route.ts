// GET /api/agent/regime — the US-tape regime snapshot for the Agent tab's
// regime chip (v2.10.0). Same engine the autopilot pipeline and the fleet's
// per-entry regime gate read; the 15-min snapshot cache makes this route
// effectively free to poll. The chip renders RISK_ON / NEUTRAL / RISK_OFF /
// UNKNOWN with the engine's reasons as the tooltip.
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { getRegimeSnapshot } from '@/lib/regime-engine'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireUser()
    const snap = await getRegimeSnapshot(user.id)
    return NextResponse.json(snap)
  } catch (e) {
    return handleError(e)
  }
}
