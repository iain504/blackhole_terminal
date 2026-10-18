import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, verifyPassword, setSessionCookie, createLoginTicket } from '@/lib/auth'
import { verifyTotp } from '@/lib/totp'
import { readJson, handleError } from '@/lib/api-helpers'

interface RegisterBody {
  username: string
  password: string
  totpSecret: string
  totpCode: string
}

// POST /api/auth/register — creates account (password + TOTP verified), then signs in.
export async function POST(req: Request) {
  try {
    const body = await readJson<RegisterBody>(req)
    const username = (body.username || '').trim()
    const password = body.password || ''
    if (username.length < 3 || username.length > 40) {
      return NextResponse.json({ error: 'Username must be 3-40 characters' }, { status: 400 })
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
    }
    if (!body.totpSecret || !verifyTotp(body.totpSecret, body.totpCode)) {
      return NextResponse.json({ error: 'Invalid 2FA code — scan the QR code and enter the 6-digit code' }, { status: 400 })
    }
    const existing = await db.user.findUnique({ where: { username } })
    if (existing) {
      return NextResponse.json({ error: 'Username already taken' }, { status: 409 })
    }
    const user = await db.user.create({
      data: {
        username,
        passwordHash: hashPassword(password),
        totpSecret: body.totpSecret,
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
export async function PUT(req: Request) {
  try {
    const body = await readJson<LoginBody>(req)
    const user = await db.user.findUnique({ where: { username: (body.username || '').trim() } })
    if (!user || !verifyPassword(body.password || '', user.passwordHash)) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 })
    }
    return NextResponse.json({ ticket: createLoginTicket(user.id), username: user.username })
  } catch (e) {
    return handleError(e)
  }
}
