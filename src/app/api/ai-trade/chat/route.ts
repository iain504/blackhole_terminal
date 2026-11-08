import { NextResponse } from 'next/server'
import { requireUser, UnauthorizedError } from '@/lib/auth'
import { isAiTradeModel, AI_TRADE_DEFAULT_MODEL, type AiChatMsg } from '@/lib/ai-trade'

export const dynamic = 'force-dynamic'
// The deep lane (35B, int4 on modest silicon) can think for a while — give it
// room, the browser shows its own taiji + cancel button meanwhile.
export const maxDuration = 120

const MAX_MESSAGES = 24 // last-N chat turns sent upstream
const MAX_MSG_CHARS = 6_000 // per-message clamp
const MAX_CONTEXT_CHARS = 8_000 // market/account grounding block clamp
const MAX_TOKENS = 900

// Honest-adviser system prompt: grounding + risk-first + the terminal's
// honesty contract (no fabricated data, no guarantees, say when unsure).
const SYSTEM_PROMPT = [
  'You are the AI Trade adviser inside a self-hosted trading terminal (BLACKHOLE Terminal).',
  'Rules:',
  '- Ground every statement in the DATA block provided (prices, indicators, positions, account). If the data is missing or insufficient for a question, say so honestly — never invent numbers.',
  '- Respond in Traditional Chinese (繁體中文) when the user writes Chinese; otherwise mirror the user\'s language.',
  '- Be concise and structured: 觀點 (bias) → 關鍵位 (levels) → 風險 (risks) → 建議 (actionable plan with entry/stop/size ideas when asked).',
  '- You may NOT place orders. When the user asks to trade, describe the plan and remind them to use the terminal\'s trade ticket / algo / grid tools.',
  '- No guarantees, no hype. Always name at least one risk or invalidation level. This is analysis, not financial advice.',
].join('\n')

export async function POST(req: Request) {
  try {
    await requireUser()
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    throw e
  }

  let body: {
    model?: string
    messages?: AiChatMsg[]
    context?: string
    maxTokens?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const model = isAiTradeModel(body.model) ? body.model : AI_TRADE_DEFAULT_MODEL

  // Sanitize the thread: keep the last N user/assistant turns, clamp sizes.
  const history: AiChatMsg[] = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }))
    .slice(-MAX_MESSAGES)
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'messages must end with a user turn' }, { status: 400 })
  }

  const context = typeof body.context === 'string' ? body.context.slice(0, MAX_CONTEXT_CHARS) : ''
  const maxTokens = Math.min(Math.max(Number(body.maxTokens) || MAX_TOKENS, 64), 2_000)

  const upstreamMessages: { role: string; content: string }[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  if (context) {
    upstreamMessages.push({
      role: 'system',
      content: `DATA block (terminal-provided, authoritative over your priors — still verify internal consistency):\n${context}`,
    })
  }
  upstreamMessages.push(...history)

  const base = process.env.AI_TRADE_BASE_URL || 'https://edgezero.space-z.ai/api/v1'
  const key = process.env.AI_TRADE_API_KEY || 'local'

  let upstream: Response
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: upstreamMessages, max_tokens: maxTokens, temperature: 0.4, stream: false }),
      signal: AbortSignal.timeout(110_000),
      cache: 'no-store',
    })
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError'
      ? '模型逾時（110s）— 請改用 Edge0 8B 快線或稍後再試'
      : '無法連上 EdgeZero 端點'
    return NextResponse.json({ ok: false, error: msg }, { status: 504 })
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    const status = upstream.status === 429 ? 429 : 502
    const msg =
      upstream.status === 429
        ? '模型忙碌（429）— 稍候幾秒再試'
        : upstream.status === 401 || upstream.status === 403
          ? 'EdgeZero 認證失敗 — 檢查 AI_TRADE_API_KEY'
          : `EdgeZero 回應 ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    return NextResponse.json({ ok: false, error: msg }, { status })
  }

  let json: {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  try {
    json = await upstream.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'EdgeZero 回應非 JSON' }, { status: 502 })
  }

  const content = json.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    return NextResponse.json({ ok: false, error: '模型回覆空白' }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    content,
    model,
    usage: {
      prompt: json.usage?.prompt_tokens ?? 0,
      completion: json.usage?.completion_tokens ?? 0,
    },
  })
}
