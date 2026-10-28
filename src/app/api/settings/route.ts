import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { encrypt, decrypt, maskKey } from '@/lib/crypt'
import { detectAlpacaKeyAccount, migrateLegacyAlpacaKeys, type AlpacaKeyCheck } from '@/lib/alpaca'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import {
  readJsonSafe,
  settingsBodySchema,
  settingsBodyTooLarge,
  zodBadRequest,
} from '@/lib/validation'

interface UserSettings {
  alpacaKeyIdEnc?: string
  alpacaSecretEnc?: string
  // Task 37 — dual key pairs (paper account + live account). One Alpaca key
  // only ever works on ONE of the two hosts, so each gets its own slot.
  alpacaPaperKeyIdEnc?: string
  alpacaPaperSecretEnc?: string
  alpacaLiveKeyIdEnc?: string
  alpacaLiveSecretEnc?: string
  telegramTokenEnc?: string
  telegramChatId?: string
  // telegram notification toggles (default true when absent)
  notifyFills?: boolean
  notifyCloses?: boolean
  tradeMode?: string
  tpslPercent?: number
  // Task 10-g — chart boundary glow colors (hex #rrggbb). Grid glow defaults
  // emerald, algo glow purple; the user picks both in Settings → Chart glow.
  glowGridColor?: string
  glowAlgoColor?: string
  // Task 28 — UI theme: 'default' (Midnight) | 'day' (light) | 'christmas'.
  // Absent = default.
  uiTheme?: string
  // v1.87.0 — full-screen splash when the US regular session opens/closes.
  // Absent = enabled (default on).
  sessionSplash?: boolean
}

export const DEFAULT_TPSL_PERCENT = 5

/** #rrggbb (exactly) — the only glow-color shape we persist. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
export const DEFAULT_GLOW_GRID = '#10b981'
export const DEFAULT_GLOW_ALGO = '#a855f7'

function safeGlow(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v) ? v.toLowerCase() : fallback
}

// GET /api/settings — masked values + availability flags
export async function GET() {
  try {
    const user = await requireUser()
    // Task 37 — copy the pre-dual-key single pair into its correct Paper/Live
    // slot (account type detected via a real /v2/account probe, once per
    // process) so the new UI shows the existing key where it belongs.
    await migrateLegacyAlpacaKeys(user.id)
    const dbUser = await db.user.findUnique({ where: { id: user.id } })
    const s = (dbUser?.settings as UserSettings | null) || null
    const envAlpaca = Boolean(process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY)
    const maskedOf = (kidEnc?: string) => (kidEnc ? maskKey(decrypt(kidEnc) || '') : '')
    return NextResponse.json({
      alpaca: {
        paper: {
          keyIdMasked: maskedOf(s?.alpacaPaperKeyIdEnc),
          secretSet: Boolean(s?.alpacaPaperSecretEnc),
        },
        live: {
          keyIdMasked: maskedOf(s?.alpacaLiveKeyIdEnc),
          secretSet: Boolean(s?.alpacaLiveSecretEnc),
        },
        // pre-dual-key pair — still honored for PAPER when the new slots are
        // empty; the UI surfaces it only when neither pair is set
        legacy: {
          keyIdMasked: maskedOf(s?.alpacaKeyIdEnc),
          secretSet: Boolean(s?.alpacaSecretEnc),
        },
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
      glow: {
        grid: safeGlow(s?.glowGridColor, DEFAULT_GLOW_GRID),
        algo: safeGlow(s?.glowAlgoColor, DEFAULT_GLOW_ALGO),
      },
      uiTheme: s?.uiTheme === 'christmas' ? 'christmas' : s?.uiTheme === 'day' ? 'day' : 'default',
      sessionSplash: s?.sessionSplash !== false,
    })
  } catch (e) {
    return handleError(e)
  }
}

interface PutBody {
  // Task 37 — per-account key pairs. `alpacaKeyId/alpacaSecret` (legacy single
  // pair) are still accepted so old clients/exports keep working.
  alpacaPaperKeyId?: string
  alpacaPaperSecret?: string
  alpacaLiveKeyId?: string
  alpacaLiveSecret?: string
  alpacaKeyId?: string
  alpacaSecret?: string
  telegramToken?: string
  telegramChatId?: string
  notifyFills?: boolean
  notifyCloses?: boolean
  tradeMode?: string
  tpslPercent?: number
  glowGridColor?: string
  glowAlgoColor?: string
  uiTheme?: string
  sessionSplash?: boolean
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
    // Task 89 — settings PUT stores credentials and probes Alpaca twice per
    // save (key-account detection); bound it per user.
    const rl = await rateLimit(`settings:${user.id}`, 10, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many settings updates — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
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
    if (typeof body.alpacaPaperKeyId === 'string' && body.alpacaPaperKeyId.trim()) {
      s.alpacaPaperKeyIdEnc = encrypt(body.alpacaPaperKeyId.trim())
    }
    if (typeof body.alpacaPaperSecret === 'string' && body.alpacaPaperSecret.trim()) {
      s.alpacaPaperSecretEnc = encrypt(body.alpacaPaperSecret.trim())
    }
    if (typeof body.alpacaLiveKeyId === 'string' && body.alpacaLiveKeyId.trim()) {
      s.alpacaLiveKeyIdEnc = encrypt(body.alpacaLiveKeyId.trim())
    }
    if (typeof body.alpacaLiveSecret === 'string' && body.alpacaLiveSecret.trim()) {
      s.alpacaLiveSecretEnc = encrypt(body.alpacaLiveSecret.trim())
    }
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
    if (body.glowGridColor != null) {
      if (typeof body.glowGridColor !== 'string' || !HEX_COLOR_RE.test(body.glowGridColor)) {
        return NextResponse.json({ error: 'glowGridColor must be a hex color like #10b981' }, { status: 400 })
      }
      s.glowGridColor = body.glowGridColor.toLowerCase()
    }
    if (body.glowAlgoColor != null) {
      if (typeof body.glowAlgoColor !== 'string' || !HEX_COLOR_RE.test(body.glowAlgoColor)) {
        return NextResponse.json({ error: 'glowAlgoColor must be a hex color like #a855f7' }, { status: 400 })
      }
      s.glowAlgoColor = body.glowAlgoColor.toLowerCase()
    }
    // Task 28 — UI theme (Settings → Appearance; the client applies it live
    // and mirrors it into localStorage)
    if (body.uiTheme != null) {
      if (body.uiTheme !== 'default' && body.uiTheme !== 'day' && body.uiTheme !== 'christmas') {
        return NextResponse.json({ error: "uiTheme must be 'default', 'day' or 'christmas'" }, { status: 400 })
      }
      s.uiTheme = body.uiTheme
    }
    // v1.87.0 — session splash on/off (Settings → Trading session alerts)
    if (typeof body.sessionSplash === 'boolean') {
      s.sessionSplash = body.sessionSplash
    }
    await db.user.update({
      where: { id: user.id },
      data: { settings: s as unknown as Prisma.InputJsonValue },
    })
    // Auto-verify the saved PAPER + LIVE pairs against BOTH Alpaca hosts so
    // the user immediately knows each pair works AND belongs to the right
    // account (a paper key in the Live section would 401 on every live call —
    // Task 36). detectAlpacaKeyAccount answers definitively.
    const alpacaChecks: { mode: 'paper' | 'live'; check: AlpacaKeyCheck }[] = []
    for (const m of ['paper', 'live'] as const) {
      const kidEnc = m === 'paper' ? s.alpacaPaperKeyIdEnc : s.alpacaLiveKeyIdEnc
      const secEnc = m === 'paper' ? s.alpacaPaperSecretEnc : s.alpacaLiveSecretEnc
      if (typeof kidEnc === 'string' && typeof secEnc === 'string') {
        const keyId = decrypt(kidEnc)
        const secret = decrypt(secEnc)
        if (keyId && secret) {
          alpacaChecks.push({ mode: m, check: await detectAlpacaKeyAccount(keyId, secret, m) })
        }
      }
    }
    return NextResponse.json({ ok: true, alpacaChecks })
  } catch (e) {
    return handleError(e)
  }
}
