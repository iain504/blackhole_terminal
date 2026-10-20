// Strategy bot engine — conditional ("complex") orders.
//
// A StrategyRule = IF <indicator condition> THEN <market buy/sell with TP/SL>.
// The condition half reuses the indicator-alarm engine (crossing memory via
// lastSide: the first check only records the side, a genuine crossing fires);
// the action half reuses the bracket plumbing (placeOrderWithExits — stocks
// get a native Alpaca bracket, crypto entries carry the plan for the OCO
// supervisor to attach on fill).
//
// Firing is race-safe against BOTH the client poll and the in-process
// supervisor: a rule is claimed with a conditional update
// (armed → placing) and only the claimant places the order. A 'placing' rule
// older than CLAIM_STALE_MS is swept to 'failed' (process died mid-order).
import { db } from '@/lib/db'
import { getQuotes } from '@/lib/alpaca'
import { sendTelegram } from '@/lib/api-helpers'
import { Timeframe, TIMEFRAMES } from '@/lib/market-types'
import { barsFor } from '@/lib/bars-cache'
import { evalIndicatorSignal, isCross, IndicatorParams } from '@/lib/indicator-eval'
import { placeOrderWithExits, ensureCryptoOcoSupervisor, TradeMode } from '@/lib/trading'

interface UserSettings {
  telegramTokenEnc?: string
  telegramChatId?: string
}

export interface StrategyRow {
  id: string
  symbol: string
  kind: string
  condition: string
  level: number
  timeframe: string
  params: unknown
  action: string
  qty: number
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  repeat: boolean
  status: string
  lastSide: string | null
  triggeredAt: Date | null
}

export interface StrategyFire {
  id: string
  symbol: string
  action: string
  qty: number
  ok: boolean
  message: string
  orderId?: string
}

/** A 'placing' claim older than this is a dead engine mid-order → failed. */
const CLAIM_STALE_MS = 90000
/** Supervisor cadence — same ballpark as the client poll (20s). */
const SUPERVISOR_MS = 20000

/** Per-user in-flight guard: poll + supervisor must never run concurrently. */
const inFlight = new Set<string>()

const clampPct = (v: number) => Math.min(100, Math.max(0.01, v))

/**
 * Resolve one exit price. pct values are PERCENT magnitudes (2 = 2%) applied
 * relative to the action side: BUY → TP above / SL below; SELL → the reverse.
 * Returns undefined (no leg), or the price; null means "wanted one but no
 * reference price" (caller turns that into a clean failure).
 */
function resolveExit(
  m: string,
  v: number | null,
  action: string,
  ref: number | null,
  kind: 'tp' | 'sl',
): number | undefined | null {
  if (m === 'price') return v && v > 0 ? v : undefined
  if (m === 'pct') {
    const pct = v != null ? clampPct(Math.abs(v)) : 0
    if (pct <= 0) return undefined
    if (ref == null || ref <= 0) return null
    const profitSide = kind === 'tp' ? action === 'buy' : action === 'sell'
    const p = profitSide ? ref * (1 + pct / 100) : ref * (1 - pct / 100)
    return p > 0 ? p : null
  }
  return undefined
}

const fmtP = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4))

/** Human text for the exit legs of a fire. */
function exitText(
  mode: string, value: number | null, price: number | undefined, action: string, kind: 'TP' | 'SL',
): string {
  if (mode === 'pct' && price != null) {
    const pct = clampPct(Math.abs(value ?? 0))
    const sign = (kind === 'TP') === (action === 'buy') ? '+' : '-'
    return `${kind} ${sign}${pct.toFixed(pct >= 10 ? 0 : 1)}% (${fmtP(price)})`
  }
  if (price != null) return `${kind} ${fmtP(price)}`
  return ''
}

async function evaluateInner(userId: string, mode: TradeMode): Promise<StrategyFire[]> {
  // 0) sweep stale claims (engine died between claim and order result)
  const staleCut = new Date(Date.now() - CLAIM_STALE_MS)
  const stale = await db.strategyRule.updateMany({
    where: { userId, status: 'placing', triggeredAt: { lt: staleCut } },
    data: { status: 'failed', fireNote: 'Engine restarted mid-order — re-arm to try again' },
  })
  if (stale.count > 0) console.log(`[strategy] swept ${stale.count} stale placing rule(s)`)

  const rules = (await db.strategyRule.findMany({
    where: { userId, status: 'armed' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })) as unknown as StrategyRow[]
  if (rules.length === 0) return []

  const dbUser = await db.user.findUnique({ where: { id: userId } })
  const s = (dbUser?.settings as UserSettings | null) || null
  let telegramToken: string | null = null
  if (s?.telegramTokenEnc) {
    const { decrypt } = await import('@/lib/crypt')
    telegramToken = decrypt(s.telegramTokenEnc)
  }
  const telegramChatId = s?.telegramChatId || null
  const notify = async (text: string) => {
    if (telegramToken && telegramChatId) await sendTelegram(telegramToken, telegramChatId, text)
  }

  const fires: StrategyFire[] = []

  // group by symbol+timeframe so each series is fetched at most once
  const groups = new Map<string, StrategyRow[]>()
  for (const r of rules) {
    const tf = TIMEFRAMES[r.timeframe as Timeframe] ? r.timeframe : '1D'
    const key = `${r.symbol}|${tf}`
    const list = groups.get(key) || []
    list.push(r)
    groups.set(key, list)
  }

  for (const [key, list] of groups) {
    const [symbol, tf] = key.split('|')
    let entry
    try {
      entry = await barsFor(symbol, tf as Timeframe, userId)
    } catch {
      continue // data unavailable this cycle — retry next poll
    }
    // NEVER fire orders off fabricated demo bars (Task 39 policy)
    if (entry.demo || entry.bars.length < 5) continue

    for (const r of list) {
      // condition stores its own direction: cross_above/below for both kinds;
      // bull/bear crossovers map bull→above, bear→below (same as alarms)
      const direction: 'above' | 'below' =
        r.condition === 'cross_below' || r.condition === 'bear_cross' ? 'below' : 'above'
      const ev = evalIndicatorSignal(
        r.kind === 'macd' ? 'macd' : 'rsi',
        r.condition,
        direction,
        r.level,
        r.timeframe,
        (r.params as IndicatorParams | null) || null,
        entry.bars,
      )
      if (!ev) continue

      // crossing decision uses the side memory from BEFORE this check (same
      // order as the alarms engine): record the new side first, but fire only
      // when the PREVIOUS check saw the opposite side (a genuine crossing)
      const prevSide = r.lastSide
      if (ev.side !== r.lastSide) {
        // record the side (also the FIRST check after arming — fire only on a
        // genuine crossing afterwards)
        await db.strategyRule.update({ where: { id: r.id }, data: { lastSide: ev.side } })
        r.lastSide = ev.side
      }
      if (!isCross(direction, ev.side, prevSide) || prevSide == null) continue

      // ---- claim the fire (race-safe vs poll + supervisor + pause/delete) ----
      const claim = await db.strategyRule.updateMany({
        where: { id: r.id, status: 'armed' },
        data: { status: 'placing', triggeredAt: new Date() },
      })
      if (claim.count === 0) continue

      const action = r.action === 'sell' ? 'sell' : 'buy'
      const qty = r.qty
      let failNote: string | null = null
      let orderNote = ''
      let orderId: string | undefined

      try {
        // ---- resolve exits (pct modes need a live reference quote) ----
        const needsRef = r.tpMode === 'pct' || r.slMode === 'pct'
        let ref: number | null = null
        if (needsRef) {
          const { quotes } = await getQuotes([symbol], userId)
          ref = quotes.find((q) => q.symbol === symbol)?.price ?? null
          if (ref == null) failNote = 'No live quote available to resolve % TP/SL'
        }
        const tp = failNote ? undefined : resolveExit(r.tpMode, r.tpValue, action, ref, 'tp')
        const sl = failNote ? undefined : resolveExit(r.slMode, r.slValue, action, ref, 'sl')
        if (!failNote && (tp === null || sl === null)) failNote = 'Resolved TP/SL price is invalid'
        if (!failNote && !(qty > 0)) failNote = 'Rule has an invalid qty'

        if (!failNote) {
          // keep the crypto OCO supervisor alive so % entries get exits on fill
          ensureCryptoOcoSupervisor(userId, mode)
          const r2 = await placeOrderWithExits(userId, mode, {
            symbol,
            side: action as 'buy' | 'sell',
            qty,
            type: 'market',
            take_profit: tp === null ? undefined : tp,
            stop_loss: sl === null ? undefined : sl,
          })
          if (r2.results.length === 0) {
            failNote = r2.errors[0] || 'Order rejected'
          } else {
            orderId = r2.results[0]?.id
            const parts = [
              exitText(r.tpMode, r.tpValue, tp ?? undefined, action, 'TP'),
              exitText(r.slMode, r.slValue, sl ?? undefined, action, 'SL'),
            ].filter(Boolean)
            orderNote = parts.length ? ` · ${parts.join(' ')}` : ''
            if (r2.errors.length > 0) orderNote += ` (partial: ${r2.errors[0]})`
          }
        }

        const message = `${ev.message} → ${action.toUpperCase()} ${qty} ${symbol} @ market${orderNote}`

        if (failNote) {
          await db.strategyRule.update({
            where: { id: r.id },
            data: { status: 'failed', fireNote: failNote },
          })
          fires.push({ id: r.id, symbol, action, qty, ok: false, message: `${ev.message} → order FAILED: ${failNote}` })
          await notify(
            `🤖 <b>Strategy FAILED</b>\n<b>${symbol}</b>\n${ev.message}\nAction: ${action.toUpperCase()} ${qty} @ market\nError: ${failNote}\nTime: ${new Date().toUTCString()}`,
          )
        } else {
          await db.strategyRule.update({
            where: { id: r.id },
            data: r.repeat
              ? { status: 'armed', lastSide: null, orderId, fireNote: message, triggeredAt: new Date() }
              : { status: 'triggered', lastSide: ev.side, orderId, fireNote: message, triggeredAt: new Date() },
          })
          fires.push({ id: r.id, symbol, action, qty, ok: true, message, orderId })
          await notify(
            `🤖 <b>Strategy Fired</b>\n<b>${symbol}</b>\n${message}\nTime: ${new Date().toUTCString()}`,
          )
          console.log(`[strategy] fired ${action} ${qty} ${symbol} (${r.kind} ${r.condition} ${r.level} ${r.timeframe}) order=${orderId}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        await db.strategyRule.update({
          where: { id: r.id },
          data: { status: 'failed', fireNote: msg },
        }).catch(() => {})
        fires.push({ id: r.id, symbol, action, qty, ok: false, message: `${ev.message} → order FAILED: ${msg}` })
      }
    }
  }

  return fires
}

/**
 * Evaluate all armed strategy rules for a user. Safe to call concurrently
 * (client poll + supervisor): the second caller is a no-op while one runs.
 */
export async function evaluateStrategies(userId: string, mode: TradeMode): Promise<StrategyFire[]> {
  if (inFlight.has(userId)) return []
  inFlight.add(userId)
  try {
    return await evaluateInner(userId, mode)
  } finally {
    inFlight.delete(userId)
  }
}

// ---- in-process supervisor (fires even with no terminal tab open) ----

type GlobalWithStrategies = typeof globalThis & {
  __ttStrategySupervised?: Map<string, ReturnType<typeof setInterval>>
}

/** Start (once per user+mode) a 20s server-side evaluation cycle. */
export function ensureStrategySupervisor(userId: string, mode: TradeMode): void {
  const g = globalThis as GlobalWithStrategies
  if (!g.__ttStrategySupervised) g.__ttStrategySupervised = new Map()
  const key = `${userId}|${mode}`
  if (g.__ttStrategySupervised.has(key)) return
  const timer = setInterval(() => {
    void evaluateStrategies(userId, mode).catch((e) =>
      console.warn('[strategy] supervisor cycle failed:', e instanceof Error ? e.message : e),
    )
  }, SUPERVISOR_MS)
  // never keep the process alive just for the supervisor
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    ;(timer as { unref: () => void }).unref()
  }
  g.__ttStrategySupervised.set(key, timer)
  console.log(`[strategy] supervisor started for ${key} (every ${SUPERVISOR_MS / 1000}s)`)
}
