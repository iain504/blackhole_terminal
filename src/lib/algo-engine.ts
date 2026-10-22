// Algo Trading engine (Task 61) — in-process strategy runner.
//
// One timer per AlgoRun (15s cadence). Each cycle:
//   1. re-read the run row (the DB is the single source of truth — config
//      edits, stops and dev-server restarts are all reflected next cycle)
//   2. session gate: RTH-only runs skip entries outside 09:30–16:00 ET and
//      flatten their position near the close (flattenEod)
//   3. evaluate the strategy on the last CLOSED bar (never the forming bar)
//      — a per-run `state.lastBarTime` cursor makes each bar fire at most once
//   4. exits run BEFORE entries; entries require a flat book on the symbol,
//      a fresh day-capacity check (maxTradesDay) and a live quote for % legs
//   5. everything is journaled to AlgoLog (info/signal/trade/error)
//
// Runs survive restarts: ensureAlgoEngines() re-registers every status
// 'running' row the first time any /api/algo route is touched after boot.
// Day accumulators (session VWAP, opening range) only consume TODAY's
// REGULAR-session bars, so engine restarts mid-day rebuild correct state.
import { db } from '@/lib/db'
import { barsFor } from '@/lib/bars-cache'
import { closePositionFull, getPositions, placeOrderWithExits, resolveTradeMode, tradeSymbol, type TradeMode } from '@/lib/trading'
import { ensureCryptoOcoSupervisor } from '@/lib/trading'
import { getQuotes, hasAlpacaKeys } from '@/lib/alpaca'
import { sessionOf, etDateKey, etMinutesOfDay } from '@/lib/sessions'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import { isAlgoStrategyId, normalizeAlgoParams, ALGO_STRATEGIES, type AlgoStrategyId } from '@/lib/algo-strategies'

const CYCLE_MS = 15000
const EOD_FLATTEN_MIN = 15 * 60 + 45 // 15:45 ET — stop entering, flatten
const RTH_START_MIN = 9 * 60 + 30
const HEARTBEAT_MS = 10 * 60000 // one info heartbeat per 10 idle minutes

interface AlgoRunRow {
  id: string
  userId: string
  symbol: string
  timeframe: string
  strategy: string
  params: unknown
  qty: number
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin: number
  requireNewSignal: boolean
  status: string
  state: unknown
}

interface AlgoState {
  lastBarTime?: number
  day?: string // ET date key the counters belong to
  tradesToday?: number
  lastGate?: string // last session-gate note (log transitions only)
  demoNoted?: boolean
  lastBeat?: number // last heartbeat epoch ms
  // session accumulators (reset each ET day, regular-session bars only)
  vwapNum?: number
  vwapDen?: number
  orHigh?: number
  orLow?: number
  orDone?: boolean // opening range captured
  firedLong?: boolean // ORB: entry-per-side memory
  firedShort?: boolean
  // re-entry control (Task 70-c) — persisted so restarts keep the gates
  hadPosition?: boolean // broker position present on the PREVIOUS cycle
  cooldownUntil?: number // epoch ms — no entries before this after a close
  prevLongSignal?: boolean // raw entry signal on the previously processed bar
  prevShortSignal?: boolean
  freshGateSide?: 'buy' | 'sell' // side currently edge-suppressed (log once per episode)
}

interface BarRow { time: number; open: number; high: number; low: number; close: number; volume: number }

/** What the evaluator decided for the last closed bar (entry AND exit can
 *  both be present — the cycle always resolves the exit first). */
interface EvalResult {
  entry: { side: 'buy' | 'sell'; reason: string } | null
  exit: string | null
  note?: string
}

type GlobalWithAlgo = typeof globalThis & {
  __ttAlgoEngines?: Map<string, { busy: boolean; timer: ReturnType<typeof setInterval> }>
}

function registry(): Map<string, { busy: boolean; timer: ReturnType<typeof setInterval> }> {
  const g = globalThis as GlobalWithAlgo
  if (!g.__ttAlgoEngines) g.__ttAlgoEngines = new Map()
  return g.__ttAlgoEngines
}

async function log(runId: string, userId: string, level: 'info' | 'signal' | 'trade' | 'error', message: string) {
  try {
    await db.algoLog.create({ data: { runId, userId, level, message } })
    // journal never grows unbounded — keep the most recent 300 rows per run
    const count = await db.algoLog.count({ where: { runId } })
    if (count > 300) {
      const old = await db.algoLog.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, take: count - 300, select: { id: true } })
      if (old.length > 0) await db.algoLog.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
    }
  } catch (e) {
    console.warn('[algo] log write failed:', e instanceof Error ? e.message : e)
  }
}

const fmtP = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toFixed(4))

/** Market-close the run's position (cancels the symbol's working exit legs
 *  first — Alpaca rejects a position close while exit orders are open).
 *  SAFETY: when the run has NO position this is a strict no-op — it must
 *  never touch bare pending entries on the symbol (they may be the user's
 *  manual brackets; closePositionFull would cancel them). */
async function flattenPosition(userId: string, mode: TradeMode, symbol: string): Promise<{ ok: boolean; note: string }> {
  try {
    const posRes = await getPositions(userId, mode)
    const positions = Array.isArray(posRes.data) ? posRes.data : []
    const tSym = tradeSymbol(symbol)
    const mine = positions.find((p) => p.symbol === tSym || p.symbol === symbol)
    if (!mine || Math.abs(Number(mine.qty)) < 1e-9) return { ok: true, note: '' }
    const r = await closePositionFull(userId, mode, symbol)
    if (r.close.data || r.close.status === 204) {
      return { ok: true, note: r.canceledExits > 0 ? ` · ${r.canceledExits} working exit order(s) canceled` : '' }
    }
    // 404 = no open position (already flat) — nothing to do, not an error
    if (r.close.status === 404 || /position.*not found|does not exist/i.test(r.close.error || '')) {
      return { ok: true, note: '' }
    }
    return { ok: false, note: r.close.error || `HTTP ${r.close.status}` }
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'close failed' }
  }
}

// ---- strategy evaluation ----------------------------------------------------

function evalStrategy(
  strategy: AlgoStrategyId,
  params: Record<string, number>,
  bars: BarRow[],
  st: AlgoState,
): EvalResult {
  const n = bars.length
  if (n < 5) return { entry: null, exit: null }
  const closes = bars.map((b) => b.close)
  const last = bars[n - 1]

  if (strategy === 'bb-reversion') {
    // Bollinger(period, std) + RSI(period) range fade; exit on band-mean reversion
    const period = Math.max(5, Math.round(params.bbPeriod ?? 20))
    const mult = params.bbStd ?? 2
    if (n < period + 2) return { entry: null, exit: null }
    const win = closes.slice(n - period)
    const mean = win.reduce((a, b) => a + b, 0) / period
    const variance = win.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period
    const sd = Math.sqrt(variance)
    const upper = mean + mult * sd
    const lower = mean - mult * sd
    // Wilder-smoothed RSI over the last ~3×period bars
    const rp = Math.max(2, Math.round(params.rsiPeriod ?? 14))
    let rsiVal = 50
    if (n > rp + 1) {
      let g = 0, l = 0
      for (let i = 1; i <= rp; i++) {
        const d = closes[i] - closes[i - 1]
        if (d >= 0) g += d; else l -= d
      }
      let ag = g / rp, al = l / rp
      for (let i = rp + 1; i < n; i++) {
        const d = closes[i] - closes[i - 1]
        ag = (ag * (rp - 1) + Math.max(0, d)) / rp
        al = (al * (rp - 1) + Math.max(0, -d)) / rp
      }
      rsiVal = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
    }
    const allowShort = (params.allowShort ?? 1) >= 1
    const os = params.rsiOversold ?? 30
    const ob = params.rsiOverbought ?? 70
    if (last.close < lower && rsiVal < os) return { entry: { side: 'buy', reason: `close ${fmtP(last.close)} < lower BB ${fmtP(lower)} · RSI(${rp}) ${rsiVal.toFixed(1)}` }, exit: null }
    if (allowShort && last.close > upper && rsiVal > ob) return { entry: { side: 'sell', reason: `close ${fmtP(last.close)} > upper BB ${fmtP(upper)} · RSI(${rp}) ${rsiVal.toFixed(1)}` }, exit: null }
    if (Math.abs(last.close - mean) < sd * 0.25) return { entry: null, exit: `price reverted to band mean ${fmtP(mean)}` }
    return { entry: null, exit: null }
  }

  if (strategy === 'rsi2-connors') {
    // Connors RSI-2: strong-trend dip buy (close > trend SMA AND RSI(2) <
    // buy level) · exit on the short-SMA recapture. Both can be true on the
    // same bar — the cycle resolves exits before entries.
    const trendLen = Math.max(10, Math.round(params.trendSma ?? 200))
    if (n < trendLen + 2) return { entry: null, exit: null }
    const smaT = closes.slice(n - trendLen).reduce((a, b) => a + b, 0) / trendLen
    const rp = Math.max(2, Math.round(params.rsiPeriod ?? 2))
    // RSI over the LAST rp bar-to-bar changes (the classic Connors reading of
    // the most recent closes). NOTE: this used to iterate closes[1..rp] — the
    // OLDEST bars of the rolling window — which made the signal fire on stale
    // data (Task 62 parity fix, mirrored in src/lib/backtest.ts).
    let g = 0, l = 0
    for (let i = n - rp; i < n; i++) {
      const d = closes[i] - closes[i - 1]
      if (d >= 0) g += d; else l -= d
    }
    const rsiVal = l === 0 ? 100 : 100 - 100 / (1 + g / l)
    const exitLen = Math.max(2, Math.round(params.exitSma ?? 5))
    const smaE = closes.slice(n - exitLen).reduce((a, b) => a + b, 0) / exitLen
    const exit = last.close > smaE ? `close > SMA(${exitLen}) ${fmtP(smaE)} (Connors recapture)` : null
    if (last.close > smaT && rsiVal < (params.rsiBuy ?? 10)) {
      return { entry: { side: 'buy', reason: `close > SMA(${trendLen}) ${fmtP(smaT)} · RSI(${rp}) ${rsiVal.toFixed(1)} < ${params.rsiBuy ?? 10}` }, exit }
    }
    return { entry: null, exit }
  }

  if (strategy === 'orb15') {
    // Opening-range breakout — the RANGE ITSELF is captured by the day
    // accumulators (feedAccumulators); here we only react to closes outside
    // it, one entry per side per day.
    if (!st.orDone || st.orHigh == null || st.orLow == null) {
      if (st.orHigh != null && st.orLow != null) return { entry: null, exit: null, note: `opening range forming ${fmtP(st.orLow)}–${fmtP(st.orHigh)}` }
      return { entry: null, exit: null }
    }
    const onePerSide = (params.onePerSide ?? 1) >= 1
    if (last.close > st.orHigh && !(onePerSide && st.firedLong)) {
      return { entry: { side: 'buy', reason: `close ${fmtP(last.close)} broke OR high ${fmtP(st.orHigh)}` }, exit: null }
    }
    if (last.close < st.orLow && !(onePerSide && st.firedShort)) {
      return { entry: { side: 'sell', reason: `close ${fmtP(last.close)} broke OR low ${fmtP(st.orLow)}` }, exit: null }
    }
    return { entry: null, exit: null }
  }

  // vwap-fade
  {
    const devPct = params.devPct ?? 0.6
    const den = st.vwapDen ?? 0
    if (den <= 0) return { entry: null, exit: null }
    const vwap = (st.vwapNum ?? 0) / den
    if (!(vwap > 0)) return { entry: null, exit: null }
    const dev = ((last.close - vwap) / vwap) * 100
    const allowShort = (params.allowShort ?? 1) >= 1
    if (dev <= -devPct) return { entry: { side: 'buy', reason: `${dev.toFixed(2)}% below session VWAP ${fmtP(vwap)}` }, exit: null }
    if (allowShort && dev >= devPct) return { entry: { side: 'sell', reason: `+${dev.toFixed(2)}% above session VWAP ${fmtP(vwap)}` }, exit: null }
    if (Math.abs(dev) < 0.08) return { entry: null, exit: 'price reverted to session VWAP' }
    return { entry: null, exit: null }
  }
}

/** Feed ONE closed bar into the day accumulators (session VWAP + opening
 *  range). Only TODAY's REGULAR-session bars count — restart-safe. */
function feedAccumulators(strategy: AlgoStrategyId, orMinutes: number, bar: BarRow, st: AlgoState, dayKey: string) {
  if (etDateKey(bar.time) !== dayKey) return
  if (sessionOf(bar.time) !== 'regular') return
  const typ = (bar.high + bar.low + bar.close) / 3
  if (strategy === 'vwap-fade') {
    st.vwapNum = (st.vwapNum ?? 0) + typ * bar.volume
    st.vwapDen = (st.vwapDen ?? 0) + bar.volume
  }
  if (strategy === 'orb15' && !st.orDone) {
    const minutes = etMinutesOfDay(bar.time)
    if (minutes >= RTH_START_MIN && minutes < RTH_START_MIN + orMinutes) {
      st.orHigh = st.orHigh == null ? bar.high : Math.max(st.orHigh, bar.high)
      st.orLow = st.orLow == null ? bar.low : Math.min(st.orLow, bar.low)
    } else if (minutes >= RTH_START_MIN + orMinutes && st.orHigh != null && st.orLow != null) {
      st.orDone = true
    }
  }
}

// ---- one engine cycle -------------------------------------------------------

async function cycle(runId: string) {
  const reg = registry()
  const entry = reg.get(runId)
  if (!entry || entry.busy) return
  entry.busy = true
  try {
    const run = (await db.algoRun.findUnique({ where: { id: runId } })) as AlgoRunRow | null
    if (!run || run.status !== 'running') {
      stopEngine(runId)
      return
    }
    if (!isAlgoStrategyId(run.strategy)) {
      await log(runId, run.userId, 'error', `unknown strategy "${run.strategy}" — run halted`)
      await db.algoRun.update({ where: { id: runId }, data: { status: 'stopped', stoppedAt: new Date() } })
      stopEngine(runId)
      return
    }
    const strategy = run.strategy
    const params = normalizeAlgoParams(strategy, run.params)
    const tf = (TIMEFRAMES[run.timeframe as Timeframe] ? run.timeframe : '5m') as Timeframe
    const tfSec = TIMEFRAMES[tf].seconds
    const mode: TradeMode = await resolveTradeMode(run.userId)
    const st = (run.state && typeof run.state === 'object' ? run.state : {}) as AlgoState

    // ---- session gate ----
    const nowMinEt = etMinutesOfDay(Math.floor(Date.now() / 1000))
    const inRth = sessionOf(Math.floor(Date.now() / 1000)) === 'regular'
    const gateNote = run.rthOnly && !inRth ? (nowMinEt < RTH_START_MIN ? 'waiting for the 09:30 ET open' : 'regular session closed — entries paused') : null
    // log session-gate TRANSITIONS only (empty string = no gate)
    const gateKey = gateNote ?? ''
    if (gateKey !== (st.lastGate ?? '')) {
      await log(runId, run.userId, 'info', gateNote ? `Session gate: ${gateNote}` : 'Entries armed (session gate open)')
      st.lastGate = gateKey
    }

    // ---- bars + last CLOSED bar ----
    let bars: BarRow[]
    let demo = false
    try {
      const res = await barsFor(run.symbol, tf, run.userId)
      bars = res.bars as BarRow[]
      demo = res.demo
    } catch {
      await log(runId, run.userId, 'error', 'bar fetch failed this cycle (network/upstream)')
      return
    }
    if (demo || bars.length < 10) {
      if (!st.demoNoted) {
        await log(runId, run.userId, 'error', 'no live bar data (demo/unavailable) — trading disabled until real bars arrive')
        st.demoNoted = true
      }
      await db.algoRun.update({ where: { id: runId }, data: { state: st as unknown as object } })
      return
    }
    st.demoNoted = false
    const nowSec = Math.floor(Date.now() / 1000)
    let lastClosedIdx = -1
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].time + tfSec <= nowSec) { lastClosedIdx = i; break }
    }
    if (lastClosedIdx < 0) return
    const evalBar = bars[lastClosedIdx]

    // ---- new ET day → reset counters / accumulators ----
    const dayKey = etDateKey(evalBar.time)
    if (st.day !== dayKey) {
      st.day = dayKey
      st.tradesToday = 0
      st.vwapNum = 0
      st.vwapDen = 0
      st.orHigh = undefined
      st.orLow = undefined
      st.orDone = false
      st.firedLong = false
      st.firedShort = false
      await log(runId, run.userId, 'info', `New session ${dayKey} — counters reset`)
    }

    // ---- consume any not-yet-fed closed bars into the accumulators ----
    const isNewBar = st.lastBarTime !== evalBar.time
    if (isNewBar) {
      const orMinutes = Math.max(5, Math.round(params.orMinutes ?? 15))
      const fromIdx = Math.max(1, lastClosedIdx - 400)
      for (let i = fromIdx; i <= lastClosedIdx; i++) {
        if (!st.lastBarTime || bars[i].time > (st.lastBarTime as number)) {
          feedAccumulators(strategy, orMinutes, bars[i], st, dayKey)
        }
      }
    }

    // ---- broker position on this symbol ----
    let pos: { side: 'long' | 'short'; qty: number } | null = null
    try {
      const posRes = await getPositions(run.userId, mode)
      const positions = Array.isArray(posRes.data) ? posRes.data : []
      const mine = positions.find((p) => p.symbol === tradeSymbol(run.symbol) || p.symbol === run.symbol)
      const q = mine ? Number(mine.qty) : 0
      if (mine && Math.abs(q) > 1e-9) pos = { side: mine.side === 'short' ? 'short' : 'long', qty: Math.abs(q) }
    } catch { /* positions unavailable — assume flat */ }

    // ---- EOD flatten ----
    if (run.flattenEod && pos && nowMinEt >= EOD_FLATTEN_MIN) {
      const f = await flattenPosition(run.userId, mode, run.symbol)
      if (f.ok) {
        await log(runId, run.userId, 'trade', `EOD flatten — closed ${pos.side} ${pos.qty} ${run.symbol}${f.note}`)
        pos = null
      } else {
        await log(runId, run.userId, 'error', `EOD flatten failed: ${f.note}`)
      }
    }

    // ---- re-entry control (Task 70-c): cooldown after the position closes ----
    // Detect the open→closed transition between cycles (broker position seen
    // last cycle, flat now) and arm the wall-clock gate. Both the gate window
    // and the per-side signal memory live in run.state, so dev-server
    // restarts / hot reloads keep them.
    if (!pos && st.hadPosition && run.cooldownMin > 0) {
      st.cooldownUntil = Date.now() + Math.round(run.cooldownMin) * 60000
      const until = new Date(st.cooldownUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      await log(runId, run.userId, 'info', `Cooldown gate engaged — no entries for ${run.cooldownMin}m after the position close (until ${until})`)
    }
    st.hadPosition = !!pos
    if (st.cooldownUntil && Date.now() >= st.cooldownUntil) {
      await log(runId, run.userId, 'info', 'Cooldown gate released — entries re-armed')
      delete st.cooldownUntil
    }

    // ---- evaluate on the closed bar (once per bar) ----
    if (isNewBar) {
      const closed = bars.slice(0, lastClosedIdx + 1)
      const res = evalStrategy(strategy, params, closed, st)
      if (res.note) await log(runId, run.userId, 'info', res.note)

      // 1) exits first
      if (res.exit && pos) {
        const f = await flattenPosition(run.userId, mode, run.symbol)
        if (f.ok) {
          await log(runId, run.userId, 'trade', `EXIT ${pos.side} ${pos.qty} ${run.symbol} — ${res.exit}${f.note}`)
          pos = null
        } else {
          await log(runId, run.userId, 'error', `Exit failed: ${f.note}`)
        }
      }

      // 2) entries (flat book + gates + day capacity)
      if (res.entry && !pos) {
        // re-entry gates (Task 70-c): wall-clock cooldown + edge-triggered
        // fresh-signal re-entry (fire only on a false→true signal transition
        // vs the previously processed closed bar)
        const cooldownActive = st.cooldownUntil != null && Date.now() < st.cooldownUntil
        const edgeBlocked = run.requireNewSignal && (
          (res.entry.side === 'buy' && st.prevLongSignal === true) ||
          (res.entry.side === 'sell' && st.prevShortSignal === true))
        if (gateNote) {
          await log(runId, run.userId, 'info', `Signal suppressed (session gate): ${res.entry.side.toUpperCase()} — ${res.entry.reason}`)
        } else if (run.flattenEod && nowMinEt >= EOD_FLATTEN_MIN) {
          await log(runId, run.userId, 'info', `Signal suppressed (past 15:45 ET flatten window): ${res.entry.side.toUpperCase()} — ${res.entry.reason}`)
        } else if (cooldownActive) {
          // quiet on purpose — the engage line already announced the window
        } else if (edgeBlocked) {
          // journal ONCE per suppression episode (a held level would otherwise
          // spam one line per bar) — the next genuine edge re-arms the note
          if (st.freshGateSide !== res.entry.side) {
            await log(runId, run.userId, 'info', `Signal suppressed (fresh-signal gate): ${res.entry.side.toUpperCase()} — ${res.entry.reason} · waiting for a new cross`)
            st.freshGateSide = res.entry.side
          }
        } else if ((st.tradesToday ?? 0) >= run.maxTradesDay) {
          await log(runId, run.userId, 'info', `Signal suppressed (daily cap ${run.maxTradesDay}): ${res.entry.side.toUpperCase()} — ${res.entry.reason}`)
        } else {
          await log(runId, run.userId, 'signal', `${res.entry.side.toUpperCase()} signal — ${res.entry.reason}`)
          // resolve % legs against the live quote
          let ref: number | null = null
          if (run.tpMode === 'pct' || run.slMode === 'pct') {
            try {
              const { quotes } = await getQuotes([run.symbol], run.userId)
              ref = quotes.find((q) => q.symbol === run.symbol)?.price ?? null
            } catch { ref = null }
            if (ref == null) await log(runId, run.userId, 'error', 'No live quote for % TP/SL — entering without bracket legs')
          }
          const pctPx = (m: string, v: number | null, kind: 'tp' | 'sl'): number | undefined => {
            if (m !== 'pct' || v == null || ref == null || ref <= 0) return undefined
            const p = Math.min(100, Math.max(0.01, Math.abs(v)))
            const profitSide = kind === 'tp' ? res.entry!.side === 'buy' : res.entry!.side === 'sell'
            const px = profitSide ? ref * (1 + p / 100) : ref * (1 - p / 100)
            return px > 0 ? px : undefined
          }
          const tp = pctPx(run.tpMode, run.tpValue, 'tp')
          const sl = pctPx(run.slMode, run.slValue, 'sl')
          const qty = run.symbol.includes('/') ? run.qty : Math.floor(run.qty)
          if (qty <= 0) {
            await log(runId, run.userId, 'error', 'qty rounds to 0 — fix the run quantity')
          } else {
            try {
              // crypto entries carry their TP/SL plan in the client_order_id —
              // keep the OCO supervisor alive so the legs attach on fill
              if (run.symbol.includes('/')) ensureCryptoOcoSupervisor(run.userId, mode)
              const r = await placeOrderWithExits(run.userId, mode, {
                symbol: run.symbol, side: res.entry.side, qty, type: 'market', take_profit: tp, stop_loss: sl,
                // tag the entry with the run id prefix — the trade history /
                // report decode it to attribute Manual vs Algo (which strategy)
                sourceRef: run.id.slice(0, 8),
              })
              if (r.results.length === 0) {
                await log(runId, run.userId, 'error', `Order FAILED: ${r.errors[0] || 'rejected'}`)
              } else {
                st.tradesToday = (st.tradesToday ?? 0) + 1
                if (strategy === 'orb15') {
                  // ORB one-per-side memory — mark the side as fired for this
                  // ET day (was never set before Task 62; mirrored in backtest.ts)
                  if (res.entry.side === 'buy') st.firedLong = true
                  else st.firedShort = true
                }
                const legs = [tp ? `TP ${fmtP(tp)}` : null, sl ? `SL ${fmtP(sl)}` : null].filter(Boolean).join(' · ')
                await log(runId, run.userId, 'trade', `ENTRY ${res.entry.side.toUpperCase()} ${qty} ${run.symbol} @ mkt${legs ? ` · ${legs}` : ''} · #${r.results[0].id.slice(-8)} · trade ${st.tradesToday}/${run.maxTradesDay} today`)
                st.freshGateSide = undefined // fired — a new episode starts after this
                // never swallow leg problems — a crypto OCO attach failure or
                // a split (attach-on-fill) plan used to be invisible here,
                // making "SL configured but missing on the position" undiagnosable
                if (r.errors.length) await log(runId, run.userId, 'error', `Exit-leg warning: ${r.errors.join('; ')}`)
                if (r.splitNote) await log(runId, run.userId, 'info', r.splitNote)
                console.log(`[algo] user=${run.userId} ENTRY ${res.entry.side.toUpperCase()} ${qty} ${run.symbol} — ${res.entry.reason}`)
              }
            } catch (e) {
              await log(runId, run.userId, 'error', `Order error: ${e instanceof Error ? e.message : e}`)
            }
          }
        }
      }
      // per-side signal memory — updated on EVERY newly processed bar
      // (regardless of gates/outcomes) so the fresh-signal edge trigger only
      // fires on a genuine false→true transition
      st.prevLongSignal = res.entry?.side === 'buy'
      st.prevShortSignal = res.entry?.side === 'sell'
      if (!res.entry) st.freshGateSide = undefined // signal ended — re-arm the note
      st.lastBarTime = evalBar.time
    } else if (!st.lastBeat || Date.now() - st.lastBeat > HEARTBEAT_MS) {
      // idle heartbeat
      st.lastBeat = Date.now()
      await log(runId, run.userId, 'info', `Heartbeat — ${strategy} · ${run.symbol} ${tf} · ${pos ? `${pos.side} ${pos.qty}` : 'flat'} · trades today ${st.tradesToday ?? 0}/${run.maxTradesDay}`)
    }

    await db.algoRun.update({ where: { id: runId }, data: { state: st as unknown as object } })
  } catch (e) {
    console.warn('[algo] cycle failed:', e instanceof Error ? e.message : e)
    try {
      const run = await db.algoRun.findUnique({ where: { id: runId }, select: { userId: true } })
      if (run) await log(runId, run.userId, 'error', `cycle error: ${e instanceof Error ? e.message : e}`)
    } catch { /* run gone */ }
  } finally {
    const ent = registry().get(runId)
    if (ent) ent.busy = false
  }
}

// ---- lifecycle ---------------------------------------------------------------

function startEngine(runId: string) {
  const reg = registry()
  if (reg.has(runId)) return
  const timer = setInterval(() => void cycle(runId), CYCLE_MS)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
  reg.set(runId, { busy: false, timer })
  void cycle(runId) // first pass right away
  console.log(`[algo] engine started for run ${runId} (every ${CYCLE_MS / 1000}s)`)
}

export function stopEngine(runId: string) {
  const ent = registry().get(runId)
  if (!ent) return
  clearInterval(ent.timer)
  registry().delete(runId)
  console.log(`[algo] engine stopped for run ${runId}`)
}

/** Create + start a run. */
export async function startAlgoRun(cfg: {
  userId: string
  symbol: string
  timeframe: string
  strategy: AlgoStrategyId
  params: unknown
  qty: number
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin: number
  requireNewSignal: boolean
}) {
  const run = await db.algoRun.create({
    data: {
      userId: cfg.userId,
      symbol: cfg.symbol,
      timeframe: cfg.timeframe,
      strategy: cfg.strategy,
      params: normalizeAlgoParams(cfg.strategy, cfg.params) as unknown as object,
      qty: cfg.qty,
      tpMode: cfg.tpMode,
      tpValue: cfg.tpValue,
      slMode: cfg.slMode,
      slValue: cfg.slValue,
      maxTradesDay: cfg.maxTradesDay,
      rthOnly: cfg.rthOnly,
      flattenEod: cfg.flattenEod,
      cooldownMin: cfg.cooldownMin,
      requireNewSignal: cfg.requireNewSignal,
      status: 'running',
      state: {} as unknown as object,
    },
  })
  await log(run.id, cfg.userId, 'info', `Run started — ${ALGO_STRATEGIES[cfg.strategy].name} · ${cfg.symbol} ${cfg.timeframe} · qty ${cfg.qty}${cfg.rthOnly ? ' · RTH only' : ''}${cfg.flattenEod ? ' · EOD flatten' : ''}${cfg.cooldownMin > 0 ? ` · cooldown ${cfg.cooldownMin}m` : ''}${cfg.requireNewSignal ? ' · fresh-signal re-entry' : ''}`)
  startEngine(run.id)
  return run
}

/** Edit an existing run's settings (Task 71-1). The engine re-reads the run
 *  row every cycle ("the DB is the single source of truth"), so a RUNNING run
 *  picks the new settings up on its next ≤15s tick — no restart needed.
 *  Changing the instrument or strategy wipes the session memory (opening
 *  range, VWAP accumulators, per-side signal edges) so the next cycle starts
 *  clean; tradesToday/cooldown persist (same run, same day). The % bracket of
 *  an ALREADY-OPEN position is broker state and is NOT retroactively replaced.
 *  Returns the updated row, or null when the run is gone. */
export interface AlgoRunConfigPatch {
  symbol: string
  timeframe: string
  strategy: AlgoStrategyId
  params: unknown
  qty: number
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin: number
  requireNewSignal: boolean
}

export async function updateAlgoRunConfig(runId: string, patch: AlgoRunConfigPatch) {
  const run = await db.algoRun.findUnique({ where: { id: runId } })
  if (!run) return null
  const prevParams = normalizeAlgoParams(isAlgoStrategyId(run.strategy) ? run.strategy : 'bb-reversion', run.params)
  const nextParams = normalizeAlgoParams(patch.strategy, patch.params)
  const identityChanged = run.symbol !== patch.symbol || run.timeframe !== patch.timeframe || run.strategy !== patch.strategy

  const st = (run.state && typeof run.state === 'object' ? run.state : {}) as AlgoState
  if (identityChanged) {
    // instrument/strategy switch → forget session memory + signal edges so
    // the next cycle starts clean on the new instrument/strategy
    delete st.lastBarTime
    st.vwapNum = 0
    st.vwapDen = 0
    st.orHigh = undefined
    st.orLow = undefined
    st.orDone = false
    st.firedLong = false
    st.firedShort = false
    st.prevLongSignal = false
    st.prevShortSignal = false
    st.freshGateSide = undefined
    st.lastGate = undefined
  }

  // one journal line describing the edit (old → new per changed field)
  const diffs: string[] = []
  if (run.symbol !== patch.symbol) diffs.push(`symbol ${run.symbol} → ${patch.symbol}`)
  if (run.timeframe !== patch.timeframe) diffs.push(`timeframe ${run.timeframe} → ${patch.timeframe}`)
  if (run.strategy !== patch.strategy) diffs.push(`strategy ${run.strategy} → ${patch.strategy}`)
  if (run.qty !== patch.qty) diffs.push(`qty ${run.qty} → ${patch.qty}`)
  if (run.tpMode !== patch.tpMode || (patch.tpMode === 'pct' && run.tpValue !== patch.tpValue)) {
    diffs.push(`TP ${run.tpMode === 'pct' ? `${run.tpValue}%` : 'off'} → ${patch.tpMode === 'pct' ? `${patch.tpValue}%` : 'off'}`)
  }
  if (run.slMode !== patch.slMode || (patch.slMode === 'pct' && run.slValue !== patch.slValue)) {
    diffs.push(`SL ${run.slMode === 'pct' ? `${run.slValue}%` : 'off'} → ${patch.slMode === 'pct' ? `${patch.slValue}%` : 'off'}`)
  }
  if (run.maxTradesDay !== patch.maxTradesDay) diffs.push(`max trades/day ${run.maxTradesDay} → ${patch.maxTradesDay}`)
  if (run.rthOnly !== patch.rthOnly) diffs.push(`RTH only ${run.rthOnly ? 'ON' : 'OFF'} → ${patch.rthOnly ? 'ON' : 'OFF'}`)
  if (run.flattenEod !== patch.flattenEod) diffs.push(`EOD flatten ${run.flattenEod ? 'ON' : 'OFF'} → ${patch.flattenEod ? 'ON' : 'OFF'}`)
  if (run.cooldownMin !== patch.cooldownMin) diffs.push(`cooldown ${run.cooldownMin}m → ${patch.cooldownMin}m`)
  if (run.requireNewSignal !== patch.requireNewSignal) diffs.push(`fresh-signal ${run.requireNewSignal ? 'ON' : 'OFF'} → ${patch.requireNewSignal ? 'ON' : 'OFF'}`)
  for (const k of Object.keys(nextParams)) {
    if (prevParams[k] !== nextParams[k]) diffs.push(`${k} ${prevParams[k]} → ${nextParams[k]}`)
  }

  const updated = await db.algoRun.update({
    where: { id: runId },
    data: {
      symbol: patch.symbol,
      timeframe: patch.timeframe,
      strategy: patch.strategy,
      params: nextParams as unknown as object,
      qty: patch.qty,
      tpMode: patch.tpMode,
      tpValue: patch.tpMode === 'pct' ? patch.tpValue : null,
      slMode: patch.slMode,
      slValue: patch.slMode === 'pct' ? patch.slValue : null,
      maxTradesDay: patch.maxTradesDay,
      rthOnly: patch.rthOnly,
      flattenEod: patch.flattenEod,
      cooldownMin: patch.cooldownMin,
      requireNewSignal: patch.requireNewSignal,
      state: st as unknown as object,
    },
  })
  await log(runId, run.userId, 'info', diffs.length > 0 ? `Settings updated — ${diffs.join(' · ')}` : 'Settings saved (no changes)')
  return updated
}

/** Restart an existing stopped run. */
export async function resumeAlgoRun(runId: string) {
  const run = await db.algoRun.findUnique({ where: { id: runId } })
  await db.algoRun.update({ where: { id: runId }, data: { status: 'running', stoppedAt: null } })
  if (run) await log(runId, run.userId, 'info', 'Run restarted')
  startEngine(runId)
}

/** Stop a run (optionally flatten its position first). */
export async function stopAlgoRun(runId: string, flatten: boolean) {
  const run = await db.algoRun.findUnique({ where: { id: runId } })
  if (!run) return null
  if (flatten) {
    const f = await flattenPosition(run.userId, await resolveTradeMode(run.userId), run.symbol)
    if (f.ok) {
      await log(runId, run.userId, 'trade', `Flatten on stop — closed ${run.symbol}${f.note}`)
    } else {
      await log(runId, run.userId, 'error', `Flatten on stop failed: ${f.note}`)
    }
  }
  await db.algoRun.update({ where: { id: runId }, data: { status: 'stopped', stoppedAt: new Date() } })
  stopEngine(runId)
  await log(runId, run.userId, 'info', 'Run stopped')
  return run
}

/** Delete a run and its logs. */
export async function deleteAlgoRun(runId: string) {
  stopEngine(runId)
  await db.algoLog.deleteMany({ where: { runId } })
  await db.algoRun.delete({ where: { id: runId } }).catch(() => { /* already gone */ })
}

/**
 * Re-register every status 'running' row for the user — called by the API
 * routes so engines survive dev-server restarts / deploys.
 */
export async function ensureAlgoEngines(userId: string) {
  const runs = await db.algoRun.findMany({ where: { userId, status: 'running' }, select: { id: true } })
  for (const r of runs) startEngine(r.id)
}
