import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getQuotes } from '@/lib/alpaca'
import { sendTelegram, handleError } from '@/lib/api-helpers'

interface UserSettings {
  telegramTokenEnc?: string
  telegramChatId?: string
}

// POST /api/alerts/check — poll engine: evaluate active alerts against live quotes.
// Client calls this periodically (every ~30s). Triggers Telegram when configured.
export async function POST() {
  try {
    const user = await requireUser()
    const alerts = await db.alert.findMany({
      where: { userId: user.id, status: 'active' },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })
    if (alerts.length === 0) return NextResponse.json({ triggered: [], checked: 0 })

    const symbols = [...new Set(alerts.map((a) => a.symbol))]
    const { quotes } = await getQuotes(symbols, user.id)
    const bySymbol = new Map(quotes.map((q) => [q.symbol, q]))

    const settings = (user as { settings?: UserSettings | null })?.settings ?? null
    // user object from requireUser doesn't include settings; fetch explicitly
    const dbUser = await db.user.findUnique({ where: { id: user.id } })
    const s = (dbUser?.settings as UserSettings | null) || null
    let telegramToken: string | null = null
    if (s?.telegramTokenEnc) {
      const { decrypt } = await import('@/lib/crypt')
      telegramToken = decrypt(s.telegramTokenEnc)
    }
    const telegramChatId = s?.telegramChatId || null

    const triggered: { id: string; symbol: string; price: number; target: number; direction: string }[] = []

    for (const a of alerts) {
      const q = bySymbol.get(a.symbol)
      if (!q) continue
      const side = q.price > a.price ? 'above' : q.price < a.price ? 'below' : a.lastSide
      const crossed =
        a.direction === 'above'
          ? side === 'above' && a.lastSide !== 'above'
          : side === 'below' && a.lastSide !== 'below'
      if (crossed) {
        await db.alert.update({
          where: { id: a.id },
          data: { status: 'triggered', triggeredAt: new Date(), lastSide: side },
        })
        triggered.push({ id: a.id, symbol: a.symbol, price: q.price, target: a.price, direction: a.direction })
        if (telegramToken && telegramChatId) {
          const arrow = a.direction === 'above' ? '📈 above' : '📉 below'
          await sendTelegram(
            telegramToken,
            telegramChatId,
            `🔔 <b>Price Alert</b>\n<b>${a.symbol}</b> is now ${arrow} your alert level\n\nPrice: <b>${q.price.toFixed(4)}</b>\nAlert: ${a.price.toFixed(4)}\nTime: ${new Date().toUTCString()}`,
          )
        }
      } else {
        // update stored side so re-entry after leaving re-triggers
        if (side !== a.lastSide) {
          await db.alert.update({ where: { id: a.id }, data: { lastSide: side } })
        }
      }
    }
    return NextResponse.json({ triggered, checked: alerts.length })
  } catch (e) {
    return handleError(e)
  }
}
