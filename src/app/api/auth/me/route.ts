import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'

export async function GET() {
  try {
    const user = await getSessionUser()
    // v2.12.2 — no-store: a session probe must NEVER be cacheable by any
    // intermediary (a cached {user:null} would flip an authenticated client
    // back to the login screen on the next boot; a cached {user} would mask
    // a dead session). Route handlers don't set Cache-Control by default.
    return NextResponse.json({ user }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    return handleError(e)
  }
}
