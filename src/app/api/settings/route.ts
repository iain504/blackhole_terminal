import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { encrypt, decrypt, maskKey } from '@/lib/crypt'
import { validateAlpacaKeys } from '@/lib/alpaca'
import { readJson, handleError } from '@/lib/api-helpers'

interface UserSettings {
  alpacaKeyIdEnc?: string
  alpacaSecretEnc?: string
  telegramTokenEnc?: string
  telegramChatId?: string
  tradeMode?: string
}

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
      },
      tradeMode: s?.tradeMode === 'live' ? 'live' : 'paper',
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
  tradeMode?: string
}

// PUT /api/settings — update private credentials (stored encrypted, never returned)
export async function PUT(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJson<PutBody>(req)
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
    if (body.tradeMode === 'paper' || body.tradeMode === 'live') {
      s.tradeMode = body.tradeMode
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
