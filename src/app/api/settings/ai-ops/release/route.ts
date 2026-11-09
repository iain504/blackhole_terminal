import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { readJsonSafe } from '@/lib/validation'

export const dynamic = 'force-dynamic'

// POST /api/settings/ai-ops/release — pagehide beacon (v2.12.24). When the
// tab that was elected runner closes, there is no reason to make the other
// computers wait out the 75s staleness window: the closing tab sends this
// via navigator.sendBeacon and the slot is freed immediately, so takeover
// happens on the next 20s beat. Guarded by runnerId — a stale/foreign
// release can never clear someone else's slot.
interface ReleaseBody {
  kind?: string
  runnerId?: string
}

const KINDS = new Set(['auto-trade', 'steward'])

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`ai-ops-rel:${user.id}`, 20, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many releases — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    const raw = await readJsonSafe(req)
    if (raw == null || typeof raw !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }
    const body = raw as ReleaseBody
    const kind = String(body.kind ?? '')
    if (!KINDS.has(kind)) {
      return NextResponse.json({ error: 'kind 必須是 auto-trade 或 steward' }, { status: 400 })
    }
    const runnerId = typeof body.runnerId === 'string' ? body.runnerId.trim().slice(0, 100) : ''
    if (!runnerId) return NextResponse.json({ error: 'runnerId 不可空白' }, { status: 400 })
    const res = await db.aiOpsState.updateMany({
      where: { userId: user.id, kind, runnerId },
      data: { runnerId: null, runnerName: null, heartbeatAt: null },
    })
    return NextResponse.json({ ok: true, released: res.count })
  } catch (e) {
    return handleError(e)
  }
}
