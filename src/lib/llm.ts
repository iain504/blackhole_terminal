// v2.12.52 — standalone LLM transport (server-side only). NO vendor SDK.
//
// WHY: z-ai-web-dev-sdk resolved credentials ONLY from a .z-ai-config FILE
// (cwd / home / /etc) that exists in this dev sandbox but never in a hosted
// container, and it talked to a sandbox-internal API. Hosted deployments
// (Render/Railway/Fly Docker) must work ALONE — so the app now speaks plain,
// dependency-free OpenAI-compatible HTTP to ANY provider the operator points
// it at, and the sandbox's internal API survives only as a local-dev fallback.
//
// Provider resolution (first match wins):
//   1. LLM_API_URL + LLM_API_KEY  → 'custom'  — any OpenAI-compatible
//      /chat/completions API: OpenAI, DeepSeek, Groq, OpenRouter, Together,
//      Mistral, a self-hosted vLLM or ollama /v1 endpoint, …
//      LLM_MODEL picks the model; well-known cloud hosts get a sane default.
//   2. .z-ai-config file          → 'sandbox' — dev-sandbox fallback (the
//      internal API accepts no model field and wants the thinking flag).
//   3. nothing                    → not configured; LLM routes fail fast with
//      the actionable hint, sentiment degrades to its offline lexicon engine,
//      and the pre-trade gate stays fail-closed.
//
// All three AI call sites (post-trade auditor, pre-trade veto gate, sentiment
// scorer) go through llmChat() — one timeout, one error shape, zero SDKs.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REQUEST_TIMEOUT_MS = 90_000
const CONFIG_FILENAME = '.z-ai-config'
const CONFIG_SEARCH_PATHS = [
  path.join(process.cwd(), CONFIG_FILENAME),
  path.join(os.homedir(), CONFIG_FILENAME),
  path.join('/etc', CONFIG_FILENAME),
]

export type LlmProvider = 'custom' | 'sandbox'

export interface LlmStatus {
  configured: boolean
  provider: LlmProvider | null
  /** resolved model id ('default' for the sandbox internal API) */
  model: string | null
  /** non-null only when env vars are partially/incorrectly set */
  error: string | null
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChatOptions {
  messages: LlmMessage[]
  temperature?: number
  max_tokens?: number
  /** sandbox internal API only — ignored (stripped) for OpenAI-compatible APIs */
  thinking?: { type: string }
}

/** The slice of the response every call site already consumes. */
export interface LlmCompletion {
  choices?: { message?: { content?: string } }[]
}

/** Sensible models for well-known OpenAI-compatible hosts (LLM_MODEL wins). */
const MODEL_DEFAULTS: [RegExp, string][] = [
  [/api\.openai\.com/i, 'gpt-4o-mini'],
  [/api\.deepseek\.com/i, 'deepseek-chat'],
  [/api\.groq\.com/i, 'llama-3.3-70b-versatile'],
  [/openrouter\.ai/i, 'openai/gpt-4o-mini'],
  [/api\.mistral\.ai/i, 'mistral-small-latest'],
  [/api\.together\.(?:xyz|ai)/i, 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
]

function defaultModelFor(url: string): string | null {
  for (const [re, model] of MODEL_DEFAULTS) {
    if (re.test(url)) return model
  }
  return null
}

interface SandboxConfig {
  baseUrl: string
  apiKey: string
  chatId?: string
  userId?: string
  token?: string
}

async function readSandboxConfig(): Promise<SandboxConfig | null> {
  for (const p of CONFIG_SEARCH_PATHS) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      const c = JSON.parse(raw) as Partial<SandboxConfig>
      if (typeof c.baseUrl === 'string' && c.baseUrl && typeof c.apiKey === 'string' && c.apiKey) {
        return c as SandboxConfig
      }
    } catch {
      // missing or invalid — try the next location
    }
  }
  return null
}

// Resolution memo — configured results are cached forever (env is fixed per
// process); NOT-configured results are never cached, so a provider added to
// the environment is picked up on the next call without a restart. A thrown
// probe is retried on the next call (a failed resolution must not poison the
// process — same pattern as every other lazy singleton in this codebase).
let configuredPromise: Promise<LlmStatus> | null = null
let sandboxConfig: SandboxConfig | null = null

export function llmStatus(): Promise<LlmStatus> {
  if (configuredPromise) return configuredPromise
  const probe = (async (): Promise<LlmStatus> => {
    const url = process.env.LLM_API_URL?.trim() ?? ''
    const key = process.env.LLM_API_KEY?.trim() ?? ''
    if (url || key) {
      if (url && key) {
        const model = process.env.LLM_MODEL?.trim() || defaultModelFor(url)
        if (!model) {
          return {
            configured: false, provider: null, model: null,
            error: `LLM_API_URL is set (${url}) but no LLM_MODEL — set one (e.g. gpt-4o-mini, deepseek-chat, llama-3.3-70b-versatile) or use a well-known provider host`,
          }
        }
        return { configured: true, provider: 'custom', model, error: null }
      }
      return {
        configured: false, provider: null, model: null,
        error: url
          ? 'LLM_API_URL is set but LLM_API_KEY is missing — set both'
          : 'LLM_API_KEY is set but LLM_API_URL is missing — set both',
      }
    }
    // sandbox dev fallback (never present in a hosted container)
    const cfg = await readSandboxConfig()
    if (cfg) {
      sandboxConfig = cfg
      return { configured: true, provider: 'sandbox', model: 'default', error: null }
    }
    return { configured: false, provider: null, model: null, error: null }
  })()
  probe.then((s) => {
    if (s.configured) configuredPromise = probe
  }).catch(() => { /* next call re-probes */ })
  return probe
}

/** One actionable sentence for 4xx/5xx bodies when no LLM provider is set. */
export function llmSetupHint(status: LlmStatus): string {
  const fix = 'Fix: Render Dashboard → Environment → set LLM_API_URL + LLM_API_KEY (+ LLM_MODEL) to any OpenAI-compatible provider (OpenAI, DeepSeek, Groq, OpenRouter, self-hosted vLLM/ollama), then redeploy.'
  return status.error
    ? `LLM not usable: ${status.error}. ${fix}`
    : `No LLM provider configured on this deployment (LLM_API_URL / LLM_API_KEY unset, no sandbox config). ${fix}`
}

function normalizeCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

/** POST one chat completion to the resolved provider. Throws Error with a
 *  provider-prefixed message on transport/HTTP failure (call sites keep their
 *  temperature/max_tokens param-fallback logic on top of this). */
export async function llmChat(opts: LlmChatOptions): Promise<LlmCompletion> {
  const status = await llmStatus()
  if (!status.configured) {
    throw new Error(`LLM provider not configured — ${llmSetupHint(status)}`)
  }

  const body: Record<string, unknown> = { messages: opts.messages }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.max_tokens != null) body.max_tokens = opts.max_tokens

  let url: string
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (status.provider === 'custom') {
    url = normalizeCompletionsUrl(process.env.LLM_API_URL as string)
    body.model = status.model
    headers.Authorization = `Bearer ${process.env.LLM_API_KEY?.trim() ?? ''}`
  } else {
    // sandbox internal API — same wire format the vendored SDK used, minus the SDK
    const cfg = sandboxConfig ?? (await readSandboxConfig())
    if (!cfg) throw new Error('sandbox LLM config vanished — restart to re-resolve')
    url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
    headers.Authorization = `Bearer ${cfg.apiKey}`
    headers['X-Z-AI-From'] = 'Z' // internal gateway routing header (was set by the removed SDK)
    if (opts.thinking) body.thinking = opts.thinking // internal API wants the flag; others ignore it
    if (cfg.chatId) headers['X-Chat-Id'] = cfg.chatId
    if (cfg.userId) headers['X-User-Id'] = cfg.userId
    if (cfg.token) headers['X-Token'] = cfg.token
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`LLM request failed (${status.provider} → ${url}): ${msg}`)
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`LLM HTTP ${res.status} from ${status.provider} provider${text ? `: ${text}` : ''}`)
  }
  const json = (await res.json().catch(() => null)) as LlmCompletion | null
  if (!json || !Array.isArray(json.choices)) {
    throw new Error(`LLM response malformed from ${status.provider} provider`)
  }
  return json
}
