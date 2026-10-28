// Algo Trading engine (Task 61) — in-process strategy runner.
//
// One timer per AlgoRun (15s cadence). Each cycle:
//   1. re-read the run row (the DB is the single source of truth — config
//      edits, stops and dev-server restarts are all reflected next cycle)
//   2. session gate: RTH-only EQUITY runs skip entries outside 09:30–16:00 ET
//      and flatten near the close (flattenEod); crypto runs ("BTC/USD")
//      ignore both guards and trade 24/7 on their 24/7 data feed
//   3. evaluate the strategy on the last CLOSED bar (never the forming bar)
//      — a per-run `state.lastBarTime` cursor makes each bar fire at most once
//   4. exits run BEFORE entries; entries require a flat book on the symbol,
//      a fresh day-capacity check (maxTradesDay) and a live quote for % legs
//   5. everything is journaled to AlgoLog (info/signal/trade/error)
//
// Runs survive restarts: ensureAlgoEngines() re-registers every status
// 'running' row the first time any /api/algo route is touched after boot.
// Day accumulators (session VWAP, opening range) only consume TODAY's bars
// (regular-session for equities, all bars for crypto), so engine restarts
// mid-day rebuild correct state.
import { db } from '@/lib/db'
import { barsFor } from '@/lib/bars-cache'
import { closePositionFull, getAccount, getPositions, placeOrderWithExits, tradeSymbol, type TradeMode } from '@/lib/trading'
import { ensureCryptoOcoSupervisor } from '@/lib/trading'
import { getQuotes, hasAlpacaKeys } from '@/lib/alpaca'
import { sessionOf, etDateKey, etMinutesOfDay, RTH_START_MIN } from '@/lib/sessions'
import { TIMEFRAMES, type Timeframe } from '@/lib/market-types'
import { isAlgoStrategyId, normalizeAlgoParams, ALGO_STRATEGIES, riskBudgetUsd, riskMoneyLabel, riskSizedQty, type AlgoStrategyId } from '@/lib/algo-strategies'
import {
  adxSeries,
  cutlerRsiAt,
  halfLifeSeries,
  regimeCfgFromParams,
  regimeVeto,
  anyRegimeActive,
  REGIME_TREND_SMA,
  ADX_PERIOD,
  HL_LOOKBACK,
  HL_SMA_PERIOD,
} from '@/lib/algo-regime'

const CYCLE_MS = 15000
const EOD_FLATTEN_MIN = 15 * 60 + 45 // 15:45 ET — stop entering, flatten
const HEARTBEAT_MS = 10 * 60000 // one info heartbeat per 10 idle minutes

// Task 89 — the PINNED trade mode of a run row (legacy rows default to
// 'paper' — algos always refused to start in live mode). A run orders against
// THIS account forever; the user's Settings → tradeMode flip never migrates it.
const runModeOf = (m: string | null | undefined): TradeMode => (m === 'live' ? 'live' : 'paper')

/** Task 89 — running-run cap per user: each run is a 15s engine cycle issuing
 * bars/positions/quotes calls + SQLite state writes; unbounded runs would
 * churn the Alpaca rate budget for no benefit. */
export const ALGO_MAX_RUNNING_RUNS = 20

interface AlgoRunRow {
  id: string
  userId: string
  symbol: string
  timeframe: string
  strategy: string
  mode?: string | null
  params: unknown
  qty: number
  // Task 78 — Risk Money sizing ('fixed' legacy · 'risk' derives qty at entry).
  // Task 78e — riskBasis 'usd' = riskMoney $/trade · 'pct' = riskMoneyPct of
  // account equity per trade (resolved at entry from the broker account).
  sizingMode: string
  riskBasis: string
  riskMoney: number | null
  riskMoneyPct: number | null
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
  cryptoNoted?: boolean // one-time "crypto runs 24/7, session guards ignored" journal line
  lastBeat?: number // last heartbeat epoch ms
  identity?: string // Task 89 — symbol|tf|strategy the session memory belongs to
  posUnknownNoted?: boolean // Task 89 — one-time fail-closed journal line
  entrySuppressedNoted?: boolean // Task 89 — one-time per-episode suppression journal
  lastFedBarTime?: number // Task 89 — accumulators consumed through this bar (price data, always advances)
  // session accumulators (reset each ET day, regular-session bars only)
  vwapNum?: number
  vwapDen?: number
  orHigh?: number
  orLow?: number
  orDone?: boolean // opening range captured
  firedLong?: boolean // ORB: entry-per-side memory
  firedShort?: boolean
  orVolSum?: number // Task 12 — OR volume accumulator (breakout participation filter)
  orVolN?: number
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

// Raw strategy logic — entries/exits ONLY from the strategy's own rules.
// evalStrategy() wraps this with the Task 12 regime gates so the vetoes can
// never drift between the backtest (backtest.ts decide()) and live.
function evalRaw(
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
    const cumMode = (params.cumMode ?? 0) >= 1
    let rsiVal: number
    let rsiLabel: string
    if (cumMode) {
      // Review P2 #8 — cumulative RSI (Connors' later refinement): sum K
      // consecutive RSI(rp) readings and require the SUM below cumBuy.
      // Same shared cutlerRsiAt the backtest reads — parity is one function,
      // not two hand-copied loops. Deepest read needs closes[j−rp], j ≥ n−K.
      const kBars = Math.max(2, Math.min(5, Math.round(params.cumBars ?? 2)))
      if (n < rp + kBars) return { entry: null, exit: null }
      let sum = 0
      for (let j = n - kBars; j < n; j++) sum += cutlerRsiAt(closes, j, rp)
      rsiVal = sum
      rsiLabel = `cumRSI(${rp}×${kBars}) ${sum.toFixed(1)}`
    } else {
      // RSI over the LAST rp bar-to-bar changes (the classic Connors reading
      // of the most recent closes). NOTE: this used to iterate closes[1..rp]
      // — the OLDEST bars of the rolling window — which made the signal fire
      // on stale data (Task 62 parity fix, mirrored in src/lib/backtest.ts);
      // it now reads the SAME shared cutlerRsiAt the backtest uses.
      rsiVal = cutlerRsiAt(closes, n - 1, rp)
      rsiLabel = `RSI(${rp}) ${rsiVal.toFixed(1)}`
    }
    const exitLen = Math.max(2, Math.round(params.exitSma ?? 5))
    const smaE = closes.slice(n - exitLen).reduce((a, b) => a + b, 0) / exitLen
    const exit = last.close > smaE ? `close > SMA(${exitLen}) ${fmtP(smaE)} (Connors recapture)` : null
    const buyLevel = cumMode ? (params.cumBuy ?? 35) : (params.rsiBuy ?? 10)
    if (last.close > smaT && rsiVal < buyLevel) {
      return { entry: { side: 'buy', reason: `close > SMA(${trendLen}) ${fmtP(smaT)} · ${rsiLabel} < ${buyLevel}` }, exit }
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

/**
 * Live evaluator — raw strategy rules + the Task 12 quality gates. Must stay
 * PURE (no I/O) so the backtest engine can diff its own decide() against it
 * (parity probes). Gates (improvement plan upload/algo_improvement.txt):
 *   • P2 ORB participation filter — breakout bar volume ≥ × the opening-range
 *     average (0 = off; no OR volume yet → fail-open);
 *   • P0 regime trend gate — LONG only above the 200-SMA, SHORT only below;
 *   • P0 ADX chop gate — mean-reversion entries only while ADX < adxMax;
 *   • P1 half-life gate — entries only while the deviation reverts fast
 *     enough (rolling OU fit). NaN inputs fail OPEN — a thin bar window must
 *     never freeze a live strategy.
 * Exits are NEVER gated — the regime veto only suppresses fresh entries.
 */
export function evalStrategy(
  strategy: AlgoStrategyId,
  params: Record<string, number>,
  bars: BarRow[],
  st: AlgoState,
): EvalResult {
  const out = evalRaw(strategy, params, bars, st)
  if (out.entry == null) return out
  // ---- ORB volume participation filter (P2) ----
  if (strategy === 'orb15') {
    const volMult = params.orbVolMult ?? 0
    const volSum = st.orVolSum ?? 0
    const volN = st.orVolN ?? 0
    if (volMult > 0 && volN > 0 && volSum > 0) {
      const avg = volSum / volN
      if (avg > 0 && bars[bars.length - 1].volume < volMult * avg) {
        return { entry: null, exit: out.exit }
      }
    }
  }
  // ---- regime gates (P0 trend / P0 ADX / P1 half-life) ----
  const regCfg = regimeCfgFromParams(params)
  if (!anyRegimeActive(regCfg)) return out
  const n = bars.length
  const closes = bars.map((b) => b.close)
  const trendSma = regCfg.regimeTrend
    ? (n >= REGIME_TREND_SMA
        ? closes.slice(n - REGIME_TREND_SMA).reduce((a, b) => a + b, 0) / REGIME_TREND_SMA
        : null) // insufficient history → fail-open (same rule as the backtest)
    : null
  const adxLast = regCfg.regimeAdx ? adxSeries(bars, ADX_PERIOD)[n - 1] : Number.NaN
  const hlLast = regCfg.hlGate ? halfLifeSeries(closes, HL_LOOKBACK, HL_SMA_PERIOD)[n - 1] : Number.NaN
  const veto = regimeVeto(regCfg, out.entry.side, closes[n - 1], trendSma, adxLast, hlLast)
  if (veto != null) return { entry: null, exit: out.exit }
  return out
}

/** Feed ONE closed bar into the day accumulators (session VWAP + opening
 *  range). Equity symbols: only TODAY's REGULAR-session bars count —
 *  restart-safe. Crypto symbols: ALL bars of the ET day count (crypto trades
 *  24/7 — "session VWAP" is the running VWAP since ET midnight and the
 *  opening range is the first orMinutes after ET midnight), otherwise the
 *  accumulators would starve overnight and the strategy could never fire
 *  outside 09:30–16:00 ET. */
function feedAccumulators(strategy: AlgoStrategyId, orMinutes: number, bar: BarRow, st: AlgoState, dayKey: string, isCrypto: boolean) {
  if (etDateKey(bar.time) !== dayKey) return
  if (!isCrypto && sessionOf(bar.time) !== 'regular') return
  const typ = (bar.high + bar.low + bar.close) / 3
  if (strategy === 'vwap-fade') {
    st.vwapNum = (st.vwapNum ?? 0) + typ * bar.volume
    st.vwapDen = (st.vwapDen ?? 0) + bar.volume
  }
  if (strategy === 'orb15' && !st.orDone) {
    const minutes = etMinutesOfDay(bar.time)
    // OR window anchor: equities → 09:30 ET open; crypto → ET midnight (the
    // day's first bars — there is no "opening bell" in a 24/7 market)
    const orAnchor = isCrypto ? 0 : RTH_START_MIN
    if (minutes >= orAnchor && minutes < orAnchor + orMinutes) {
      st.orHigh = st.orHigh == null ? bar.high : Math.max(st.orHigh, bar.high)
      st.orLow = st.orLow == null ? bar.low : Math.min(st.orLow, bar.low)
      // Task 12 — OR volume average for the breakout participation filter
      // (mirrors the backtest's orVolSum/orVolN accumulators)
      st.orVolSum = (st.orVolSum ?? 0) + bar.volume
      st.orVolN = (st.orVolN ?? 0) + 1
    } else if (minutes >= orAnchor + orMinutes && st.orHigh != null && st.orLow != null) {
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
    // Task 89 — PINNED mode (was resolveTradeMode at every cycle: flipping
    // Settings → tradeMode mid-run used to silently migrate a paper-tuned
    // algo onto the live account, bypassing the live-mode start refusals).
    const mode: TradeMode = runModeOf(run.mode)
    const st = (run.state && typeof run.state === 'object' ? run.state : {}) as AlgoState

    // Task 89 — identity clobber guard: updateAlgoRunConfig wipes the session
    // memory when symbol/tf/strategy change, but an IN-FLIGHT cycle used to
    // write its stale state copy AFTER the wipe, resurrecting the OLD
    // instrument's ORB/VWAP accumulators on the new symbol. The cycle now
    // re-wipes on any identity mismatch, so whichever write lands last is
    // always consistent with the CURRENT config.
    const identity = `${run.symbol}|${tf}|${run.strategy}`
    if (st.identity != null && st.identity !== identity) {
      delete st.lastBarTime
      delete st.lastFedBarTime
      st.entrySuppressedNoted = false
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
      await log(runId, run.userId, 'info', `Instrument/strategy changed (${st.identity} → ${identity}) — session memory wiped`)
    }
    st.identity = identity

    // ---- session gate ----
    // Crypto symbols (contain '/') trade 24/7 on Binance data — the equity
    // session guards (RTH-only entries, 15:45 ET flatten) are stock-market
    // concepts and are IGNORED for them, whatever the stored flags say, so a
    // crypto algo genuinely runs around the clock, weekends included.
    const isCrypto = run.symbol.includes('/')
    if (isCrypto && (run.rthOnly || run.flattenEod) && !st.cryptoNoted) {
      await log(runId, run.userId, 'info', `Crypto symbol — equity session guards (RTH-only / EOD flatten) ignored — this run trades 24/7`)
      st.cryptoNoted = true
    }
    const rthGateActive = run.rthOnly && !isCrypto
    const eodActive = run.flattenEod && !isCrypto
    const nowMinEt = etMinutesOfDay(Math.floor(Date.now() / 1000))
    const inRth = sessionOf(Math.floor(Date.now() / 1000)) === 'regular'
    const gateNote = rthGateActive && !inRth ? (nowMinEt < RTH_START_MIN ? 'waiting for the 09:30 ET open' : 'regular session closed — entries paused') : null
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
      st.orVolSum = 0
      st.orVolN = 0
      await log(runId, run.userId, 'info', `New session ${dayKey} — counters reset`)
    }

    // ---- consume not-yet-fed closed bars into the accumulators ----
    // Task 89 — IN BAR ORDER (future-contamination fix): the old loop fed
    // ALL unconsumed bars — including the 30-bar replay window — BEFORE the
    // replay evaluated, so a replayed bar i was judged against a VWAP/OR that
    // already contained bars i+1..lastClosedIdx (vwap-fade's |dev| exit could
    // fire or not fire wrongly after downtime). Bars BEFORE the replay window
    // feed here; the replay loop and the main eval feed their own bars
    // just-in-time, exactly like the backtest's per-bar order.
    const isNewBar = st.lastBarTime !== evalBar.time
    const orMinutes = Math.max(5, Math.round(params.orMinutes ?? 15))
    const replayFrom = Math.max(0, lastClosedIdx - 30)
    if (isNewBar) {
      // Task 89 — feed guard runs on lastFedBarTime (accumulators), NOT
      // lastBarTime (decisions): during a posUnknown episode the decision
      // marker lags (exits re-evaluated) while the price accumulators keep
      // consuming — without the split the replay would double-feed bars.
      const fromIdx = Math.max(1, lastClosedIdx - 400)
      for (let i = fromIdx; i < replayFrom; i++) {
        if (!st.lastFedBarTime || bars[i].time > (st.lastFedBarTime as number)) {
          feedAccumulators(strategy, orMinutes, bars[i], st, dayKey, isCrypto)
        }
      }
    }

    // ---- broker position on this symbol ----
    // Task 89 — FAIL CLOSED on broker-data failure: an exception or a non-OK
    // body used to be read as "no position" (assume flat), so an entry in
    // that cycle could STACK a second position the engine can't see, and a
    // strategy exit on that bar was silently skipped and never retried.
    // posUnknown now suppresses entries for the cycle and keeps the bar
    // UNCONSUMED (the exit re-evaluates on the next cycle, like the backtest).
    let pos: { side: 'long' | 'short'; qty: number } | null = null
    let posUnknown = false
    try {
      const posRes = await getPositions(run.userId, mode)
      const positions = Array.isArray(posRes.data) ? posRes.data : []
      if (!Array.isArray(posRes.data) && posRes.error) throw new Error(posRes.error)
      const mine = positions.find((p) => p.symbol === tradeSymbol(run.symbol) || p.symbol === run.symbol)
      const q = mine ? Number(mine.qty) : 0
      if (mine && Math.abs(q) > 1e-9) pos = { side: mine.side === 'short' ? 'short' : 'long', qty: Math.abs(q) }
      posUnknown = false
    } catch {
      posUnknown = true
      if (!st.posUnknownNoted) {
        await log(runId, run.userId, 'error', 'Broker positions unavailable this cycle — entries suppressed, exits re-checked next cycle (fail-closed)')
        st.posUnknownNoted = true
      }
    }
    if (!posUnknown) st.posUnknownNoted = false

    // ---- EOD flatten (equity symbols only — crypto never force-flattens) ----
    if (eodActive && pos && nowMinEt >= EOD_FLATTEN_MIN) {
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
    // last cycle, flat now) and arm the wall-clock gate. Anchored at the eval
    // bar's CLOSE (like the backtest, which anchors at the closing bar's
    // close) rather than raw detection time — Task 84 parity. Both the gate
    // window and the per-side signal memory live in run.state, so dev-server
    // restarts / hot reloads keep them.
    // Task 89 — a posUnknown cycle is NOT a close: don't arm the re-entry
    // cooldown on a book we couldn't see, and don't clear hadPosition
    if (!posUnknown && !pos && st.hadPosition && run.cooldownMin > 0) {
      st.cooldownUntil = (evalBar.time + tfSec) * 1000 + Math.round(run.cooldownMin) * 60000
      const until = new Date(st.cooldownUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      await log(runId, run.userId, 'info', `Cooldown gate engaged — no entries for ${run.cooldownMin}m after the position close (until ${until})`)
    }
    st.hadPosition = posUnknown ? st.hadPosition : !!pos
    if (st.cooldownUntil && Date.now() >= st.cooldownUntil) {
      await log(runId, run.userId, 'info', 'Cooldown gate released — entries re-armed')
      delete st.cooldownUntil
    }

    // ---- evaluate on the closed bar (once per bar) ----
    if (isNewBar) {
      // ---- missed-bar replay (Task 84 backtest-parity) ----
      // The engine only decides while the process is cycling; bars that closed
      // during downtime (restart, hot reload, feed gap) used to be SKIPPED for
      // decisions — a strategy exit firing on a missed bar left the position
      // open until the exit condition happened to repeat, which the backtest
      // (that evaluates every bar) shows as a clean exit. Replay unseen bars
      // oldest→newest (capped): EXITS execute immediately (late, at market —
      // logged as such); entries stay suppressed (stale price). The per-side
      // signal memory is refreshed per replayed bar so the fresh-signal edge
      // gate stays honest.
      const missedFrom = replayFrom
      for (let i = missedFrom; i < lastClosedIdx; i++) {
        if (st.lastBarTime && bars[i].time <= st.lastBarTime) continue
        // Task 89 — feed this bar's accumulators JUST IN TIME (before its own
        // eval, and only if not already fed on a previous cycle) so a replayed
        // bar is never judged against future bars nor double-counted
        if (!st.lastFedBarTime || bars[i].time > (st.lastFedBarTime as number)) {
          feedAccumulators(strategy, orMinutes, bars[i], st, dayKey, isCrypto)
        }
        const r = evalStrategy(strategy, params, bars.slice(0, i + 1), st)
        if (r.exit && pos) {
          const f = await flattenPosition(run.userId, mode, run.symbol)
          if (f.ok) {
            await log(runId, run.userId, 'trade', `EXIT ${pos.side} ${pos.qty} ${run.symbol} — ${r.exit} · replayed missed bar ${new Date(bars[i].time * 1000).toISOString().slice(5, 16).replace('T', ' ')} UTC (executed late — bar closed during downtime)`)
            pos = null
          } else {
            await log(runId, run.userId, 'error', `Replayed exit failed: ${f.note}`)
          }
        }
        if (r.entry && !pos) {
          await log(runId, run.userId, 'info', `Entry signal on a missed bar suppressed (stale price): ${r.entry.side.toUpperCase()} — ${r.entry.reason}`)
        }
        st.prevLongSignal = r.entry?.side === 'buy'
        st.prevShortSignal = r.entry?.side === 'sell'
      }

      // Task 89 — the eval bar itself feeds last (just-in-time, only when
      // genuinely unfed — the replay loop fed everything before it)
      if (!st.lastFedBarTime || bars[lastClosedIdx].time > (st.lastFedBarTime as number)) {
        feedAccumulators(strategy, orMinutes, bars[lastClosedIdx], st, dayKey, isCrypto)
      }

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
      // Task 89 — fail-closed: when the broker book is UNKNOWN, the engine
      // must never ADD exposure on top of a position it cannot see (the old
      // assume-flat path stacked a second invisible position).
      if (res.entry && posUnknown) {
        if (!st.entrySuppressedNoted) {
          await log(runId, run.userId, 'error', `Entry signal suppressed — broker positions unavailable (fail-closed; no new exposure while the book is unknown): ${res.entry.side.toUpperCase()} — ${res.entry.reason}`)
          st.entrySuppressedNoted = true
        }
      } else if (res.entry && !pos) {
        st.entrySuppressedNoted = false
        // re-entry gates (Task 70-c): wall-clock cooldown + edge-triggered
        // fresh-signal re-entry (fire only on a false→true signal transition
        // vs the previously processed closed bar)
        const cooldownActive = st.cooldownUntil != null && Date.now() < st.cooldownUntil
        const edgeBlocked = run.requireNewSignal && (
          (res.entry.side === 'buy' && st.prevLongSignal === true) ||
          (res.entry.side === 'sell' && st.prevShortSignal === true))
        if (gateNote) {
          await log(runId, run.userId, 'info', `Signal suppressed (session gate): ${res.entry.side.toUpperCase()} — ${res.entry.reason}`)
        } else if (eodActive && nowMinEt >= EOD_FLATTEN_MIN) {
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
          // resolve % legs — and Risk-Money sizing — against the live quote.
          // Task 85 spread parity: a market BUY fills at the ASK, a SELL at
          // the BID — so when the feed returns a SANE book (uncrossed, within
          // 100bps of mid; IEX-only NBBO can sit 5% wide and stale off-hours,
          // which would drag the anchor far worse than the last trade), legs
          // and sizing anchor on the fill-side quote and the journal records
          // the live spread. Missing/wide book → last trade stays the anchor,
          // exactly as before this task.
          let ref: number | null = null
          let anchorPx: number | null = null
          let spreadBps: number | null = null
          if (run.tpMode === 'pct' || run.slMode === 'pct' || run.sizingMode === 'risk') {
            try {
              // v1.80.8 — trading:true: the anchor prices TP/SL bracket legs,
              // so a transient data failure must yield NO quote (the honest
              // "entering without bracket legs" path below), never a sim price
              const { quotes } = await getQuotes([run.symbol], run.userId, { trading: true })
              const q = quotes.find((x) => x.symbol === run.symbol)
              ref = q?.price ?? null
              const b = q?.bid
              const a = q?.ask
              if (b != null && a != null && b > 0 && a > b) {
                const s = ((a - b) / ((a + b) / 2)) * 1e4
                if (s <= 100) {
                  spreadBps = s
                  anchorPx = res.entry!.side === 'buy' ? a : b
                }
              }
            } catch { ref = null }
            // Task 89 — a missing quote no longer degrades into a naked entry:
            // the fail-closed gate below SKIPS the bar when a % leg can't be
            // priced (a configured stop is never silently dropped).
          }
          anchorPx = anchorPx ?? ref
          const pctPx = (m: string, v: number | null, kind: 'tp' | 'sl'): number | undefined => {
            if (m !== 'pct' || v == null || anchorPx == null || anchorPx <= 0) return undefined
            const p = Math.min(100, Math.max(0.01, Math.abs(v)))
            const profitSide = kind === 'tp' ? res.entry!.side === 'buy' : res.entry!.side === 'sell'
            const px = profitSide ? anchorPx * (1 + p / 100) : anchorPx * (1 - p / 100)
            return px > 0 ? px : undefined
          }
          const tp = pctPx(run.tpMode, run.tpValue, 'tp')
          const sl = pctPx(run.slMode, run.slValue, 'sl')
          // ---- position sizing (Task 78 — Risk Money) ----
          // 'risk' derives the size from the risk budget and the live quote;
          // anything that makes the derivation impossible (no SL %, no quote,
          // no equity, budget below one increment) falls back to the fixed qty
          // with a journal line so the sizing behavior is never silent.
          const isCryptoSym = run.symbol.includes('/')
          let qty = isCryptoSym ? run.qty : Math.floor(run.qty)
          let riskSized = false
          let riskBudget: number | null = null
          if (run.sizingMode === 'risk') {
            // Task 78e — % basis: resolve the budget from the LIVE account equity
            let riskEquity: number | null = null
            if (run.riskBasis === 'pct') {
              try {
                const acct = await getAccount(run.userId, mode)
                const eq = Number(acct.data?.equity)
                riskEquity = Number.isFinite(eq) && eq > 0 ? eq : null
              } catch { riskEquity = null }
            }
            riskBudget = riskBudgetUsd(run.riskBasis, Number(run.riskMoney), run.riskMoneyPct, riskEquity)
            const slPct = run.slMode === 'pct' ? run.slValue : null
            const sized = anchorPx != null && slPct != null && sl != null && riskBudget != null
              ? riskSizedQty(riskBudget, anchorPx, slPct, isCryptoSym)
              : null
            if (sized != null) {
              qty = sized
              riskSized = true
            } else {
              const why = slPct == null
                ? 'no SL % bracket — risk needs a stop distance'
                : ref == null
                  ? 'no live quote'
                  : riskBudget == null
                    ? run.riskBasis === 'pct'
                      ? 'no account equity for risk %'
                      : 'risk money is not set'
                    : `risk ${riskMoneyLabel(run.riskBasis, Number(run.riskMoney), run.riskMoneyPct)} is below one ${isCryptoSym ? '0.0001 unit' : 'share'} at SL ${slPct}%`
              await log(runId, run.userId, 'info', `Risk sizing unavailable (${why}) — using fixed qty ${run.qty}`)
            }
          }
          const storedLegInvalid = (run.tpMode === 'pct' && !(run.tpValue != null && run.tpValue > 0)) ||
            (run.slMode === 'pct' && !(run.slValue != null && run.slValue > 0))
          if (ref == null && (run.tpMode === 'pct' || run.slMode === 'pct')) {
            // Task 89 — FAIL CLOSED: a % TP/SL that can't be priced used to
            // mean "enter without bracket legs" — a data hiccup silently
            // downgraded the user's stop to none (and for orb15/crypto left
            // the position with NO protection). The entry is skipped this
            // bar; the signal memory keeps the edge-gate semantics honest.
            await log(runId, run.userId, 'error', 'No live quote to price the % TP/SL bracket — entry SKIPPED this bar (fail-closed; a configured stop is never dropped)')
          } else if (storedLegInvalid) {
            // Task 89 — a STORED-INVALID % leg (null/≤ 0 value with mode
            // 'pct', e.g. from an import) must never degrade into a naked
            // entry either — same fail-closed posture, explicit journal.
            await log(runId, run.userId, 'error', 'Configured % TP/SL has an invalid stored value — entry SKIPPED this bar (fix the run settings; a configured stop is never dropped)')
          } else if (qty <= 0) {
            await log(runId, run.userId, 'error', 'qty rounds to 0 — fix the run quantity')
          } else {
            // Task 89 — fresh re-read before the order: a Stop/flatten,
            // Delete, or config edit that landed mid-cycle must not be
            // followed by a fresh entry (the old check ran once at cycle
            // top, ~1-3s of network work earlier).
            const fresh = await db.algoRun.findUnique({
              where: { id: runId },
              select: { status: true, symbol: true, timeframe: true, strategy: true },
            })
            if (!fresh) {
              // run deleted mid-cycle — nothing left to journal to
            } else if (fresh.status !== 'running' || `${fresh.symbol}|${fresh.timeframe}|${fresh.strategy}` !== identity) {
              await log(runId, run.userId, 'info', 'Entry aborted — the run was stopped or reconfigured mid-cycle')
            }
            if (fresh && fresh.status === 'running' && `${fresh.symbol}|${fresh.timeframe}|${fresh.strategy}` === identity) {
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
                // Task 85 — record the live spread on the entry line (only
                // set when the book passed the sanity gate): this is the
                // number to mirror in the backtest's Spread (bps) input — a
                // round trip pays it in full, half per market fill
                const spreadNote = spreadBps != null ? ` · spread ${spreadBps.toFixed(1)}bps` : ''
                const riskNote = riskSized
                  ? ` · sized by risk ${riskMoneyLabel(run.riskBasis, Number(run.riskMoney), run.riskMoneyPct)}/trade${run.riskBasis === 'pct' && riskBudget != null ? ` (≈ $${riskBudget.toFixed(2)})` : ''}`
                  : ''
                await log(runId, run.userId, 'trade', `ENTRY ${res.entry.side.toUpperCase()} ${qty} ${run.symbol} @ mkt${legs ? ` · ${legs}` : ''}${spreadNote}${riskNote} · #${r.results[0].id.slice(-8)} · trade ${st.tradesToday}/${run.maxTradesDay} today`)
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
      }
      // per-side signal memory — updated on EVERY newly processed bar
      // (regardless of gates/outcomes) so the fresh-signal edge trigger only
      // fires on a genuine false→true transition
      st.prevLongSignal = res.entry?.side === 'buy'
      st.prevShortSignal = res.entry?.side === 'sell'
      if (!res.entry) st.freshGateSide = undefined // signal ended — re-arm the note
      // Task 89 — bar consumption is now SPLIT: accumulators are price data
      // (always consumed) but the DECISION marker waits until the broker book
      // is trusted again, so an exit skipped during a posUnknown cycle is
      // re-evaluated on the next cycle exactly like the backtest would.
      st.lastFedBarTime = evalBar.time
      if (!posUnknown) st.lastBarTime = evalBar.time
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

/** Create a run row (and start its engine — unless `opts.autostart === false`,
 *  Task 79: importing a STOPPED config creates the run paused so trading only
 *  begins when the user explicitly presses Start). */
export async function startAlgoRun(cfg: {
  userId: string
  symbol: string
  /** Task 89 — the Alpaca account this run trades on, pinned for its whole
   *  life (start refuses live, so this is 'paper' today; omitted = paper) */
  mode?: TradeMode
  timeframe: string
  strategy: AlgoStrategyId
  params: unknown
  qty: number
  sizingMode: string
  riskBasis: string
  riskMoney: number | null
  riskMoneyPct: number | null
  tpMode: string
  tpValue: number | null
  slMode: string
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  cooldownMin: number
  requireNewSignal: boolean
}, opts?: { autostart?: boolean }) {
  const autostart = opts?.autostart !== false
  const run = await db.algoRun.create({
    data: {
      userId: cfg.userId,
      symbol: cfg.symbol,
      mode: cfg.mode === 'live' ? 'live' : 'paper',
      timeframe: cfg.timeframe,
      strategy: cfg.strategy,
      params: normalizeAlgoParams(cfg.strategy, cfg.params) as unknown as object,
      qty: cfg.qty,
      sizingMode: cfg.sizingMode === 'risk' ? 'risk' : 'fixed',
      riskBasis: cfg.sizingMode === 'risk' && cfg.riskBasis === 'pct' ? 'pct' : 'usd',
      riskMoney: cfg.sizingMode === 'risk' && cfg.riskBasis !== 'pct' ? cfg.riskMoney : null,
      riskMoneyPct: cfg.sizingMode === 'risk' && cfg.riskBasis === 'pct' ? cfg.riskMoneyPct : null,
      tpMode: cfg.tpMode,
      tpValue: cfg.tpValue,
      slMode: cfg.slMode,
      slValue: cfg.slValue,
      maxTradesDay: cfg.maxTradesDay,
      rthOnly: cfg.rthOnly,
      flattenEod: cfg.flattenEod,
      cooldownMin: cfg.cooldownMin,
      requireNewSignal: cfg.requireNewSignal,
      status: autostart ? 'running' : 'stopped',
      ...(autostart ? {} : { stoppedAt: new Date() }),
      state: {} as unknown as object,
    },
  })
  const sizing = cfg.sizingMode === 'risk'
    ? `risk ${cfg.riskBasis === 'pct' ? `${cfg.riskMoneyPct}% of equity` : `$${cfg.riskMoney}`}/trade`
    : `qty ${cfg.qty}`
  await log(run.id, cfg.userId, 'info', autostart
    ? `Run started — ${ALGO_STRATEGIES[cfg.strategy].name} · ${cfg.symbol} ${cfg.timeframe} · ${sizing}${cfg.rthOnly ? ' · RTH only' : ''}${cfg.flattenEod ? ' · EOD flatten' : ''}${cfg.cooldownMin > 0 ? ` · cooldown ${cfg.cooldownMin}m` : ''}${cfg.requireNewSignal ? ' · fresh-signal re-entry' : ''}`
    : `Run created STOPPED (imported config) — ${ALGO_STRATEGIES[cfg.strategy].name} · ${cfg.symbol} ${cfg.timeframe} · ${sizing}${cfg.rthOnly ? ' · RTH only' : ''}${cfg.flattenEod ? ' · EOD flatten' : ''}${cfg.cooldownMin > 0 ? ` · cooldown ${cfg.cooldownMin}m` : ''}${cfg.requireNewSignal ? ' · fresh-signal re-entry' : ''} — press Start to begin trading`)
  if (autostart) startEngine(run.id)
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
  sizingMode: string
  riskBasis: string
  riskMoney: number | null
  riskMoneyPct: number | null
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
    // the next cycle starts clean on the new instrument/strategy (Task 89:
    // also the feed cursor + fail-closed suppression note)
    delete st.lastBarTime
    delete st.lastFedBarTime
    st.entrySuppressedNoted = false
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
  // Task 78 — sizing diff reads as whole-mode changes when the mode flips,
  // and as a plain $ / % change when only the risk budget moves (Task 78e:
  // a basis flip $ ↔ % is its own mode-level change, never a silent $0).
  const sizingLabel = (mode: string, basis: string, qty: number, rm: number | null, rp: number | null) =>
    mode === 'risk' ? `risk ${basis === 'pct' ? `${rp ?? 0}% of equity` : `$${rm ?? 0}`}/trade` : `fixed qty ${qty}`
  const runBasis = run.riskBasis === 'pct' ? 'pct' : 'usd'
  if (run.sizingMode !== patch.sizingMode || (patch.sizingMode === 'risk' && runBasis !== patch.riskBasis)) {
    diffs.push(`sizing ${sizingLabel(run.sizingMode, runBasis, run.qty, run.riskMoney, run.riskMoneyPct)} → ${sizingLabel(patch.sizingMode, patch.riskBasis, patch.qty, patch.riskMoney, patch.riskMoneyPct)}`)
  } else if (patch.sizingMode === 'risk' && patch.riskBasis === 'pct' && run.riskMoneyPct !== patch.riskMoneyPct) {
    diffs.push(`risk ${run.riskMoneyPct ?? 0}% → ${patch.riskMoneyPct ?? 0}% of equity/trade`)
  } else if (patch.sizingMode === 'risk' && patch.riskBasis !== 'pct' && run.riskMoney !== patch.riskMoney) {
    diffs.push(`risk $${run.riskMoney ?? 0} → $${patch.riskMoney ?? 0}/trade`)
  }
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
      sizingMode: patch.sizingMode === 'risk' ? 'risk' : 'fixed',
      riskBasis: patch.sizingMode === 'risk' && patch.riskBasis === 'pct' ? 'pct' : 'usd',
      riskMoney: patch.sizingMode === 'risk' && patch.riskBasis !== 'pct' ? patch.riskMoney : null,
      riskMoneyPct: patch.sizingMode === 'risk' && patch.riskBasis === 'pct' ? patch.riskMoneyPct : null,
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
    // Task 89 — flatten hits the run's PINNED account, not the current tradeMode
    const f = await flattenPosition(run.userId, runModeOf(run.mode), run.symbol)
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
