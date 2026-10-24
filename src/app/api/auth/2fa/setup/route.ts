import { NextResponse } from 'next/server'
import { generateTotpSecret, otpauthUri } from '@/lib/totp'
import { clientIp } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { registrationOpen } from '@/lib/registration'
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
  // Task 9-k — fail fast: gate HERE (registration step 1 "Continue") so a
  // closed gate surfaces immediately, not after the user scans the QR and
  // enters a code into POST /api/auth/register.
  if (!(await registrationOpen())) {
    return NextResponse.json({ error: 'Registration is disabled' }, { status: 403 })
  }
  const { searchParams } = new URL(req.url)
  const username = (searchParams.get('username') || 'user').slice(0, 40)
  const secret = generateTotpSecret()
  const uri = otpauthUri(username, secret)
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
  return NextResponse.json({ secret, otpauth: uri, qrDataUrl })
}
