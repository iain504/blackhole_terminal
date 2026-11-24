// v2.12.57 — standalone LLM transport (server-side only). NO vendor SDK, NO
// built-in default model.
//
// Operator mandates that shaped this file:
//   1. "docker cannot rely on z ai component — make it work alone"
//      → the z-ai-web-dev-sdk dependency and its .z-ai-config FILE are gone;
//        this module speaks plain OpenAI-compatible HTTP.
//   2. "Remove edge0-8b default. User need to use AI function must input a
//      API key." → the old hard defaults (edgezero.space-z.ai + 'local' +
//      edge0-8b) are GONE. AI functions now resolve in this order:
//
//   Lane 1 — Settings → AI Agent API (PER-USER): the user's OWN OpenAI-
//            compatible endpoint + model + API key, stored AES-256-GCM
//            encrypted in User.settings and managed by the existing UI
//            (/api/settings/ai-agent, with the /test probe). When saved it
//            overrides everything — the exact precedence /api/ai-trade/chat
//            has used since v2.12.20.
//   Lane 2 — the OPERATOR env lane: AI_TRADE_BASE_URL + AI_TRADE_API_KEY +
//            AI_TRADE_MODEL (ALL three required — there is no default). For
//            self-hosters who want AI before any user configures a key.
//
//   With NEITHER lane configured, resolveLane returns null and llmChat throws
//   the honest 「AI 未設定」 error — the pre-trade gate, planner, auditor and
//   sentiment engine all fail closed on it (no verdict → no trade since
//   v2.12.56), exactly like a dead upstream.
import { readAiAgentConfig, aiAgentAuthHeaders } from '@/lib/ai-agent'

const REQUEST_TIMEOUT_MS = 90_000

export type LlmProvider = 'agent' | 'builtin'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChatOptions {
  /** per-user call sites: prefer the user's own Settings → AI Agent endpoint */
  userId?: string
  messages: LlmMessage[]
  temperature?: number
  max_tokens?: number
}

/** The slice of the response every call site already consumes. */
export interface LlmCompletion {
  choices?: { message?: { content?: string } }[]
}

function normalizeCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

interface ResolvedLane {
  provider: LlmProvider
  url: string
  headers: Record<string, string>
  model: string
}

/** Lane resolution for ONE call. Lane 1 (the user's own endpoint) wins when
 *  they saved one in Settings → AI Agent API; otherwise the operator env lane
 *  (all three vars required — no defaults ship anymore). Returns null when
 *  NOTHING is configured: llmChat then throws the honest AI 未設定 error and
 *  every caller fails closed. A DB hiccup while reading the user config
 *  degrades to the env lane or the same honest error (never a guessed call). */
async function resolveLane(userId?: string): Promise<ResolvedLane | null> {
  if (userId) {
    try {
      const cfg = await readAiAgentConfig(userId)
      if (cfg) {
        return {
          provider: 'agent',
          url: normalizeCompletionsUrl(cfg.endpoint),
          headers: { 'Content-Type': 'application/json', ...aiAgentAuthHeaders(cfg) },
          model: cfg.model,
        }
      }
    } catch {
      // DB unavailable — fall through to the env lane / honest error
    }
  }
  const base = process.env.AI_TRADE_BASE_URL?.trim()
  const key = process.env.AI_TRADE_API_KEY?.trim()
  const model = process.env.AI_TRADE_MODEL?.trim()
  if (!base || !key || !model) return null
  return {
    provider: 'builtin',
    url: normalizeCompletionsUrl(base),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    model,
  }
}

/** Human lane name for honest error messages. */
function laneName(provider: LlmProvider): string {
  return provider === 'agent' ? 'your AI Agent endpoint' : 'the operator env lane (AI_TRADE_*)'
}

/** POST one chat completion to the resolved lane. Throws Error with a
 *  lane-prefixed message on transport/HTTP failure (call sites keep their
 *  temperature/max_tokens param-fallback logic on top of this). Throws the
 *  「AI 未設定」 error when no lane is configured — callers must treat it
 *  exactly like any other LLM failure (fail closed, honest note). */
export async function llmChat(opts: LlmChatOptions): Promise<LlmCompletion> {
  const lane = await resolveLane(opts.userId)
  if (!lane) {
    throw new Error('AI 未設定 — 內建預設模型已移除（v2.12.57）：請於 Settings → AI Agent API 填入自訂端點與 API Key')
  }

  const body: Record<string, unknown> = { messages: opts.messages, model: lane.model }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.max_tokens != null) body.max_tokens = opts.max_tokens

  let res: Response
  try {
    res = await fetch(lane.url, {
      method: 'POST',
      headers: lane.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`LLM request failed (${laneName(lane.provider)} → ${lane.url}): ${msg}`)
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`LLM HTTP ${res.status} from ${laneName(lane.provider)}${text ? `: ${text}` : ''}`)
  }
  const json = (await res.json().catch(() => null)) as LlmCompletion | null
  if (!json || !Array.isArray(json.choices)) {
    throw new Error(`LLM response malformed from ${laneName(lane.provider)}`)
  }
  return json
}
