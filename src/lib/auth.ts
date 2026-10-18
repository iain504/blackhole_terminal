// Lightweight session auth: scrypt password hashing + HMAC-signed cookie tokens.
// 2FA is enforced with TOTP at login (see /api/auth/*).
import crypto from 'crypto'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'

const SECRET =
  process.env.AUTH_SECRET || 'zai-tradeterminal-local-dev-secret'

export const SESSION_COOKIE = 'tt_session'
const SESSION_TTL_S = 60 * 60 * 24 * 30 // 30 days

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    const candidate = crypto.scryptSync(password, salt, 64)
    const expected = Buffer.from(hash, 'hex')
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
  } catch {
    return false
  }
}

function sign(data: string): string {
  return crypto.createHmac('sha256', SECRET).update(data).digest('hex')
}

/** Session token: userId.expiry.signature */
export function createSessionToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S
  const payload = `${userId}.${exp}`
  return `${payload}.${sign(payload)}`
}

export function verifySessionToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userId, expStr, sig] = parts
  const payload = `${userId}.${expStr}`
  const expected = sign(payload)
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  if (parseInt(expStr, 10) * 1000 < Date.now()) return null
  return userId
}

/** Short-lived ticket used between password step and TOTP step of login. */
export function createLoginTicket(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 120
  const payload = `login.${userId}.${exp}`
  return `${payload}.${sign(payload)}`
}

export function verifyLoginTicket(ticket: string): string | null {
  const parts = ticket.split('.')
  if (parts.length !== 4 || parts[0] !== 'login') return null
  const [, userId, expStr, sig] = parts
  const payload = `login.${userId}.${expStr}`
  const expected = sign(payload)
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  if (parseInt(expStr, 10) * 1000 < Date.now()) return null
  return userId
}

export async function setSessionCookie(userId: string) {
  const store = await cookies()
  store.set(SESSION_COOKIE, createSessionToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_S,
  })
}

export async function clearSessionCookie() {
  const store = await cookies()
  store.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
}

export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySessionToken(token)
}

export interface SessionUser {
  id: string
  username: string
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const userId = await getSessionUserId()
  if (!userId) return null
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) return null
  return { id: user.id, username: user.username }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
  }
}

/** Throws UnauthorizedError when no valid session. Catch in route handlers. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) throw new UnauthorizedError()
  return user
}
