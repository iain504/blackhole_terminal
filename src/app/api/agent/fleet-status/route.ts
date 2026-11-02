// GET /api/agent/fleet-status — ultra-light presence probe for the bottom-bar
// FSD-running indicator (desktop footer + mobile bottom nav, v2.8.3). Returns
// ONLY the latest session's engagement state — no events/runs/candidates
// payloads (the full /api/agent state is far too heavy to poll from chrome
// that lives on every tab).
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireUser()
    const session = await db.agentSession.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { status: true, phase: true },
    })
    return NextResponse.json({
      engaged: session?.status === 'engaged',
      status: session?.status ?? null,
      phase: session?.phase ?? null,
    })
  } catch (e) {
    return handleError(e)
  }
}
