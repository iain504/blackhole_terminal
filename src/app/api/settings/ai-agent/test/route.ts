import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  readAiAgentConfig,
  normalizeAiEndpoint,
  sanitizeAiModel,
  sanitizeAiSecret,
  aiAgentAuthHeaders,
} from '@/lib/ai-agent'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { readJsonSafe } from '@/lib/validation'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// POST /api/settings/ai-agent/test — prove the AI Agent endpoint works BEFORE
// it is trusted by the adviser/auto-trade. Tests TYPED values when given
// (test-before-save, same UX as the Alpaca key test); typed endpoint/model
// fall back to the stored ones, typed credentials win outright (empty typed
// key = test the key-less path). A real minimal chat/completions call — a
// /models probe proves reachability but NOT that the model name is valid.
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`ai-agent-test:${user.id}`, 8, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ ok: false, error: `Too many tests — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    const raw = await readJsonSafe(req)
    const body = (raw && typeof raw === 'object' ? raw : {}) as {
      endpoint?: string
      model?: string
      apiKey?: string
      apiSecret?: string
    }

    const stored = await readAiAgentConfig(user.id)
    const endpoint = normalizeAiEndpoint(body.endpoint) ?? stored?.endpoint ?? null
    const model = sanitizeAiModel(body.model) ?? stored?.model ?? null
    if (!endpoint || !model) {
      return NextResponse.json(
        { ok: false, error: '請先填 Endpoint 與 Model（或先在下方儲存一次）' },
        { status: 200 },
      )
    }
    // Credentials: typed wins outright (including explicitly empty); otherwise
    // reuse the stored ones so "endpoint edited, key unchanged" tests right.
    const apiKey = body.apiKey !== undefined ? (sanitizeAiSecret(body.apiKey) ?? '').trim() : stored?.apiKey ?? ''
    const apiSecret =
      body.apiSecret !== undefined ? (sanitizeAiSecret(body.apiSecret) ?? '').trim() : stored?.apiSecret ?? ''

    const started = Date.now()
    let upstream: Response
    try {
      upstream = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { ...aiAgentAuthHeaders({ apiKey, apiSecret }), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
          max_tokens: 16,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(25_000),
        cache: 'no-store',
      })
    } catch (e) {
      const msg =
        e instanceof Error && e.name === 'TimeoutError'
          ? `連線逾時（25s）— ${endpoint} 沒有回應`
          : `無法連上 ${endpoint}（離線、DNS 或防火牆？）`
      return NextResponse.json({ ok: false, error: msg, endpoint, model }, { status: 200 })
    }

    const latencyMs = Date.now() - started
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 180)
      const msg =
        upstream.status === 401 || upstream.status === 403
          ? `認證失敗（${upstream.status}）— 檢查 API Key / Secret`
          : upstream.status === 404
            ? `404 — 端點路徑或模型名不存在（OpenAI 相容 base 通常以 /v1 結尾；確認 Model 拼寫）`
            : upstream.status === 429
              ? `429 — 端點忙碌/額度用盡，稍後再試`
              : `端點回應 ${upstream.status}${detail ? `: ${detail}` : ''}`
      return NextResponse.json({ ok: false, error: msg, endpoint, model, status: upstream.status }, { status: 200 })
    }

    const json = (await upstream.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[]
    } | null
    const reply = json?.choices?.[0]?.message?.content?.trim() ?? ''
    if (!reply) {
      return NextResponse.json(
        { ok: false, error: '連上了，但回覆空白 — 確認這是 OpenAI 相容的 chat/completions 端點', endpoint, model },
        { status: 200 },
      )
    }
    return NextResponse.json({ ok: true, latencyMs, model, endpoint, reply: reply.slice(0, 120) }, { status: 200 })
  } catch (e) {
    return handleError(e)
  }
}
