import { NextResponse } from 'next/server'
import { getAlpacaKeys } from '@/lib/alpaca'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'

/**
 * GET /api/stream/keys — INTERNAL endpoint for the stream-service mini service.
 *
 * The browser NEVER calls this directly. The stream service calls it
 * server-side with the connecting user's session cookie (forwarded from the
 * socket handshake) to obtain the decrypted Alpaca keys so it can open the
 * Alpaca data websocket on the user's behalf. Requires a valid session —
 * anonymous visitors get an empty response and the stream service simulates
 * stock ticks in demo mode (crypto always streams free from Binance).
 */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ keyId: '', secret: '' })
    const keys = await getAlpacaKeys(user.id)
    if (!keys) return NextResponse.json({ keyId: '', secret: '' })
    return NextResponse.json({ keyId: keys.keyId, secret: keys.secret })
  } catch (e) {
    return handleError(e)
  }
}
