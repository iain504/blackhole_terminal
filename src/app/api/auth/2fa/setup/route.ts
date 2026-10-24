import { NextResponse } from 'next/server'
import { generateTotpSecret, otpauthUri } from '@/lib/totp'
import { clientIp } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import QRCode from 'qrcode'

// GET /api/auth/2fa/setup?username=... — generates a TOTP secret + QR for registration.
export async function GET(req: Request) {
  const rl = rateLimit(`2fa:${clientIp(req)}`, 10, 10 * 60_000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many attempts — try again later' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } }
    )
  }
  const { searchParams } = new URL(req.url)
  const username = (searchParams.get('username') || 'user').slice(0, 40)
  const secret = generateTotpSecret()
  const uri = otpauthUri(username, secret)
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
  return NextResponse.json({ secret, otpauth: uri, qrDataUrl })
}
