import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { readJsonSafe } from '@/lib/validation'

export const dynamic = 'force-dynamic'

// /api/settings/ai-ops — account-level state for the two client-run AI
// engines (AI 自動交易 scanner + AI 護倉 steward), v2.12.24.
//
// The engines live in the BROWSER (module-scope setTimeout chains) and their
// enabled flag + config used to be localStorage-only: computer 2 never saw
// what computer 1 switched on. This route stores one row per (user, kind)
// (AiOpsState) — enabled + config + the elected runner (runnerId/runnerName/
// heartbeatAt). Clients keep it fresh via:
//   PUT      here      — user toggles / config edits (claim:true lets the
//                        toggling device take the runner slot immediately)
//   POST     heartbeat — every signed-in tab, 20s; atomically elects ONE
//                        runner (guarded updateMany in the heartbeat route)
//   POST     release   — pagehide beacon frees the slot for instant takeover
// Only the elected runner actually runs the engine; every other device shows
// 「其他裝置運行中」 and stays idle — two computers can never double-fire the
// same scanner, and a dead runner is taken over automatically.

const KINDS = new Set(['auto-trade', 'steward'])

interface PutBody {
  kind?: string
  enabled?: boolean
  config?: unknown
  claim?: boolean
  runnerId?: string
  deviceName?: string
}

/** Validate + normalize the config payload: must be a plain object, bounded
 *  (6 KB), with `enabled` stripped — the column owns that flag so a stale
 *  config echo can never flip the switch behind the user's back. */
function sanitizeConfig(raw: unknown): { ok: true; value: Prisma.InputJsonValue } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: {} as Prisma.InputJsonValue }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'config 必須是物件' }
  const clone = { ...(raw as Record<string, unknown>) }
  delete clone.enabled
  let s: string
  try { s = JSON.stringify(clone) } catch { return { ok: false, error: 'config 無法序列化' } }
  if (s.length > 6000) return { ok: false, error: 'config 過大（>6KB）' }
  try { return { ok: true, value: JSON.parse(s) as Prisma.InputJsonValue } } catch { return { ok: false, error: 'config 無法解析' } }
}

// PUT — upsert the enabled flag (+ optional config) for one engine kind.
// Enabling with claim:true + runnerId elects THIS device as the runner right
// away (the user is looking at it); a plain config push leaves the elected
// runner untouched. Disabling always clears the runner slot.
export async function PUT(req: Request) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`ai-ops-put:${user.id}`, 40, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many updates — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    const raw = await readJsonSafe(req)
    if (raw == null || typeof raw !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }
    const body = raw as PutBody
    const kind = String(body.kind ?? '')
    if (!KINDS.has(kind)) {
      return NextResponse.json({ error: 'kind 必須是 auto-trade 或 steward' }, { status: 400 })
    }
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled 必須是 boolean' }, { status: 400 })
    }
    const cfg = sanitizeConfig(body.config)
    if (!cfg.ok) return NextResponse.json({ error: cfg.error }, { status: 400 })
    const claim = body.claim === true && body.enabled
    const runnerId = typeof body.runnerId === 'string' ? body.runnerId.trim().slice(0, 100) : ''
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) : ''
    if (claim && !runnerId) {
      return NextResponse.json({ error: 'claim 需要 runnerId' }, { status: 400 })
    }

    const runnerData =
      body.enabled
        ? claim
          ? { runnerId, runnerName: deviceName || null, heartbeatAt: new Date() }
          : {}
        : { runnerId: null, runnerName: null, heartbeatAt: null }

    await db.aiOpsState.upsert({
      where: { userId_kind: { userId: user.id, kind } },
      update: { enabled: body.enabled, config: cfg.value, ...runnerData },
      create: {
        userId: user.id,
        kind,
        enabled: body.enabled,
        config: cfg.value,
        ...(claim ? { runnerId, runnerName: deviceName || null, heartbeatAt: new Date() } : {}),
      },
    })
    return NextResponse.json({ ok: true, enabled: body.enabled })
  } catch (e) {
    return handleError(e)
  }
}
