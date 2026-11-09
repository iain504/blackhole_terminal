import { NextResponse } from 'next/server'
import { requireUser, UnauthorizedError } from '@/lib/auth'
import { readAiAgentConfig, aiAgentAuthHeaders, aiEndpointHost } from '@/lib/ai-agent'

export const dynamic = 'force-dynamic'

// GET /api/ai-trade/health — probe the ACTIVE lane so the UI can show an
// honest 在線/離線 pill instead of failing silently at first question time.
// v2.12.20: when the user configured their own AI Agent endpoint (Settings →
// AI Agent API) it is probed instead of the built-in EdgeZero edge, and the
// response reports which lane is live (`custom: true` + endpoint host +
// model) so the AI Trade tab can badge it honestly.
export async function GET() {
  try {
    const user = await requireUser()
    const custom = await readAiAgentConfig(user.id)
    if (custom) {
      try {
        const res = await fetch(`${custom.endpoint}/models`, {
          headers: aiAgentAuthHeaders(custom),
          signal: AbortSignal.timeout(8_000),
          cache: 'no-store',
        })
        if (!res.ok) {
          return NextResponse.json(
            {
              ok: false,
              custom: true,
              endpointHost: aiEndpointHost(custom.endpoint),
              model: custom.model,
              error: `自訂端點 /models 回應 ${res.status}`,
            },
            { status: 200 },
          )
        }
        const json = (await res.json()) as { data?: { id?: string }[] }
        const models = (json.data ?? [])
          .map((m) => ({ id: String(m.id ?? '') }))
          .filter((m) => m.id)
        return NextResponse.json({
          ok: true,
          custom: true,
          endpointHost: aiEndpointHost(custom.endpoint),
          model: custom.model,
          models,
        })
      } catch (e) {
        const msg = e instanceof Error && e.name === 'TimeoutError' ? '自訂端點逾時' : '自訂端點無法連上'
        return NextResponse.json(
          { ok: false, custom: true, endpointHost: aiEndpointHost(custom.endpoint), model: custom.model, error: msg },
          { status: 200 },
        )
      }
    }

    // built-in EdgeZero lane
    const base = process.env.AI_TRADE_BASE_URL || 'https://edgezero.space-z.ai/api/v1'
    const key = process.env.AI_TRADE_API_KEY || 'local'
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      })
      if (!res.ok) {
        return NextResponse.json({ ok: false, custom: false, error: `upstream ${res.status}` }, { status: 200 })
      }
      const json = (await res.json()) as { data?: { id?: string }[] }
      const models = (json.data ?? [])
        .map((m) => ({ id: String(m.id ?? '') }))
        .filter((m) => m.id)
      return NextResponse.json({ ok: true, custom: false, models })
    } catch (e) {
      const msg = e instanceof Error && e.name === 'TimeoutError' ? 'upstream timeout' : 'upstream unreachable'
      return NextResponse.json({ ok: false, custom: false, error: msg }, { status: 200 })
    }
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    throw e
  }
}
