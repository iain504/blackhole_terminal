// Shared helpers for API route handlers.
import { NextResponse } from 'next/server'
import { UnauthorizedError } from './auth'

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

export function handleError(e: unknown) {
  if (e instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.error('API error:', e)
  const message = e instanceof Error ? e.message : 'Internal error'
  return NextResponse.json({ error: message }, { status: 500 })
}

export async function readJson<T>(req: Request): Promise<T> {
  return (await req.json()) as T
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
