import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyLoginTicket, setSessionCookie } from '@/lib/auth'
import { verifyTotp } from '@/lib/totp'
import { readJson, handleError } from '@/lib/api-helpers'

interface VerifyBody {
  ticket: string
  code: string
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
    if (!user || !verifyTotp(user.totpSecret, body.code || '')) {
      return NextResponse.json({ error: 'Invalid 2FA code' }, { status: 401 })
    }
    await setSessionCookie(user.id)
    return NextResponse.json({ user: { id: user.id, username: user.username } })
  } catch (e) {
    return handleError(e)
  }
}
