// v2.12.52 — standalone LLM transport (server-side only). NO vendor SDK, NO
// new env keys.
//
// Operator mandates that shaped this file:
//   1. "docker cannot rely on z ai component — make it work alone"
//      → the z-ai-web-dev-sdk dependency and its .z-ai-config FILE are gone;
//        this module speaks plain OpenAI-compatible HTTP.
//   2. "which AI model should already be built-in config — why a new env key?"
//      → it is. The model choice resolves through config the platform already
//        ships, in this order:
//
//   Lane 1 — Settings → AI Agent API (PER-USER): the user's OWN OpenAI-
//            compatible endpoint + model + key, stored AES-256-GCM encrypted
//            in User.settings and managed by the existing UI
//            (/api/settings/ai-agent, with the /test probe). When saved it
//            overrides everything — the exact precedence /api/ai-trade/chat
//            has used since v2.12.20.
//   Lane 2 — the BUILT-IN lane: AI_TRADE_BASE_URL / AI_TRADE_API_KEY
//            (pre-existing optional operator overrides) with hard defaults
//            (https://edgezero.space-z.ai/api/v1 + 'local', model edge0-8b —
//            the same default the AI adviser chat always had). A fresh
//            container runs every AI feature out of the box, zero setup.
//
// Per-user features (post-trade auditor, pre-trade veto gate, rule
// consolidation) resolve Lane 1 → Lane 2 for their calling user; the global
// sentiment engine has no user context and rides Lane 2. Both lanes share the
// same /chat/completions wire format — one timeout, one honest error shape.
// Because Lane 2 always resolves, there is no "unconfigured" state to
// pre-flight: a broken upstream surfaces as an honest per-call error instead
// (gate → ERROR row fail-open, audit → failed-batch note, sentiment →
// offline lexicon degradation).
import { readAiAgentConfig, aiAgentAuthHeaders } from '@/lib/ai-agent'
import { AI_TRADE_DEFAULT_MODEL } from '@/lib/ai-trade'

const REQUEST_TIMEOUT_MS = 90_000
const BUILTIN_BASE_DEFAULT = 'https://edgezero.space-z.ai/api/v1'
const BUILTIN_KEY_DEFAULT = 'local'

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
 *  they saved one in Settings → AI Agent API; otherwise the built-in EdgeZero
 *  lane — which ALWAYS resolves thanks to its hard defaults, so no AI feature
 *  can dead-end on a fresh deployment and no env key is ever required. A DB
 *  hiccup while reading the user config degrades to the built-in lane (the
 *  AI adviser chat behaves identically via readAiAgentConfig → null → EdgeZero). */
async function resolveLane(userId?: string): Promise<ResolvedLane> {
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
      // DB unavailable — the built-in lane keeps AI working
    }
  }
  const base = (process.env.AI_TRADE_BASE_URL?.trim() || BUILTIN_BASE_DEFAULT).replace(/\/+$/, '')
  return {
    provider: 'builtin',
    url: normalizeCompletionsUrl(base),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.AI_TRADE_API_KEY?.trim() || BUILTIN_KEY_DEFAULT}`,
    },
    model: AI_TRADE_DEFAULT_MODEL,
  }
}

/** Human lane name for honest error messages. */
function laneName(provider: LlmProvider): string {
  return provider === 'agent' ? 'your AI Agent endpoint' : 'the built-in EdgeZero lane'
}

/** POST one chat completion to the resolved lane. Throws Error with a
 *  lane-prefixed message on transport/HTTP failure (call sites keep their
 *  temperature/max_tokens param-fallback logic on top of this). */
export async function llmChat(opts: LlmChatOptions): Promise<LlmCompletion> {
  const lane = await resolveLane(opts.userId)

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
