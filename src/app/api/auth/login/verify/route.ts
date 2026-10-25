import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyLoginTicket, setSessionCookie, clientIp } from '@/lib/auth'
import { verifyTotp, decryptTotpSecret, encryptTotpSecret } from '@/lib/totp'
import { rateLimit, resetRateLimit } from '@/lib/rate-limit'
import { readJson, handleError } from '@/lib/api-helpers'
import { log } from '@/lib/logger'

interface VerifyBody {
  ticket: string
  code: string
}

// Account lockout (in-memory, per-process): 5 consecutive TOTP failures per
// username → 15-minute lock. Cleared on success. Resets on server restart.
const TOTP_MAX_FAILS = 5
const LOCKOUT_MS = 15 * 60_000
const failures = new Map<string, { count: number; lockedUntil: number }>()

function isLocked(username: string): boolean {
  const s = failures.get(username)
  return !!s && s.lockedUntil > Date.now()
}

function recordFailure(username: string) {
  const now = Date.now()
  const s = failures.get(username)
  // Active locks never reach here (verify short-circuits first). lockedUntil
  // is 0 for an in-progress streak (keep counting); a passed lock window
  // (lockedUntil > 0 and <= now) starts a fresh streak.
  const count = s && s.lockedUntil === 0 ? s.count : 0
  const next = count + 1
  if (next >= TOTP_MAX_FAILS) {
    failures.set(username, { count: 0, lockedUntil: now + LOCKOUT_MS })
  } else {
    failures.set(username, { count: next, lockedUntil: 0 })
  }
}

// POST /api/auth/login/verify — step 2: TOTP code → session cookie.
export async function POST(req: Request) {
  try {
    const body = await readJson<VerifyBody>(req)
    const userId = verifyLoginTicket(body.ticket || '')
    if (!userId) {
      return NextResponse.json({ error: 'Login session expired — please sign in again' }, { status: 401 })
    }
    const user = await db.user.findUnique({ where: { id: userId } })
    // Rate limit per IP+username (fall back to the ticket fragment when the
    // user no longer exists) — 10 attempts / 5 min.
    const keyName = user?.username || (body.ticket || 'unknown').slice(0, 24)
    const ip = clientIp(req)
    const rl = await rateLimit(`loginv:${ip}:${keyName}`, 10, 5 * 60_000)
    if (!rl.ok) {
      log.warn('auth_login_rate_limited', { ip, user: keyName })
      return NextResponse.json(
        { error: 'Too many attempts — try again later' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } }
      )
    }
    if (user && isLocked(user.username)) {
      // Generic message — same shape as the rate-limit response, no lock
      // metadata leaked.
      log.warn('auth_login_rate_limited', { ip, user: user.username, reason: 'lockout' })
      return NextResponse.json(
        { error: 'Too many attempts — try again later' },
        { status: 429, headers: { 'retry-after': '900' } }
      )
    }
    const secret = user ? decryptTotpSecret(user.totpSecret) : null
    if (!user || !secret || !verifyTotp(secret, body.code || '')) {
      if (user) recordFailure(user.username)
      // Structured ops event (Task 11-c) — no codes, no secrets, just shape.
      log.warn('auth_login_failed', { ip, user: user?.username ?? 'unknown', reason: !user ? 'no-user' : !secret ? 'undecryptable-secret' : 'bad-code' })
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
    }
    // Success: clear failure counter + rate budget.
    failures.delete(user.username)
    void resetRateLimit(`loginv:${ip}:${user.username}`)
    // Migrate legacy plaintext TOTP secret to encrypted-at-rest (one-time).
    if (!user.totpSecret.startsWith('enc:')) {
      try {
        await db.user.update({ where: { id: user.id }, data: { totpSecret: encryptTotpSecret(secret) } })
      } catch {
        // non-fatal — migration retries on the next successful login
      }
    }
    await setSessionCookie(user.id)
    log.info('auth_login_ok', { user: user.username, ip })
    return NextResponse.json({ user: { id: user.id, username: user.username } })
  } catch (e) {
    return handleError(e)
  }
}
