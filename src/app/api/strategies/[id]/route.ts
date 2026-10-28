import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { toDto } from '../route'
import { ensureStrategySupervisor } from '@/lib/strategy'
import { hasAlpacaKeys } from '@/lib/alpaca'

interface PatchBody {
  status?: string // 'armed' | 'paused'
  repeat?: boolean
  qty?: number
  tpMode?: string
  tpValue?: number | null
  slMode?: string
  slValue?: number | null
  /** Task 94 — move the rule to another pinned account. paper→live is an
   *  explicit opt-in: requires liveConfirm:true + live keys saved. live→paper
   *  (de-escalation) needs no confirmation. */
  mode?: string
  liveConfirm?: boolean
}

// pct values are PERCENT magnitudes (2 = 2%)
const clampPct = (v: number) => Math.min(100, Math.max(0.01, v))

/** Task 89 — validate one exit config; returns an error string or null.
 *  Mirrors the create route's validateExit (../route.ts) — PATCH used to
 *  skip it entirely, storing tpValue ≤ 0 / stale cross-basis values that the
 *  fire path then silently DROPPED (an armed rule with no stop). */
function validateExit(mode: string, value: number | null | undefined, label: string): string | null {
  if (mode === 'none') return null
  if (mode === 'price') {
    if (value == null || !Number.isFinite(value) || value <= 0) return `${label} price must be a positive number`
    return null
  }
  if (mode === 'pct') {
    if (value == null || !Number.isFinite(value) || value <= 0) return `${label} % must be a positive number`
    if (value > 100) return `${label} % must be ≤ 100`
    return null
  }
  return `${label} mode must be none, price or pct`
}

// PATCH /api/strategies/[id] — pause / re-arm / edit action side of a rule.
// Re-arming (from triggered/failed/paused → armed) resets lastSide to null so
// the next check just records the current side and only a REAL crossing
// afterwards fires (same semantics as indicator alarms).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await readJson<PatchBody>(req)
    const r = await db.strategyRule.findFirst({ where: { id, userId: user.id } })
    if (!r) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 })

    const data: Record<string, unknown> = {}
    if (body.status === 'armed' || body.status === 'paused') {
      data.status = body.status
      if (body.status === 'armed') {
        // fresh crossing memory on every re-arm
        data.lastSide = null
        data.triggeredAt = null
        data.fireNote = null
      }
    }
    // Task 94 — account move with the same opt-in rail as create:
    // paper→live needs liveConfirm + live keys; live→paper is always allowed.
    // Unknown mode values are rejected (review R-1#9) — strictness over a
    // silent no-op that would look like success to a scripted caller.
    if (body.mode !== undefined) {
      if (body.mode !== 'live' && body.mode !== 'paper') {
        return NextResponse.json({ error: 'mode must be "paper" or "live"' }, { status: 400 })
      }
      if (body.mode !== r.mode) {
        if (body.mode === 'live') {
          if (body.liveConfirm !== true) {
            return NextResponse.json({ error: 'Moving a rule to LIVE requires explicit confirmation (liveConfirm)' }, { status: 400 })
          }
          if (!(await hasAlpacaKeys(user.id, 'live'))) {
            return NextResponse.json({ error: 'No LIVE Alpaca keys saved — add them in Settings → API keys (Live account) before arming a live rule' }, { status: 400 })
          }
        }
        data.mode = body.mode
      }
    }
    if (typeof body.repeat === 'boolean') data.repeat = body.repeat
    if (typeof body.qty === 'number' && body.qty > 0 && Number.isFinite(body.qty) && body.qty <= 1_000_000) {
      // Task 89 — stocks trade whole shares (mirrors create; the broker
      // pipeline floors, so a fractional stock qty would trade a different
      // size than shown)
      if (!r.symbol.includes('/') && !Number.isInteger(body.qty)) {
        return NextResponse.json({ error: 'Stocks require a whole-number quantity — crypto supports fractional sizes' }, { status: 400 })
      }
      data.qty = body.qty
    }
    // Task 89 — validate the MERGED exit config with the create route's
    // rules. The old PATCH stored whatever arrived (≤ 0, wrong-basis values
    // on mode switches) and the fire path then silently dropped the leg.
    if (body.tpMode === 'none' || body.tpMode === 'price' || body.tpMode === 'pct') {
      const modeChanged = body.tpMode !== r.tpMode
      const provided = body.tpValue != null && Number.isFinite(Number(body.tpValue)) ? Number(body.tpValue) : null
      const merged = provided ?? (modeChanged ? null : r.tpValue)
      const err = validateExit(body.tpMode, merged, 'TP')
      if (err) return NextResponse.json({ error: err }, { status: 400 })
      data.tpMode = body.tpMode
      data.tpValue = body.tpMode === 'none' ? null : (body.tpMode === 'pct' ? clampPct(merged!) : merged)
    }
    if (body.slMode === 'none' || body.slMode === 'price' || body.slMode === 'pct') {
      const modeChanged = body.slMode !== r.slMode
      const provided = body.slValue != null && Number.isFinite(Number(body.slValue)) ? Number(body.slValue) : null
      const merged = provided ?? (modeChanged ? null : r.slValue)
      const err = validateExit(body.slMode, merged, 'SL')
      if (err) return NextResponse.json({ error: err }, { status: 400 })
      data.slMode = body.slMode
      data.slValue = body.slMode === 'none' ? null : (body.slMode === 'pct' ? clampPct(merged!) : merged)
    }

    const updated = await db.strategyRule.update({ where: { id }, data })
    // re-warm the supervisor (idle teardown may have stopped the timer, and a
    // scripted PATCH with no terminal open must still fire) — evaluation is
    // mode-agnostic, but the warm key carries the rule's PINNED mode
    ensureStrategySupervisor(user.id, updated.mode === 'live' ? 'live' : 'paper')
    return NextResponse.json({ strategy: toDto(updated) })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/strategies/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const r = await db.strategyRule.findFirst({ where: { id, userId: user.id } })
    if (!r) return NextResponse.json({ error: 'Strategy not found' }, { status: 404 })
    await db.strategyRule.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
