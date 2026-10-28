// Shared helpers for API route handlers.
import { NextResponse } from 'next/server'
import { UnauthorizedError } from './auth'

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

/** Task 89 — thrown by readJson for malformed/oversized bodies; handleError
 *  maps it to a clean 400 (it used to surface as a 500 with parser noise). */
export class BadRequestError extends Error {}

export function handleError(e: unknown) {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (e instanceof BadRequestError) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
  console.error('API error:', e)
  // Task 89 — unexpected errors return a GENERIC message: Prisma driver
  // text and internal exception details used to reach the browser verbatim.
  // Everything user-facing is returned by the routes themselves (verified:
  // no api route relies on thrown Error messages), and the full detail is
  // logged server-side above.
  return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 })
}

export async function readJson<T>(req: Request, maxBytes = 1_000_000): Promise<T> {
  // Task 89 — bound the body: settings capped at 256KB already, but every
  // other route streamed req.json() unbounded (an authenticated client could
  // buffer megabytes in memory per request). Content-length is checked when
  // the client sends it; the parse failure path catches the rest.
  const len = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(len) && len > maxBytes) {
    throw new BadRequestError(`Request body too large (max ${Math.round(maxBytes / 1024)}KB)`)
  }
  try {
    return (await req.json()) as T
  } catch {
    throw new BadRequestError('Request body is not valid JSON')
  }
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: controller.signal,
    })
    return res.ok
  } catch (e) {
    console.error('Telegram send failed:', e instanceof Error ? e.message : e)
    return false
  } finally {
    clearTimeout(timer)
  }
}
