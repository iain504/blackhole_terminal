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
import { placeOrderWithExits, ensureCryptoOcoSupervisor, isNoKeysError, TradeMode } from '@/lib/trading'
import { getAtrSnapshot, atrToPct, atrTfOf } from '@/lib/atr'

interface UserSettings {
  telegramTokenEnc?: string
  telegramChatId?: string
}

export interface StrategyRow {
  id: string
  symbol: string
  /** Task 89/94 — the Alpaca account this rule fires on, PINNED at create
   *  time (legacy rows read as 'paper'; 'live' only via the explicit
   *  opt-in: liveConfirm flag + live keys checked at the API) */
  mode?: string | null
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
  /** v1.96.0 — ATR(14) timeframes when the mode is 'atr' */
  tpTf: string | null
  slTf: string | null
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
  /** Task 94 — the pinned account the fire traded on (surfaces in toasts) */
  mode?: 'paper' | 'live'
}

/** A 'placing' claim older than this is a dead engine mid-order → failed. */
const CLAIM_STALE_MS = 90000
/** Supervisor cadence — same ballpark as the client poll (20s). */
const SUPERVISOR_MS = 20000

/** Per-user in-flight guard: poll + supervisor must never run concurrently. */
const inFlight = new Set<string>()

const clampPct = (v: number) => Math.min(100, Math.max(0.01, v))

/**
 * v1.96.0 — resolve one ATR leg to its PERCENT-equivalent at fire time:
 * pct = multiplier × ATR(14, tf) / live quote × 100, which then flows through
 * the SAME resolveExit math as a % leg. Failures return an error string — an
 * armed rule with a configured ATR stop must fail LOUDLY, never drop the leg.
 */
async function resolveAtrLeg(
  symbol: string,
  tf: string | null,
  mult: number | null,
  ref: number | null,
  userId: string,
): Promise<{ pct?: number; error?: string }> {
  if (mult == null || !(mult > 0)) {
    return { error: 'Stored ATR multiplier is invalid — edit the rule; firing without the leg is not allowed' }
  }
  if (ref == null || !(ref > 0)) {
    return { error: 'No live quote available to resolve ATR TP/SL' }
  }
  const effTf = atrTfOf(tf)
  const snap = await getAtrSnapshot(symbol, effTf, userId)
  if (!snap) {
    return { error: `Cannot resolve ATR — no recent ${effTf} bar data for ${symbol} (retry next cycle)` }
  }
  const pct = atrToPct(snap.atr, mult, ref)
  if (pct == null) return { error: 'Resolved ATR distance is invalid' }
  return { pct }
}

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
  tf?: string | null,
): string {
  if (mode === 'atr' && price != null) {
    const m = Math.abs(value ?? 0)
    return `${kind} ${m.toFixed(m >= 10 ? 1 : 2)}×ATR(${tf || '1h'}) (${fmtP(price)})`
  }
  if (mode === 'pct' && price != null) {
    const pct = clampPct(Math.abs(value ?? 0))
    const sign = (kind === 'TP') === (action === 'buy') ? '+' : '-'
    return `${kind} ${sign}${pct.toFixed(pct >= 10 ? 0 : 1)}% (${fmtP(price)})`
  }
  if (price != null) return `${kind} ${fmtP(price)}`
  return ''
}

/** Append one fire to the history log (Strategy Orders tab: rules, P&L, trades). */
async function logFire(
  userId: string,
  r: StrategyRow,
  data: { ok: boolean; message: string; orderId?: string },
): Promise<void> {
  try {
    await db.strategyFireLog.create({
      data: {
        userId,
        ruleId: r.id,
        symbol: r.symbol,
        action: r.action === 'sell' ? 'sell' : 'buy',
        qty: r.qty,
        ok: data.ok,
        message: data.message,
        // Task 94 — the fire's OWN account (the rule can move later; the
        // log stays attributable to the tape it actually traded on)
        mode: r.mode === 'live' ? 'live' : 'paper',
        orderId: data.orderId ?? null,
      },
    })
  } catch (e) {
    console.warn('[strategy] fire log write failed:', e instanceof Error ? e.message : e)
  }
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
      // Task 89/94 — the rule fires on its PINNED account ('live' only
      // reachable through the create/PATCH opt-in rail); the caller's mode
      // arg is legacy fallback only.
      const fireMode: TradeMode = r.mode === 'live' ? 'live' : 'paper'
      // Task 94 (review R-1#1) — every push channel must say WHICH account
      // fired: a paper fire and a real-money live fire used to be
      // byte-identical on Telegram, toasts and the fire log
      const liveTag = fireMode === 'live' ? '[LIVE] ' : ''
      let failNote: string | null = null
      let orderNote = ''
      let orderId: string | undefined

      try {
        // ---- resolve exits (pct/atr modes need a live reference quote) ----
        const needsRef = r.tpMode === 'pct' || r.slMode === 'pct' || r.tpMode === 'atr' || r.slMode === 'atr'
        let ref: number | null = null
        if (needsRef) {
          // v1.80.8 — trading:true: % exits anchor to this quote, so a data
          // hiccup must fail the rule honestly (no quote → failNote below),
          // never anchor legs to a simulator price
          const { quotes } = await getQuotes([symbol], userId, { trading: true })
          ref = quotes.find((q) => q.symbol === symbol)?.price ?? null
          if (ref == null) failNote = 'No live quote available to resolve %/ATR TP/SL'
        }
        // v1.96.0 — ATR legs resolve to percent-equivalents (mult × ATR(tf)
        // vs the live quote) and flow through the SAME resolveExit math. Any
        // resolution failure fails the fire loudly (never a naked entry).
        let tpEffMode = r.tpMode
        let tpEffVal = r.tpValue
        let slEffMode = r.slMode
        let slEffVal = r.slValue
        if (!failNote && r.tpMode === 'atr') {
          const leg = await resolveAtrLeg(symbol, r.tpTf, r.tpValue, ref, userId)
          if (leg.error) failNote = leg.error
          else { tpEffMode = 'pct'; tpEffVal = leg.pct ?? null }
        }
        if (!failNote && r.slMode === 'atr') {
          const leg = await resolveAtrLeg(symbol, r.slTf, r.slValue, ref, userId)
          if (leg.error) failNote = leg.error
          else { slEffMode = 'pct'; slEffVal = leg.pct ?? null }
        }
        const tp = failNote ? undefined : resolveExit(tpEffMode, tpEffVal, action, ref, 'tp')
        const sl = failNote ? undefined : resolveExit(slEffMode, slEffVal, action, ref, 'sl')
        if (!failNote && (tp === null || sl === null)) failNote = 'Resolved TP/SL price is invalid'
        // Task 89 — FAIL LOUD on a stored-but-invalid exit: resolveExit
        // returns undefined for tpValue/slValue ≤ 0 (a corrupted PATCH used
        // to store those), and undefined slipped past the null check → the
        // order went out NAKED while the UI showed the leg armed. An armed
        // rule with a configured-but-invalid leg must fail visibly instead.
        if (!failNote && r.tpMode !== 'none' && tp === undefined) failNote = 'Stored TP value is invalid (≤ 0) — edit the rule; firing without it is not allowed'
        if (!failNote && r.slMode !== 'none' && sl === undefined) failNote = 'Stored SL value is invalid (≤ 0) — edit the rule; firing without it is not allowed'
        if (!failNote && !(qty > 0)) failNote = 'Rule has an invalid qty'

        if (!failNote) {
          // keep the crypto OCO supervisor alive so % entries get exits on fill
          ensureCryptoOcoSupervisor(userId, fireMode)
          const r2 = await placeOrderWithExits(userId, fireMode, {
            symbol,
            side: action as 'buy' | 'sell',
            qty,
            type: 'market',
            take_profit: tp === null ? undefined : tp,
            stop_loss: sl === null ? undefined : sl,
          })
          if (r2.results.length === 0) {
            // Task 94 (review R-1#7) — the raw 'no-keys'/'no-live-keys' tokens
            // are route-layer copy; the engine must surface human text
            const rawErr = r2.errors[0] || 'Order rejected'
            failNote = isNoKeysError(rawErr)
              ? `No usable Alpaca keys for this rule's ${fireMode.toUpperCase()} account — add them in Settings → API keys`
              : rawErr
          } else {
            orderId = r2.results[0]?.id
            const parts = [
              exitText(r.tpMode, r.tpValue, tp ?? undefined, action, 'TP', r.tpTf),
              exitText(r.slMode, r.slValue, sl ?? undefined, action, 'SL', r.slTf),
            ].filter(Boolean)
            orderNote = parts.length ? ` · ${parts.join(' ')}` : ''
            if (r2.errors.length > 0) orderNote += ` (partial: ${r2.errors[0]})`
          }
        }

        const message = `${liveTag}${ev.message} → ${action.toUpperCase()} ${qty} ${symbol} @ market${orderNote}`

        if (failNote) {
          await db.strategyRule.update({
            where: { id: r.id },
            data: { status: 'failed', fireNote: failNote },
          })
          fires.push({ id: r.id, symbol, action, qty, ok: false, message: `${liveTag}${ev.message} → order FAILED: ${failNote}`, mode: fireMode })
          await logFire(userId, r, { ok: false, message: `${liveTag}${ev.message} → order FAILED: ${failNote}` })
          await notify(
            `🤖 <b>Strategy FAILED</b>${fireMode === 'live' ? ' ⚠️ LIVE' : ''}\n<b>${symbol}</b>\n${ev.message}\nAction: ${action.toUpperCase()} ${qty} @ market\nAccount: ${fireMode.toUpperCase()}\nError: ${failNote}\nTime: ${new Date().toUTCString()}`,
          )
        } else {
          await db.strategyRule.update({
            where: { id: r.id },
            data: r.repeat
              ? { status: 'armed', lastSide: null, orderId, fireNote: message, triggeredAt: new Date() }
              : { status: 'triggered', lastSide: ev.side, orderId, fireNote: message, triggeredAt: new Date() },
          })
          fires.push({ id: r.id, symbol, action, qty, ok: true, message, orderId, mode: fireMode })
          await logFire(userId, r, { ok: true, message, orderId })
          await notify(
            `🤖 <b>Strategy Fired</b>${fireMode === 'live' ? ' ⚠️ LIVE' : ''}\n<b>${symbol}</b>\n${message}\nAccount: ${fireMode.toUpperCase()}${fireMode === 'live' ? ' — real money' : ''}\nTime: ${new Date().toUTCString()}`,
          )
          console.log(`[strategy] fired ${action} ${qty} ${symbol} (${r.kind} ${r.condition} ${r.level} ${r.timeframe}) mode=${fireMode} order=${orderId}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        await db.strategyRule.update({
          where: { id: r.id },
          data: { status: 'failed', fireNote: msg },
        }).catch(() => {})
        fires.push({ id: r.id, symbol, action, qty, ok: false, message: `${liveTag}${ev.message} → order FAILED: ${msg}`, mode: fireMode })
        await logFire(userId, r, { ok: false, message: `${liveTag}${ev.message} → order FAILED: ${msg}` })
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
  __ttStrategyIdle?: Map<string, number>
}

// Task 89 — lazy pruning: StrategyFireLog rows (success AND failure, by
// design) accumulated forever with no reader for old rows. Every supervisor
// tick may run this (throttled to 10 min) — keep 30 days of history.
let lastFireLogPruneAt = 0
function maybePruneFireLogs(): void {
  const now = Date.now()
  if (now - lastFireLogPruneAt < 10 * 60_000) return
  lastFireLogPruneAt = now
  db.strategyFireLog
    .deleteMany({ where: { createdAt: { lt: new Date(now - 30 * 86_400_000) } } })
    .catch(() => { /* the pruner must never surface */ })
}

/** Start (once per user+mode) a 20s server-side evaluation cycle. */
export function ensureStrategySupervisor(userId: string, mode: TradeMode): void {
  const g = globalThis as GlobalWithStrategies
  if (!g.__ttStrategySupervised) g.__ttStrategySupervised = new Map()
  if (!g.__ttStrategyIdle) g.__ttStrategyIdle = new Map()
  const key = `${userId}|${mode}`
  if (g.__ttStrategySupervised.has(key)) return
  const idle = g.__ttStrategyIdle!
  const timer = setInterval(() => {
    // Task 89 — teardown: a warmed supervisor used to tick for the LIFE of
    // the process even after every rule was deleted/paused. When the user
    // has no armed rules for 3 consecutive cycles (60s), stop the timer and
    // drop the entry — the next GET/POST warms it again if rules return.
    // Task 94 (review R-1#8) — count per PINNED mode so a timer keyed for an
    // account with zero armed rules (e.g. GET warmed the user's tradeMode
    // while every rule is pinned live) actually tears down instead of
    // ticking forever. Evaluation itself stays mode-agnostic.
    void db.strategyRule.count({ where: { userId, status: 'armed', mode } })
      .then((armed) => {
        if (armed > 0) {
          idle.set(key, 0)
          return
        }
        const n = (idle.get(key) ?? 0) + 1
        idle.set(key, n)
        if (n >= 3) {
          clearInterval(timer)
          g.__ttStrategySupervised!.delete(key)
          idle.delete(key)
          console.log(`[strategy] supervisor stopped for ${key} (no armed rules)`)
        }
      })
      .catch(() => { /* DB hiccup — keep ticking; the eval call below re-checks */ })
    maybePruneFireLogs()
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
