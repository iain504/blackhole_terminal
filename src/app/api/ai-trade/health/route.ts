import { NextResponse } from 'next/server'
import { requireUser, UnauthorizedError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/ai-trade/health — probe the EdgeZero edge (OpenAI-compatible
// /models) so the UI can show an honest 在線/離線 pill instead of failing
// silently at first question time. Short timeout: this is a liveness check.
export async function GET() {
  try {
    await requireUser()
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    throw e
  }
  const base = process.env.AI_TRADE_BASE_URL || 'https://edgezero.space-z.ai/api/v1'
  const key = process.env.AI_TRADE_API_KEY || 'local'
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `upstream ${res.status}` }, { status: 200 })
    }
    const json = (await res.json()) as { data?: { id?: string }[] }
    const models = (json.data ?? [])
      .map((m) => ({ id: String(m.id ?? '') }))
      .filter((m) => m.id)
    return NextResponse.json({ ok: true, models })
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError' ? 'upstream timeout' : 'upstream unreachable'
    return NextResponse.json({ ok: false, error: msg }, { status: 200 })
  }
}
