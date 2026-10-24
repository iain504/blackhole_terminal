import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { encrypt, decrypt, maskKey } from '@/lib/crypt'
import { validateAlpacaKeys } from '@/lib/alpaca'
import { handleError } from '@/lib/api-helpers'
import {
  readJsonSafe,
  settingsBodySchema,
  settingsBodyTooLarge,
  zodBadRequest,
} from '@/lib/validation'

interface UserSettings {
  alpacaKeyIdEnc?: string
  alpacaSecretEnc?: string
  telegramTokenEnc?: string
  telegramChatId?: string
  // telegram notification toggles (default true when absent)
  notifyFills?: boolean
  notifyCloses?: boolean
  tradeMode?: string
  tpslPercent?: number
}

export const DEFAULT_TPSL_PERCENT = 5

// GET /api/settings — masked values + availability flags
export async function GET() {
  try {
    const user = await requireUser()
    const dbUser = await db.user.findUnique({ where: { id: user.id } })
    const s = (dbUser?.settings as UserSettings | null) || null
    const envAlpaca = Boolean(process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY)
    return NextResponse.json({
      alpaca: {
        keyIdMasked: s?.alpacaKeyIdEnc ? maskKey(decrypt(s.alpacaKeyIdEnc) || '') : '',
        secretSet: Boolean(s?.alpacaSecretEnc),
        serverKeysPresent: envAlpaca,
      },
      telegram: {
        tokenSet: Boolean(s?.telegramTokenEnc),
        chatId: s?.telegramChatId || '',
        notifyFills: s?.notifyFills !== false,
        notifyCloses: s?.notifyCloses !== false,
      },
      tradeMode: s?.tradeMode === 'live' ? 'live' : 'paper',
      tpslPercent:
        typeof s?.tpslPercent === 'number' && isFinite(s.tpslPercent) && s.tpslPercent > 0
          ? s.tpslPercent
          : DEFAULT_TPSL_PERCENT,
    })
  } catch (e) {
    return handleError(e)
  }
}

interface PutBody {
  alpacaKeyId?: string
  alpacaSecret?: string
  telegramToken?: string
  telegramChatId?: string
  notifyFills?: boolean
  notifyCloses?: boolean
  tradeMode?: string
  tpslPercent?: number
}

// PUT /api/settings — update private credentials (stored encrypted, never returned).
// Body is parse-then-validated (zod): bounded JSON object (keys ≤64 chars, string
// values ≤10k, finite numbers, booleans, scalar arrays ≤500, object depth ≤4),
// 413 when JSON.stringify length exceeds 256KB, $-prefixed keys stripped. The
// merge below keeps its EXACT previous semantics: only the known fields are
// conditionally written into the existing settings object; unknown body keys
// never reach the DB (strip discipline).
export async function PUT(req: Request) {
  try {
    const user = await requireUser()
    const raw = await readJsonSafe(req)
    if (raw == null) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    if (settingsBodyTooLarge(raw)) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
    const parsed = settingsBodySchema.safeParse(raw)
    if (!parsed.success) return zodBadRequest(parsed.error)
    const body = parsed.data as PutBody
    const dbUser = await db.user.findUnique({ where: { id: user.id } })
    const s = ((dbUser?.settings as UserSettings | null) || {}) as Record<string, unknown>
    if (typeof body.alpacaKeyId === 'string' && body.alpacaKeyId.trim()) {
      s.alpacaKeyIdEnc = encrypt(body.alpacaKeyId.trim())
    }
    if (typeof body.alpacaSecret === 'string' && body.alpacaSecret.trim()) {
      s.alpacaSecretEnc = encrypt(body.alpacaSecret.trim())
    }
    if (typeof body.telegramToken === 'string' && body.telegramToken.trim()) {
      s.telegramTokenEnc = encrypt(body.telegramToken.trim())
    }
    if (typeof body.telegramChatId === 'string') {
      s.telegramChatId = body.telegramChatId.trim()
    }
    if (typeof body.notifyFills === 'boolean') {
      s.notifyFills = body.notifyFills
    }
    if (typeof body.notifyCloses === 'boolean') {
      s.notifyCloses = body.notifyCloses
    }
    if (body.tradeMode === 'paper' || body.tradeMode === 'live') {
      s.tradeMode = body.tradeMode
    }
    if (typeof body.tpslPercent === 'number' && isFinite(body.tpslPercent) && body.tpslPercent > 0 && body.tpslPercent <= 90) {
      s.tpslPercent = Math.round(body.tpslPercent * 100) / 100
    }
    await db.user.update({
      where: { id: user.id },
      data: { settings: s as unknown as Prisma.InputJsonValue },
    })
    // Auto-verify freshly saved Alpaca keys so the user knows immediately
    // whether live data will work (invalid keys silently showed "demo" before).
    let alpacaValidation: { valid: boolean; status: number; message: string } | null = null
    if (typeof s.alpacaKeyIdEnc === 'string' && typeof s.alpacaSecretEnc === 'string') {
      const keyId = decrypt(s.alpacaKeyIdEnc)
      const secret = decrypt(s.alpacaSecretEnc)
      if (keyId && secret) {
        alpacaValidation = await validateAlpacaKeys(keyId, secret)
      }
    }
    return NextResponse.json({ ok: true, alpaca: alpacaValidation })
  } catch (e) {
    return handleError(e)
  }
}
