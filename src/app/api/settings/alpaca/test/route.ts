import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { decrypt } from '@/lib/crypt'
import { detectAlpacaKeyAccount, type AlpacaKeyCheck } from '@/lib/alpaca'
import { readJson, handleError } from '@/lib/api-helpers'

interface TestBody {
  mode?: 'paper' | 'live'
  alpacaKeyId?: string
  alpacaSecret?: string
}

// POST /api/settings/alpaca/test — PROVE a key pair against BOTH Alpaca
// trading hosts (/v2/account on paper-api AND api.alpaca.markets — a valid
// key answers 200 on exactly one). Task 37 dual-host proof.
//
// v2.12.5 — RESTORED: the Settings → API keys Test buttons have POSTed to
// this URL since the v1.91.0 dual-key refactor, but the route never existed
// in src/app/api — every click 404'd as "Test failed (404)". This was the
// one tool a hosted deployment (Render) needed to validate its keys after
// the "Alpaca returns 401" report, and it was dead.
//
// Contract (AlpacaKeyCheckResult in SettingsDialog):
//   - typed keys (unsaved dialog inputs) take precedence → tested: 'typed'
//   - otherwise the STORED pair for this section is proven → tested: 'stored'
//     (paper section falls back to the legacy single pair, exactly like
//     getAlpacaKeysForMode's paper resolution; live section NEVER falls back)
//   - valid:true + matchesMode:false = the keys WORK but belong to the OTHER
//     account (paper key pasted into the Live section) — the UI renders the
//     red "wrong section" warning instead of letting every live call 401.
export async function POST(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await readJson<TestBody>(req)
    const mode = body.mode === 'live' ? 'live' : 'paper'

    let keyId = ''
    let secret = ''
    let tested: 'typed' | 'stored' = 'typed'

    if (body.alpacaKeyId?.trim() && body.alpacaSecret?.trim()) {
      keyId = body.alpacaKeyId.trim()
      secret = body.alpacaSecret.trim()
    } else {
      tested = 'stored'
      const u = await db.user.findUnique({ where: { id: user.id } })
      const s = (u?.settings ?? {}) as Record<string, unknown>
      const kidEnc =
        mode === 'live'
          ? (s.alpacaLiveKeyIdEnc as string | undefined)
          : ((s.alpacaPaperKeyIdEnc as string | undefined) ?? (s.alpacaKeyIdEnc as string | undefined))
      const secEnc =
        mode === 'live'
          ? (s.alpacaLiveSecretEnc as string | undefined)
          : ((s.alpacaPaperSecretEnc as string | undefined) ?? (s.alpacaSecretEnc as string | undefined))
      if (typeof kidEnc === 'string' && typeof secEnc === 'string') {
        const k = decrypt(kidEnc)
        const sc = decrypt(secEnc)
        // v2.12.6 — ciphertext present but undecryptable (the deployment's
        // APP_ENCRYPTION_SECRET changed, e.g. every redeploy on Render without
        // a stable secret): "no keys saved" would be a lie — say re-save.
        if (!k || !sc) {
          const unreadable: AlpacaKeyCheck & { tested: 'typed' | 'stored' } = {
            valid: false,
            detected: null,
            matchesMode: null,
            tested,
            message: `A ${mode === 'live' ? 'LIVE' : 'Paper'} key pair IS saved here but couldn't be decrypted — the deployment's APP_ENCRYPTION_SECRET changed. Re-enter the keys and Save again (Test proves them immediately).`,
          }
          return NextResponse.json(unreadable)
        }
        keyId = k
        secret = sc
      }
    }

    if (!keyId || !secret) {
      const empty: AlpacaKeyCheck & { tested: 'typed' | 'stored' } = {
        valid: false,
        detected: null,
        matchesMode: null,
        tested,
        message:
          tested === 'stored'
            ? `No ${mode === 'live' ? 'LIVE' : 'Paper'} keys saved in this section — paste a Key ID and Secret, then Test again.`
            : 'Paste both the Key ID and the Secret, then Test again.',
      }
      return NextResponse.json(empty)
    }

    const check = await detectAlpacaKeyAccount(keyId, secret, mode)
    return NextResponse.json({ ...check, tested })
  } catch (e) {
    return handleError(e)
  }
}
