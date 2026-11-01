// v2.4.0 — Nebula Autopilot API (智慧體).
//   GET  /api/agent              → latest session + candidates + brain feed + fleet runs
//   POST /api/agent { action }   → start | abort | engage | disengage | update | delete
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { resolveTradeMode } from '@/lib/trading'
import { hasAlpacaKeys } from '@/lib/alpaca'
import {
  startAgentScan, abortAgentScan, engageAgent, disengageAgent,
  updateAgentSettings, deleteAgentSession, getAgentState, agentJobRunning,
} from '@/lib/agent-engine'
import { AGENT_US_100 } from '@/lib/agent-universe'
import { memoryGuard, memoryGuardResponse } from '@/lib/mem-guard'
import type { AgentSettings } from '@/lib/agent-types'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await requireUser()
    const [state, mode, configured] = await Promise.all([
      getAgentState(user.id),
      resolveTradeMode(user.id),
      hasAlpacaKeys(user.id),
    ])
    return NextResponse.json({
      session: state?.session ?? null,
      candidates: state?.candidates ?? [],
      events: state?.events ?? [],
      runs: state?.runs ?? [],
      mode,
      configured,
      universeSize: AGENT_US_100.length,
      usCount: AGENT_US_100.length,
      jobRunning: agentJobRunning(user.id),
    })
  } catch (e) {
    return handleError(e)
  }
}

interface AgentPostBody {
  action?: 'start' | 'abort' | 'engage' | 'disengage' | 'update' | 'delete'
  sessionId?: string
  flatten?: boolean
  settings?: Partial<AgentSettings>
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await readJson<AgentPostBody>(req)
    const action = body?.action

    // the scan pipeline is the heaviest thing in the app — gate on heap like
    // the backtest POST does
    if (action === 'start') {
      const mem = memoryGuard(0.7)
      if (!mem.ok) {
        return NextResponse.json(memoryGuardResponse(mem), { status: 503 })
      }
      const res = await startAgentScan(user.id, body?.settings ?? {})
      if (res === 'busy') {
        return NextResponse.json({ error: 'An autopilot pipeline is already running — abort it first or wait for READY.' }, { status: 409 })
      }
      // v2.5.1 — pre-flight guard result (disk full): refuse cleanly with the
      // actionable message instead of letting the pipeline die mid-storm.
      if (typeof res === 'object' && res !== null && 'error' in res) {
        return NextResponse.json({ error: res.error }, { status: 507 })
      }
      return NextResponse.json({ ok: true, sessionId: res.sessionId }, { status: 202 })
    }

    const sessionId = String(body?.sessionId ?? '')
    if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

    switch (action) {
      case 'abort': {
        const ok = await abortAgentScan(user.id)
        return NextResponse.json(ok ? { ok: true } : { error: 'No running pipeline' }, { status: ok ? 200 : 409 })
      }
      case 'engage': {
        const res = await engageAgent(user.id, sessionId)
        return NextResponse.json(res, { status: res.ok ? 200 : 400 })
      }
      case 'disengage': {
        const res = await disengageAgent(user.id, sessionId, body?.flatten !== false)
        return NextResponse.json(res)
      }
      case 'update': {
        const res = await updateAgentSettings(user.id, sessionId, body?.settings ?? {})
        return NextResponse.json(res, { status: res.ok ? 200 : 400 })
      }
      case 'delete': {
        const res = await deleteAgentSession(user.id, sessionId)
        return NextResponse.json(res, { status: res.ok ? 200 : 400 })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e) {
    return handleError(e)
  }
}
