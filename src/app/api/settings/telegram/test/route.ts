import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { decrypt } from '@/lib/crypt'
import { sendTelegram, handleError } from '@/lib/api-helpers'

// POST /api/settings/telegram/test — send a test message to the user's
// configured chat so they can verify bot token + chat ID before relying on
// fill/close notifications.
//
// v2.12.5 — RESTORED: the Settings → Notifications Test button has POSTed to
// this URL since the v1.91.0 refactor, but the route never existed in
// src/app/api — every click 404'd ("Is the bot token and chat ID
// configured?"). Reads the SAME stored fields fill-notifier uses
// (telegramTokenEnc decrypted at rest + telegramChatId).
export async function POST() {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const u = await db.user.findUnique({ where: { id: user.id } })
    const s = (u?.settings ?? {}) as { telegramTokenEnc?: string; telegramChatId?: string }
    const token = s.telegramTokenEnc ? decrypt(s.telegramTokenEnc) : null
    const chatId = (s.telegramChatId || '').trim()
    if (!token || !chatId) {
      return NextResponse.json(
        { error: 'Telegram is not configured — save a bot token and chat ID first, then Test.' },
        { status: 400 },
      )
    }
    const ok = await sendTelegram(
      token,
      chatId,
      '<b>BLACKHOLE Terminal</b> — test message. Fill/close notifications for this account are wired to this chat.',
    )
    if (!ok) {
      return NextResponse.json(
        { error: 'Telegram API rejected the send — check the bot token and chat ID (if the bot was started recently, message it once in Telegram first).' },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
