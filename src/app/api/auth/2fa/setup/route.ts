import { NextResponse } from 'next/server'
import { generateTotpSecret, otpauthUri } from '@/lib/totp'
import QRCode from 'qrcode'

// GET /api/auth/2fa/setup?username=... — generates a TOTP secret + QR for registration.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const username = (searchParams.get('username') || 'user').slice(0, 40)
  const secret = generateTotpSecret()
  const uri = otpauthUri(username, secret)
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
  return NextResponse.json({ secret, otpauth: uri, qrDataUrl })
}
