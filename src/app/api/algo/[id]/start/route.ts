import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { hasAlpacaKeys } from '@/lib/alpaca'
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
    // v2.4.0 — LIVE UNLOCK (user directive, completes the v2.3.0 swing-lane
    // work): the mode is the user's explicit settings choice and Alpaca keys
    // are verified above — resuming a run in live is no longer refused.
    await resumeAlgoRun(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
