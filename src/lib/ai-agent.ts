// AI Agent — user-configurable LLM endpoint (Settings → AI Agent API, v2.12.20).
//
// The built-in lane is EdgeZero (env AI_TRADE_BASE_URL/AI_TRADE_API_KEY).
// v2.12.20 lets each user bring their OWN OpenAI-compatible endpoint: base
// URL + API key (+ optional secret for providers that need a second key)
// + model name. Storage follows the exact Alpaca-key discipline: the
// key/secret are AES-256-GCM encrypted inside User.settings and NEVER leave
// the server — the browser only ever receives masked key previews. The
// /api/ai-trade/chat + /api/ai-trade/health routes resolve this config
// server-side; when a custom endpoint is configured it overrides the
// EdgeZero lane completely (model whitelist included — the user's endpoint
// speaks its own model names).
//
// SERVER ONLY: imports @/lib/db + @/lib/crypt (both are lazily-initialized,
// safe to import from route handlers; never import this from client code).
import { db } from '@/lib/db'
import { decrypt, maskKey } from '@/lib/crypt'

export interface AiAgentConfig {
  endpoint: string // normalized base, e.g. https://api.openai.com/v1
  apiKey: string // '' when the endpoint needs no auth
  apiSecret: string // '' unless the provider needs a second key
  model: string // the endpoint's own model name (free-form, not whitelisted)
}

interface UserSettings {
  aiAgentEndpoint?: string
  aiAgentModel?: string
  aiAgentApiKeyEnc?: string
  aiAgentApiSecretEnc?: string
}

export const AI_AGENT_MAX_ENDPOINT_LEN = 300
export const AI_AGENT_MAX_MODEL_LEN = 120
export const AI_AGENT_MAX_KEY_LEN = 500

/**
 * Accept "https://host/v1", "https://host/v1/", or a full
 * "https://host/v1/chat/completions" paste — normalize to the bare base the
 * routes append `/chat/completions` and `/models` to. http is allowed so
 * self-hosters can point at a LAN Ollama/LM Studio; https elsewhere.
 */
export function normalizeAiEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let u = raw.trim()
  if (!u || u.length > AI_AGENT_MAX_ENDPOINT_LEN) return null
  u = u.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '')
  try {
    const p = new URL(u)
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return null
    if (!p.host) return null
    return u
  } catch {
    return null
  }
}

/** Free-form model name — non-empty, bounded, no control characters. */
export function sanitizeAiModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.trim()
  if (!m || m.length > AI_AGENT_MAX_MODEL_LEN || /[\u0000-\u001f]/.test(m)) return null
  return m
}

/** Bounded credential clamp — a string, or null when malformed. */
export function sanitizeAiSecret(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length > AI_AGENT_MAX_KEY_LEN || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) return null
  return raw
}

/**
 * Auth header set for the custom endpoint: `Authorization: Bearer <key>`
 * (secret as fallback when no key was saved); when BOTH are provided the
 * secret also rides an `x-api-secret` header for dual-key providers. No
 * credential at all is legal (LAN Ollama & friends).
 */
export function aiAgentAuthHeaders(cfg: Pick<AiAgentConfig, 'apiKey' | 'apiSecret'>): Record<string, string> {
  const h: Record<string, string> = {}
  const bearer = cfg.apiKey || cfg.apiSecret
  if (bearer) h.Authorization = `Bearer ${bearer}`
  if (cfg.apiKey && cfg.apiSecret) h['x-api-secret'] = cfg.apiSecret
  return h
}

/**
 * Resolve the user's custom AI endpoint from User.settings — null when not
 * configured (chat/health then fall back to the built-in EdgeZero lane).
 * Decrypt failures degrade gracefully (empty credential → request may 401
 * upstream with an honest message, same as the Alpaca unreadable case).
 */
export async function readAiAgentConfig(userId: string): Promise<AiAgentConfig | null> {
  try {
    const u = await db.user.findUnique({ where: { id: userId }, select: { settings: true } })
    const s = (u?.settings ?? null) as UserSettings | null
    if (!s) return null
    const endpoint = normalizeAiEndpoint(s.aiAgentEndpoint)
    const model = sanitizeAiModel(s.aiAgentModel)
    if (!endpoint || !model) return null
    const apiKey = typeof s.aiAgentApiKeyEnc === 'string' ? decrypt(s.aiAgentApiKeyEnc) || '' : ''
    const apiSecret = typeof s.aiAgentApiSecretEnc === 'string' ? decrypt(s.aiAgentApiSecretEnc) || '' : ''
    return { endpoint, apiKey, apiSecret, model }
  } catch {
    return null
  }
}

/** Hostname for honest UI display — '' when unparseable. */
export function aiEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

/** Masked key preview for GET responses (same masking as the Alpaca keys). */
export function maskedAiKey(enc?: string): string {
  if (!enc) return ''
  return maskKey(decrypt(enc) || '')
}
