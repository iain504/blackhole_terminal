import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { hasAlpacaKeys } from '@/lib/alpaca'
import { resolveTradeMode } from '@/lib/trading'
import { resumeAlgoRun } from '@/lib/algo-engine'

export const dynamic = 'force-dynamic'

// POST /api/algo/[id]/start — restart a stopped run with the same config
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const run = await db.algoRun.findFirst({ where: { id, userId: user.id } })
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    if (run.status === 'running') return NextResponse.json({ ok: true })
    if (!(await hasAlpacaKeys(user.id))) {
      return NextResponse.json({ error: 'No Alpaca keys — add them in Settings first' }, { status: 400 })
    }
    if ((await resolveTradeMode(user.id)) === 'live') {
      return NextResponse.json({ error: 'Refusing to run algo in LIVE mode — switch the trade mode to paper' }, { status: 400 })
    }
    await resumeAlgoRun(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
