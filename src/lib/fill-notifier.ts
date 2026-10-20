// Telegram notifications for ORDER FILLED and POSITION CLOSED events.
//
// A per-(user, mode) watcher keeps a persisted cursor (NotifyState): every
// cycle it diffs the broker's recently-closed orders and the open-position
// snapshot against the previous cycle and sends a Telegram message for
//  - fills new since the last run (entry / take-profit / stop-loss labeled
//    from the terminal's client_order_id tags), and
//  - positions that disappeared (or flipped side) since the last snapshot,
//    with the realized P&L estimated from the closing fill vs the snapshot's
//    average entry.
//
// The watcher is kicked from client-polled routes (positions, fills) so it
// runs while the terminal is open; the cursor always advances — even when
// Telegram is not configured — so enabling it later never replays history.
// The FIRST run only takes a baseline snapshot (no notification burst).
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { decrypt } from '@/lib/crypt'
import { sendTelegram } from '@/lib/api-helpers'
import { getClosedOrders, getPositions, TradingOrder, TradingPosition, TradeMode } from '@/lib/trading'

const CYCLE_MS = 15000
const FILL_LOOKBACK_MS = 60_000 // re-scan window; `seen` guards duplicates
const SEEN_TTL_MS = 24 * 60 * 60 * 1000
const SEEN_CAP = 400

interface PosSnapshotEntry {
  side: string
  qty: number
  avgEntry: number
}

interface SeenEntry {
  id: string
  at: number
}

interface UserSettingsShape {
  telegramTokenEnc?: string
  telegramChatId?: string
  notifyFills?: boolean
  notifyCloses?: boolean
}

/** Supervised (user,mode) pairs — survives dev hot reloads via globalThis. */
function supervisedSet(): Set<string> {
  const g = globalThis as { __ttFillNotified?: Set<string> }
  if (!g.__ttFillNotified) g.__ttFillNotified = new Set<string>()
  return g.__ttFillNotified
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const fmtQty = (n: number): string => String(parseFloat(n.toFixed(8)))

const fmtPx = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 6 : 2 })}`

/** Human label for what an order was, from the terminal's client_order_id tags. */
function orderRole(o: TradingOrder): string {
  const coid = o.client_order_id || ''
  if (coid.startsWith('ttb-')) return 'Entry (planned TP/SL)'
  if (coid.endsWith('-tp')) return coid.startsWith('ttp-heal-') ? 'Take profit (auto-restored)' : 'Take profit'
  if (coid.endsWith('-sl')) return coid.startsWith('ttp-heal-') ? 'Stop loss (auto-restored)' : 'Stop loss'
  if (o.order_class === 'bracket' || o.group_role === 'take_profit') return 'Take profit'
  if (o.group_role === 'stop_loss') return 'Stop loss'
  return 'Order'
}

export function ensureFillNotifier(userId: string, mode: TradeMode): void {
  const key = `${userId}|${mode}`
  if (supervisedSet().has(key)) return
  supervisedSet().add(key)
  const timer = setInterval(() => {
    void runCycle(userId, mode)
  }, CYCLE_MS)
  // never keep the process alive just for the notifier
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  void runCycle(userId, mode)
}

async function runCycle(userId: string, mode: TradeMode): Promise<void> {
  try {
    const state = await db.notifyState.findUnique({ where: { userId_mode: { userId, mode } } })
    const prevPositions = (state?.positions ?? null) as Record<string, PosSnapshotEntry> | null
    const prevSeen = (state?.seen ?? null) as SeenEntry[] | null
    const lastRun = state?.lastRunAt ? state.lastRunAt.getTime() : 0

    const [closedRes, posRes, dbUser] = await Promise.all([
      getClosedOrders(userId, mode, 100),
      getPositions(userId, mode),
      db.user.findUnique({ where: { id: userId } }),
    ])

    const s = ((dbUser?.settings as UserSettingsShape | null) || {}) as UserSettingsShape
    let token: string | null = null
    if (s.telegramTokenEnc) token = decrypt(s.telegramTokenEnc)
    const chatId = s.telegramChatId || ''
    const notifyFills = s.notifyFills !== false // default ON
    const notifyCloses = s.notifyCloses !== false // default ON

    // snapshot for the NEXT cycle — always advanced, even when not sending
    const positionsArr: TradingPosition[] = Array.isArray(posRes.data) ? posRes.data : []
    const snapshot: Record<string, PosSnapshotEntry> = {}
    for (const p of positionsArr) {
      snapshot[p.symbol] = {
        side: p.side,
        qty: Math.abs(parseFloat(p.qty) || 0),
        avgEntry: parseFloat(p.avg_entry_price) || 0,
      }
    }

    const now = Date.now()
    const seenArr: SeenEntry[] = Array.isArray(prevSeen) ? prevSeen.filter((e) => e && typeof e.id === 'string' && now - (typeof e.at === 'number' ? e.at : 0) < SEEN_TTL_MS) : []
    const seenIds = new Set(seenArr.map((e) => e.id))
    const newSeen: SeenEntry[] = []
    const markSeen = (id: string) => {
      seenIds.add(id)
      newSeen.push({ id, at: now })
    }

    const orders: TradingOrder[] = Array.isArray(closedRes.data) ? closedRes.data : []
    const cutoff = (lastRun || now - FILL_LOOKBACK_MS) - 5000 // small overlap; seen dedupes

    // ---- fills ----
    if (token && chatId && notifyFills) {
      const fills = orders.filter(
        (o) => o.status === 'filled' && !!o.filled_at && new Date(o.filled_at).getTime() >= cutoff,
      )
      for (const o of fills) {
        if (seenIds.has(o.id)) continue
        markSeen(o.id)
        const qty = parseFloat(o.filled_qty) || parseFloat(o.qty) || 0
        const px = o.filled_avg_price ? parseFloat(o.filled_avg_price) : null
        const text =
          `✅ <b>Order filled</b> — ${esc(o.side.toUpperCase())} ${fmtQty(qty)} ${esc(o.symbol)}` +
          (px ? ` @ ${fmtPx(px)}` : '') +
          `\n🏷 ${esc(orderRole(o))} · ${esc(mode)}`
        const ok = await sendTelegram(token, chatId, text)
        if (!ok) console.warn(`[notify] telegram fill send failed (${mode} ${o.symbol})`)
      }
    } else {
      // still mark everything old as seen so a later enable doesn't replay
      for (const o of orders) {
        if (o.status === 'filled' && o.filled_at && new Date(o.filled_at).getTime() >= cutoff && !seenIds.has(o.id)) {
          markSeen(o.id)
        }
      }
    }

    // ---- position closures ----
    if (token && chatId && notifyCloses && prevPositions && typeof prevPositions === 'object') {
      for (const [sym, prev] of Object.entries(prevPositions)) {
        if (!prev || typeof prev !== 'object' || !('qty' in prev)) continue
        const cur = snapshot[sym]
        const stillOpen = cur && cur.side === prev.side && cur.qty > 0
        if (stillOpen) continue
        // closed (or flipped) — estimate realized P&L from the freshest
        // closing fill this cycle vs the snapshot's average entry
        const exitSide = prev.side === 'short' ? 'buy' : 'sell'
        const closingFill = orders
          .filter(
            (o) =>
              o.symbol === sym &&
              o.side === exitSide &&
              o.status === 'filled' &&
              o.filled_at &&
              new Date(o.filled_at).getTime() >= cutoff,
          )
          .sort((a, b) => new Date(b.filled_at as string).getTime() - new Date(a.filled_at as string).getTime())[0]
        let realized: number | null = null
        if (closingFill?.filled_avg_price && prev.avgEntry > 0) {
          const exitPx = parseFloat(closingFill.filled_avg_price)
          const exitQty = parseFloat(closingFill.filled_qty) || prev.qty
          if (Number.isFinite(exitPx)) {
            realized = (exitPx - prev.avgEntry) * exitQty * (prev.side === 'long' ? 1 : -1)
          }
        }
        const text =
          `🔒 <b>Position closed</b> — ${esc(sym)} ${esc(prev.side.toUpperCase())} ${fmtQty(prev.qty)}` +
          (prev.avgEntry > 0 ? ` · avg ${fmtPx(prev.avgEntry)}` : '') +
          (realized != null ? `\n💰 Realized ≈ ${realized >= 0 ? '+' : '−'}$${Math.abs(realized).toFixed(2)}` : '') +
          `\n🏷 ${esc(mode)}`
        const ok = await sendTelegram(token, chatId, text)
        if (!ok) console.warn(`[notify] telegram close send failed (${mode} ${sym})`)
      }
    }

    const mergedSeen = [...seenArr, ...newSeen]
      // dedup by id, newest wins, cap the ring
      .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
      .sort((a, b) => b.at - a.at)
      .slice(0, SEEN_CAP)

    await db.notifyState.upsert({
      where: { userId_mode: { userId, mode } },
      create: {
        userId,
        mode,
        lastRunAt: new Date(),
        positions: snapshot as unknown as Prisma.InputJsonValue,
        seen: mergedSeen as unknown as Prisma.InputJsonValue,
      },
      update: {
        lastRunAt: new Date(),
        positions: snapshot as unknown as Prisma.InputJsonValue,
        seen: mergedSeen as unknown as Prisma.InputJsonValue,
      },
    })
  } catch (e) {
    console.warn('[notify] fill-notifier cycle failed:', e instanceof Error ? e.message : e)
  }
}
