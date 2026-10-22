import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { stopAlgoRun } from '@/lib/algo-engine'

export const dynamic = 'force-dynamic'

// POST /api/algo/[id]/stop — { flatten?: boolean } stop the engine (optionally
// market-close the run's position first)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await req.json().catch(() => ({})) as { flatten?: boolean }
    const run = await db.algoRun.findFirst({ where: { id, userId: user.id } })
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
    await stopAlgoRun(id, body.flatten === true)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
