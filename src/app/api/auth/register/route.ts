import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, verifyPassword, setSessionCookie, createLoginTicket, clientIp } from '@/lib/auth'
import { verifyTotp, encryptTotpSecret } from '@/lib/totp'
import { rateLimit, resetRateLimit } from '@/lib/rate-limit'
import { readJson, handleError } from '@/lib/api-helpers'

interface RegisterBody {
  username: string
  password: string
  totpSecret: string
  totpCode: string
}

function registrationEnabled(): boolean {
  // Default CLOSED when unset — new deployments must opt in explicitly.
  return (process.env.ALLOW_REGISTRATION || '').trim().toLowerCase() === 'true'
}

// POST /api/auth/register — creates account (password + TOTP verified), then signs in.
export async function POST(req: Request) {
  try {
    const ip = clientIp(req)
    const rl = rateLimit(`reg:${ip}`, 5, 10 * 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many attempts — try again later' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } }
      )
    }
    const body = await readJson<RegisterBody>(req)
    const username = (body.username || '').trim()
    const password = body.password || ''
    if (username.length < 3 || username.length > 40) {
      return NextResponse.json({ error: 'Username must be 3-40 characters' }, { status: 400 })
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }
    // First-run bootstrap (Task 9-j): a fresh deployment — sanitized env, empty
    // DB, closed registration gate — must be able to create its FIRST account,
    // or it is permanently locked out after every publish reset. The gate
    // still applies to every account after the first; rate limiting above caps
    // abuse of the bootstrap window.
    const userCount = await db.user.count()
    if (!registrationEnabled() && userCount > 0) {
      return NextResponse.json({ error: 'Registration is disabled' }, { status: 403 })
    }
    if (!body.totpSecret || !verifyTotp(body.totpSecret, body.totpCode)) {
      return NextResponse.json({ error: 'Invalid 2FA code — scan the QR code and enter the 6-digit code' }, { status: 400 })
    }
    const existing = await db.user.findUnique({ where: { username } })
    if (existing) {
      // Anti-enumeration: same generic shape as any other failed attempt —
      // never reveal that the username exists.
      return NextResponse.json({ error: 'Cannot register' }, { status: 400 })
    }
    const user = await db.user.create({
      data: {
        username,
        passwordHash: hashPassword(password),
        totpSecret: encryptTotpSecret(body.totpSecret), // encrypted at rest
      },
    })
    // Seed default watchlist
    await db.watchlist.create({
      data: { userId: user.id, name: 'My Watchlist', color: '#22c55e', sortOrder: 0, items: ['AAPL', 'MSFT', 'NVDA', 'TSLA'] },
    })
    await setSessionCookie(user.id)
    return NextResponse.json({ user: { id: user.id, username: user.username } })
  } catch (e) {
    return handleError(e)
  }
}

interface LoginBody {
  username: string
  password: string
}

// PUT /api/auth/register — login step 1: password check → login ticket for TOTP step.
// (NOT gated by ALLOW_REGISTRATION — this is the login flow.)
export async function PUT(req: Request) {
  try {
    const ip = clientIp(req)
    const rl = rateLimit(`reg:${ip}`, 5, 10 * 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many attempts — try again later' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } }
      )
    }
    const body = await readJson<LoginBody>(req)
    const user = await db.user.findUnique({ where: { username: (body.username || '').trim() } })
    if (!user || !verifyPassword(body.password || '', user.passwordHash)) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 })
    }
    // Successful password check clears the IP budget so legitimate logins
    // never accumulate toward the failure limit.
    resetRateLimit(`reg:${ip}`)
    return NextResponse.json({ ticket: createLoginTicket(user.id), username: user.username })
  } catch (e) {
    return handleError(e)
  }
}
