import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { encrypt } from '@/lib/crypt'
import {
  normalizeAiEndpoint,
  sanitizeAiModel,
  sanitizeAiSecret,
  maskedAiKey,
  aiEndpointHost,
} from '@/lib/ai-agent'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { readJsonSafe } from '@/lib/validation'

export const dynamic = 'force-dynamic'

// /api/settings/ai-agent — the user's own OpenAI-compatible endpoint for the
// AI adviser + AI auto-trade engine (Settings → AI Agent API, v2.12.20).
// Storage: User.settings JSON with the credentials AES-256-GCM encrypted —
// GET never returns a raw key. Configured endpoints OVERRIDE the built-in
// EdgeZero lane in /api/ai-trade/chat + /api/ai-trade/health.
interface UserSettings {
  aiAgentEndpoint?: string
  aiAgentModel?: string
  aiAgentApiKeyEnc?: string
  aiAgentApiSecretEnc?: string
}

function statusOf(s: UserSettings | null) {
  const endpoint = typeof s?.aiAgentEndpoint === 'string' ? normalizeAiEndpoint(s.aiAgentEndpoint) : null
  const model = typeof s?.aiAgentModel === 'string' ? sanitizeAiModel(s.aiAgentModel) : null
  const configured = Boolean(endpoint && model)
  return {
    configured,
    endpoint: configured ? endpoint : '',
    endpointHost: configured ? aiEndpointHost(endpoint as string) : '',
    model: configured ? model : '',
    keyMasked: configured ? maskedAiKey(s?.aiAgentApiKeyEnc) : '',
    secretSet: configured ? Boolean(s?.aiAgentApiSecretEnc) : false,
  }
}

async function loadSettings(userId: string): Promise<UserSettings> {
  const dbUser = await db.user.findUnique({ where: { id: userId } })
  return ((dbUser?.settings as UserSettings | null) || {}) as UserSettings
}

// GET — masked status (configured? endpoint, model, key preview, secret set?).
export async function GET() {
  try {
    const user = await requireUser()
    return NextResponse.json(statusOf(await loadSettings(user.id)))
  } catch (e) {
    return handleError(e)
  }
}

interface PutBody {
  endpoint?: string
  model?: string
  // Credential semantics: undefined = keep what's saved; a string (INCLUDING
  // '') = overwrite — the empty string explicitly REMOVES the credential for
  // key-less endpoints (LAN Ollama & friends).
  apiKey?: string
  apiSecret?: string
}

// PUT — save (or partially update) the custom endpoint. Requires endpoint +
// model on EVERY save so the config can never be left half-valid.
export async function PUT(req: Request) {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`ai-agent:${user.id}`, 12, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many updates — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    const raw = await readJsonSafe(req)
    if (raw == null || typeof raw !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }
    const body = raw as PutBody
    const endpoint = normalizeAiEndpoint(body.endpoint)
    if (!endpoint) {
      return NextResponse.json(
        { error: 'Endpoint 必須是 http(s) URL（例如 https://api.openai.com/v1 — 結尾 /chat/completions 會自動去除）' },
        { status: 400 },
      )
    }
    const model = sanitizeAiModel(body.model)
    if (!model) {
      return NextResponse.json({ error: 'Model 不可空白（填你端點上的模型名，例如 gpt-4o-mini / deepseek-chat）' }, { status: 400 })
    }
    let apiKey: string | null = null
    let apiSecret: string | null = null
    if (body.apiKey !== undefined) {
      const v = sanitizeAiSecret(body.apiKey)
      if (v == null) return NextResponse.json({ error: 'API Key 格式無效（過長或含控制字元）' }, { status: 400 })
      apiKey = v.trim()
    }
    if (body.apiSecret !== undefined) {
      const v = sanitizeAiSecret(body.apiSecret)
      if (v == null) return NextResponse.json({ error: 'API Secret 格式無效（過長或含控制字元）' }, { status: 400 })
      apiSecret = v.trim()
    }
    const s = (await loadSettings(user.id)) as unknown as Record<string, unknown>
    s.aiAgentEndpoint = endpoint
    s.aiAgentModel = model
    if (apiKey !== null) {
      if (apiKey) s.aiAgentApiKeyEnc = encrypt(apiKey)
      else delete s.aiAgentApiKeyEnc
    }
    if (apiSecret !== null) {
      if (apiSecret) s.aiAgentApiSecretEnc = encrypt(apiSecret)
      else delete s.aiAgentApiSecretEnc
    }
    await db.user.update({
      where: { id: user.id },
      data: { settings: s as unknown as Prisma.InputJsonValue },
    })
    return NextResponse.json({ ok: true, ...statusOf(s as unknown as UserSettings) })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE — remove the custom endpoint entirely: AI adviser + auto-trade fall
// back to the built-in EdgeZero lane immediately.
export async function DELETE() {
  try {
    const user = await requireUser()
    const rl = await rateLimit(`ai-agent:${user.id}`, 12, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many updates — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    const s = (await loadSettings(user.id)) as unknown as Record<string, unknown>
    delete s.aiAgentEndpoint
    delete s.aiAgentModel
    delete s.aiAgentApiKeyEnc
    delete s.aiAgentApiSecretEnc
    await db.user.update({
      where: { id: user.id },
      data: { settings: s as unknown as Prisma.InputJsonValue },
    })
    return NextResponse.json({ ok: true, ...statusOf(s as unknown as UserSettings) })
  } catch (e) {
    return handleError(e)
  }
}
