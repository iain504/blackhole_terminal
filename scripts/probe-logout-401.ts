// QA probe for v2.12.3 — reproduces the hosted "auto logout in 2 seconds"
// scenario at the HTTP contract level: a VALID session + GARBAGE Alpaca keys
// (the hosted situation when stored keys can't decrypt or are wrong). The
// whole post-login poll barrage must contain ZERO raw HTTP 401s — the account
// route answers 200 + structured authError, everything else 200/422/502.
// Usage: bun scripts/probe-logout-401.ts  (needs the dev server on :3000)
import { db } from '@/lib/db'
import { hashPassword, createSessionToken, SESSION_COOKIE } from '@/lib/auth'
import { encrypt } from '@/lib/crypt'
import { resolveAppSecret } from '@/lib/app-secret'

const BASE = process.env.PROBE_BASE || 'http://localhost:3000'
const USERNAME = 'e2e_probe_logout'

async function main() {
  // crypt (encrypt + the session token's HMAC) resolves APP_ENCRYPTION_SECRET
  // lazily — outside Next's boot instrumentation we must resolve it ourselves.
  await resolveAppSecret()
  // 1. fresh user + garbage paper keys (encrypted exactly like Settings does)
  await db.user.deleteMany({ where: { username: USERNAME } })
  const user = await db.user.create({
    data: {
      username: USERNAME,
      passwordHash: hashPassword('probe-password-123'),
      totpSecret: encrypt('JBSWY3DPEHPK3PXP'), // encrypted at rest, never used here
      settings: {
        alpacaPaperKeyIdEnc: encrypt('PKFAKEKEYFAKEKEYFAKE'),
        alpacaPaperSecretEnc: encrypt('fakesecretfakesecretfakesecretfakesecret'),
      },
    },
  })
  try {
    // 2. mint a session cookie exactly like setSessionCookie would
    const token = createSessionToken(user.id)
    const cookie = `${SESSION_COOKIE}=${token}`
    const h = { cookie }

    // 3. the post-login poll barrage (what the terminal root fires in the
    //    first seconds after sign-in)
    const probes: [string, string][] = [
      ['GET', '/api/auth/me'],
      ['GET', '/api/trading/account?mode=paper'],
      ['GET', '/api/trading/positions?mode=paper'],
      ['GET', '/api/trading/fills?mode=paper'],
      ['GET', '/api/trading/orders?mode=paper'],
      ['GET', '/api/trading/portfolio/history?mode=paper&range=day'],
    ]
    let fail = 0
    for (const [method, path] of probes) {
      const res = await fetch(`${BASE}${path}`, { method, headers: h, cache: 'no-store' })
      const body = await res.json().catch(() => null)
      const authError = (body as { authError?: { message?: string } } | null)?.authError?.message
      const bad = res.status === 401 && path !== '/api/auth/me' ? false : res.status === 401
      // /api/auth/me answering 401 would mean the cookie itself is broken
      const flag = res.status === 401 ? '✗ 401 LEAK' : 'ok'
      if (res.status === 401) fail++
      console.log(
        `${flag}  ${method} ${path} -> ${res.status}` +
          (authError ? `  authError: ${authError.slice(0, 90)}…` : ''),
      )
      if (path.includes('account')) {
        console.log(
          `   account body keys: ${Object.keys((body as object) ?? {}).join(',')}`,
        )
      }
      void bad
    }
    console.log(fail === 0 ? '\nPASS — zero 401 leaks across the barrage' : `\nFAIL — ${fail} route(s) leaked 401`)
    process.exitCode = fail === 0 ? 0 : 1
  } finally {
    await db.user.deleteMany({ where: { username: USERNAME } })
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('probe crashed:', e)
    process.exit(1)
  })
