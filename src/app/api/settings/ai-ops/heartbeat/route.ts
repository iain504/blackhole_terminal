import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { readJsonSafe } from '@/lib/validation'

export const dynamic = 'force-dynamic'

// POST /api/settings/ai-ops/heartbeat — the ONE call that keeps the two AI
// engines (AI 自動交易 + AI 護倉) in sync across every signed-in computer.
//
// Every signed-in tab posts this every 20s (plus once immediately on login)
// for each kind. The response tells the tab exactly what to do:
//   { enabled:false }                  → stop the engine locally (someone
//                                        switched it off on another device)
//   { isRunner:true }                  → YOU run the engine (start it if it
//                                        isn't already)
//   { isRunner:false, runnerName }     → another device is the runner — stay
//                                        idle and show 「其他裝置運行中」
// The election is an ATOMIC guarded updateMany: the caller wins the slot when
// it is already theirs, the slot is free, or the sitting runner's heartbeat
// went stale (>STALE_MS — dead tab / closed laptop / lost network). Two
// devices racing for the same dead slot resolve to exactly one winner
// server-side; the loser simply sees isRunner:false. The response also
// carries the stored config so devices adopt config edits made elsewhere,
// and a missing row (fresh install) lets the client migrate its localStorage
// state up via the PUT route.

const KINDS = new Set(['auto-trade', 'steward'])
/** A runner silent longer than this is considered dead (client beats every
 *  20s; a pagehide beacon releases the slot instantly on a clean close). */
const STALE_MS = 75_000

interface HeartbeatBody {
  kind?: string
  runnerId?: string
  deviceName?: string
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`ai-ops-hb:${user.id}`, 60, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many heartbeats — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    const raw = await readJsonSafe(req)
    if (raw == null || typeof raw !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }
    const body = raw as HeartbeatBody
    const kind = String(body.kind ?? '')
    if (!KINDS.has(kind)) {
      return NextResponse.json({ error: 'kind 必須是 auto-trade 或 steward' }, { status: 400 })
    }
    const runnerId = typeof body.runnerId === 'string' ? body.runnerId.trim().slice(0, 100) : ''
    if (!runnerId) return NextResponse.json({ error: 'runnerId 不可空白' }, { status: 400 })
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) : ''

    const row = await db.aiOpsState.findUnique({
      where: { userId_kind: { userId: user.id, kind } },
    })
    if (!row) {
      // Fresh install / never synced — the client migrates its localStorage
      // state up (PUT) on seeing exists:false.
      return NextResponse.json({ exists: false, enabled: false, config: null })
    }
    if (!row.enabled) {
      return NextResponse.json({ exists: true, enabled: false, config: row.config ?? null })
    }

    // Atomic election: claim the runner slot if it's mine, free, or stale.
    const staleBefore = new Date(Date.now() - STALE_MS)
    const claim = await db.aiOpsState.updateMany({
      where: {
        userId: user.id,
        kind,
        enabled: true,
        OR: [
          { runnerId },
          { runnerId: null },
          { runnerId: '' },
          { heartbeatAt: null },
          { heartbeatAt: { lt: staleBefore } },
        ],
      },
      data: { runnerId, runnerName: deviceName || null, heartbeatAt: new Date() },
    })
    if (claim.count > 0) {
      return NextResponse.json({ exists: true, enabled: true, isRunner: true, config: row.config ?? null })
    }
    // Slot belongs to another live runner — report it honestly.
    return NextResponse.json({
      exists: true,
      enabled: true,
      isRunner: false,
      runnerName: row.runnerName ?? '',
      config: row.config ?? null,
    })
  } catch (e) {
    return handleError(e)
  }
}
