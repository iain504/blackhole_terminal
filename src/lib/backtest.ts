// Backtest engine (Task 62) — pure, synchronous bar-replay simulator for the
// Algo strategies, plus a grid-search parameter optimizer.
//
// PARITY CONTRACT with the live engine (src/lib/algo-engine.ts):
//   • the decision rules below MUST mirror evalStrategy() exactly — the same
//     comparisons, thresholds and exit strings (rsi2's RSI reads the LAST rp
//     changes, orb15 marks one-per-side on entry — keep both sides in sync);
//   • day accumulators (session VWAP / opening range) consume only the current
//     ET day's bars — REGULAR-session bars for equities, ALL bars for crypto
//     (cfg.isCrypto) — and reset on every ET day change;
//   • exits resolve BEFORE entries on the same bar (an exit + fresh entry can
//     both execute, like the live cycle).
//
// EXECUTION MODEL (documented assumptions):
//   • strategy exits decided on a bar close fill at that bar's CLOSE (the live
//     engine market-orders seconds after the close);
//   • entry signals fill at the NEXT bar's OPEN (conservative for close-driven
//     systems) — % TP/SL legs derive from the FILL price;
//   • OPTIONAL cost model (Task 84): slippageBps applies an adverse fill drift
//     to every MARKET/STOP fill (entries, SL legs, strategy/EOD/mark exits) —
//     TP legs are resting LIMIT orders and fill at their price, no drift.
//     feeBps charges per-fill notional fees on every fill (entry + exit). Both
//     default to 0 = the historical frictionless model. Task 85 adds
//     spreadBps — the bid/ask spread: a market BUY fills at the ASK and a
//     SELL at the BID, so each market fill is charged HALF the spread
//     adversely (a round trip pays the full spread); resting TP limits stay
//     clean. slippageBps stacks on top as impact/drift beyond the quote;
//   • warmup is aligned to the LIVE engine's guards bar-for-bar: the first
//     decided bar is the first bar whose window satisfies the same `n <
//     period+2` / `n < trendSma+2` check evalStrategy applies (Task 84 parity
//     probe — the old +2 warmup let live fire one bar before the backtest);
//   • TP/SL are resting brackets: checked intrabar against every bar's high/
//     low INCLUDING the entry bar; when both could hit in one bar the STOP is
//     assumed first (worst case);
//   • flattenEod closes the position at the first bar opening at/after 15:45
//     ET (fill at that bar's OPEN — wall-clock parity: the live gate is a
//     15:45:00 tick event, not a bar-close event, so on aligned 1m/5m/15m
//     bars the gate bar starts exactly at 15:45 and its brackets are
//     preempted) and suppresses entries from 15:45 ET —
//     EQUITY symbols only (crypto runs 24/7, guards ignored like the engine);
//   • rthOnly gates entries to regular-session bars (exits/brackets run 24h,
//     like the live engine) — EQUITY symbols only, ignored for crypto;
//   • re-entry control (Task 70-c, mirrored from algo-engine.ts): cooldownMin
//     blocks entries on bars that OPEN within N minutes after a position
//     closes; requireNewSignal fires an entry only on a false→true signal
//     edge vs the previously decided bar (per side). Both default off — with
//     them off the replay is byte-identical to the pre-Task-70 behavior.
//
// PERFORMANCE: all series-level, param-independent work (ET day keys, session
// flags, prefix sums for SMA/σ) is precomputed ONCE by prepareSeries() and
// reused by every optimizer combo — each combo then costs ~O(bars) with O(1)
// per-bar indicator updates (grid of ~800 combos × 40k bars ≈ 1–2s).
import { sessionOf, etDateKey, etMinutesOfDay, RTH_START_MIN } from '@/lib/sessions'
import { ALGO_STRATEGIES, ALGO_STRATEGY_IDS, normalizeAlgoParams, type AlgoStrategyId } from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'
import { memoryGuard } from '@/lib/mem-guard'

const EOD_FLATTEN_MIN = 15 * 60 + 45 // 15:45 ET — same as the live engine

export interface BacktestConfig {
  strategy: AlgoStrategyId
  params: Record<string, number>
  qty: number
  // Task 78 — Risk Money sizing: 'risk' derives the per-trade size from the
  // dollars-at-risk budget and THIS bar's open/stop distance (so every trade
  // risks ≈ riskMoney). Falls back to `qty` when the config has no SL %.
  sizingMode: 'fixed' | 'risk'
  // Task 78e — budget basis. 'pct' resolves the budget per trade from the
  // CURRENT simulated equity (cash) × riskMoneyPct/100, so risk compounds
  // with the account exactly like the live % basis. Optional for backward
  // compatibility with pre-78e probes — undefined reads as 'usd'.
  riskBasis?: 'usd' | 'pct'
  riskMoney: number | null
  riskMoneyPct?: number | null
  isCrypto: boolean // risk sizing floors to whole shares for stocks, 4dp for crypto
  tpMode: 'none' | 'pct'
  tpValue: number | null
  slMode: 'none' | 'pct'
  slValue: number | null
  maxTradesDay: number
  rthOnly: boolean
  flattenEod: boolean
  // re-entry control (Task 70-c) — mirrors the live engine's gates
  cooldownMin: number // no entries within N minutes after a position closes (0 = off)
  requireNewSignal: boolean // fire only on a false→true signal edge vs the previous bar
  capital: number
  // Task 84 — execution-cost model (both optional, default 0 = frictionless):
  slippageBps?: number // adverse bps on market/stop fills (entry, SL, strategy/EOD/mark exits)
  feeBps?: number // per-fill notional fee bps (charged on entry AND exit)
  // Task 85 — bid/ask spread (bps). Market fills pay HALF of it per fill
  // (buy fills at ask, sell at bid — a round trip pays the full spread);
  // resting TP limits still fill at their price. Stacks with slippageBps.
  spreadBps?: number
  // Task 3-d — buying-power cap. Max position notional = capital × maxNotionalX
  // (default 1 = no leverage beyond capital). Every entry (fixed AND risk-
  // derived sizing) is clamped to maxQty = (capital × maxNotionalX) / entryPx;
  // a clamped position worth < $10 is skipped as dust (counted in `suppressed`).
  maxNotionalX?: number
  // Task 9-l — skip building the realized equity curve for this run (default
  // true). Sweep/optimize runs consume metrics only, and a multi-hundred-combo
  // sweep allocating a per-close {t,equity} array each run is pure GC churn.
  // Metrics (incl. mark-to-market maxDrawdownPct) are unaffected — MTM peak/
  // trough tracking is separate from this display array.
  collectEquity?: boolean
}

export interface BacktestTrade {
  entryTime: number
  exitTime: number
  side: 'long' | 'short'
  qty: number
  entryPx: number
  exitPx: number
  pnl: number
  pnlPct: number // return on position notional
  exitReason: string
  holdMin: number
}

export interface BacktestMetrics {
  trades: number
  wins: number
  losses: number
  winRate: number // 0..100
  netPnl: number
  netPct: number // vs starting capital
  grossWin: number
  grossLoss: number // positive number
  profitFactor: number // capped at 999 when no losses
  maxDrawdown: number // $, on the realized equity curve
  maxDrawdownPct: number // vs equity peak
  avgHoldMin: number
  expectancy: number // $ per trade
  avgWin: number
  avgLoss: number // positive number
  largestWin: number
  largestLoss: number // positive number
  longs: number
  shorts: number
  tradesPerWeek: number
  finalEquity: number
  bars: number
  from: number // first evaluable bar time (unix s)
  to: number // last bar time (unix s)
  openAtEnd: boolean // position was marked-to-market at the last bar
  suppressed: number // signals suppressed by session/cap/window/cooldown/edge gates
  // Task 3-d — short entries DROPPED because the market is long-only (Alpaca
  // crypto has no shorting — trading.ts). 0 when absent/undefined for old data.
  skippedShorts?: number
}

export interface BacktestResult {
  metrics: BacktestMetrics
  trades: BacktestTrade[]
  equity: { t: number; equity: number }[] // realized equity after each close
  warmupBars: number
}

// ---------------------------------------------------------------------------
// series preparation (once per symbol/timeframe/dataset)
// ---------------------------------------------------------------------------

export interface BacktestSeries {
  bars: Bar[]
  n: number
  dayIdx: Int32Array // ET-day ordinal per bar (change detection)
  minutes: Int32Array // ET minutes-of-day per bar open
  rth: Uint8Array // 1 = regular session bar
  ps: Float64Array // prefix sums of closes (len n+1) — SMA in O(1)
  ps2: Float64Array // prefix sums of close² — population σ in O(1)
  // Task 9-l — lazily-allocated REUSABLE scratch for runBacktest's Wilder-RSI
  // pass (bb-reversion). One array per SERIES instead of one per simulated
  // combo: a 120k-bar sweep used to allocate ~1MB × hundreds of runs of
  // short-lived churn — the final straw that fatally OOM'd the 1.8GB-heap dev
  // box. Safe: runs are sequential/single-threaded and each run re-fills the
  // whole array before the sim loop reads it.
  rsiScratch?: Float64Array
}

export function prepareSeries(bars: Bar[]): BacktestSeries {
  const n = bars.length
  const dayIdx = new Int32Array(n)
  const minutes = new Int32Array(n)
  const rth = new Uint8Array(n)
  const ps = new Float64Array(n + 1)
  const ps2 = new Float64Array(n + 1)
  const dayOrd = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const dk = etDateKey(b.time)
    let ord = dayOrd.get(dk)
    if (ord == null) {
      ord = dayOrd.size
      dayOrd.set(dk, ord)
    }
    dayIdx[i] = ord
    minutes[i] = etMinutesOfDay(b.time)
    rth[i] = sessionOf(b.time) === 'regular' ? 1 : 0
    ps[i + 1] = ps[i] + b.close
    ps2[i + 1] = ps2[i] + b.close * b.close
  }
  return { bars, n, dayIdx, minutes, rth, ps, ps2 }
}

// ---------------------------------------------------------------------------
// one simulation run
// ---------------------------------------------------------------------------

interface Dec {
  entry: { side: 'buy' | 'sell'; reason: string } | null
  exit: string | null
}
const NONE: Dec = { entry: null, exit: null }

export function runBacktest(series: BacktestSeries, cfg: BacktestConfig): BacktestResult {
  const { bars, n, dayIdx, minutes, rth, ps, ps2 } = series
  const params = normalizeAlgoParams(cfg.strategy, cfg.params)
  const strategy = cfg.strategy

  // warmup: bars needed before the first decision — ALIGNED to the live
  // engine's evalStrategy guards (`n < period+2` / `n < trendLen+2` allow the
  // first decision at i = period+1 / trendLen+1, so the backtest must too).
  // The old +2 here let a live run fire ONE BAR before the backtest on the
  // same data (Task 84 parity probe).
  let warmup = 1
  if (strategy === 'bb-reversion') warmup = Math.max(5, Math.round(params.bbPeriod ?? 20)) + 1
  if (strategy === 'rsi2-connors') warmup = Math.max(10, Math.round(params.trendSma ?? 200)) + 1

  // ---- Task 84 cost model · Task 85 spread ----
  // slip = total adverse drift fraction on every MARKET/STOP fill. The spread
  // contributes HALF of spreadBps per fill (buy at ask = +half, sell at bid =
  // −half) — a full round trip therefore pays the entire spread. slippageBps
  // stacks on top as impact/latency drift beyond the quote.
  const slip = Math.max(0, (cfg.slippageBps ?? 0) + (cfg.spreadBps ?? 0) / 2) / 1e4
  const fee = Math.max(0, cfg.feeBps ?? 0) / 1e4 // per-fill fee fraction
  const slipPx = (px: number, exitDir: 1 | -1): number => {
    // exitDir: +1 = buying back (short exit) → pay up · -1 = selling (long exit) → receive less
    const p = exitDir === 1 ? px * (1 + slip) : px * (1 - slip)
    return p > 0 ? p : px
  }

  // ---- Wilder RSI (bb-reversion) — one incremental pass, O(1)/bar ----
  // (live re-seeds from its rolling window start; after ~3×period bars both
  // converge to the same steady state — backtest seeds from history start)
  let rsiArr: Float64Array | null = null
  if (strategy === 'bb-reversion') {
    const rp = Math.max(2, Math.round(params.rsiPeriod ?? 14))
    // Task 9-l — reuse the series-level scratch (see BacktestSeries.rsiScratch)
    const arr = (series.rsiScratch ??= new Float64Array(n))
    // re-seed to NaN every run: the fill loop never writes arr[0..rp-1], so a
    // reused buffer must not carry FINITE leftovers from a previous run (they
    // could flip entry decisions that NaN comparisons correctly suppress)
    arr.fill(Number.NaN)
    let ag = 0
    let al = 0
    for (let i = 1; i < n; i++) {
      const d = bars[i].close - bars[i - 1].close
      if (i <= rp) {
        if (d >= 0) ag += d
        else al -= d
        if (i === rp) {
          ag /= rp
          al /= rp
          arr[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
        }
        continue
      }
      ag = (ag * (rp - 1) + Math.max(0, d)) / rp
      al = (al * (rp - 1) + Math.max(0, -d)) / rp
      arr[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al)
    }
    rsiArr = arr
  }

  // ---- per-bar decision (mirrors evalStrategy in algo-engine.ts) ----
  // day-accumulator state lives in the loop below (shared with the executor);
  // decide() reads it via closure.
  let vwapNum = 0
  let vwapDen = 0
  let orHigh: number | null = null
  let orLow: number | null = null
  let orDone = false
  let firedLong = false
  let firedShort = false
  const orMinutes = Math.max(5, Math.round(params.orMinutes ?? 15))

  const smaAt = (i: number, period: number): number => {
    if (i + 1 < period) return Number.NaN
    return (ps[i + 1] - ps[i + 1 - period]) / period
  }
  const sdAt = (i: number, period: number, mean: number): number => {
    if (i + 1 < period) return Number.NaN
    const v = (ps2[i + 1] - ps2[i + 1 - period]) / period - mean * mean
    return v > 0 ? Math.sqrt(v) : 0
  }

  const decide = (i: number): Dec => {
    const c = bars[i].close
    if (strategy === 'bb-reversion') {
      const period = Math.max(5, Math.round(params.bbPeriod ?? 20))
      if (i + 1 < period + 2) return NONE
      const mean = smaAt(i, period)
      const sd = sdAt(i, period, mean)
      const mult = params.bbStd ?? 2
      const upper = mean + mult * sd
      const lower = mean - mult * sd
      const rp = Math.max(2, Math.round(params.rsiPeriod ?? 14))
      const rsiVal = Number.isFinite(rsiArr?.[i]) ? (rsiArr as Float64Array)[i] : 50
      const allowShort = (params.allowShort ?? 1) >= 1
      const os = params.rsiOversold ?? 30
      const ob = params.rsiOverbought ?? 70
      if (c < lower && rsiVal < os) return { entry: { side: 'buy', reason: `close < lower BB · RSI ${rsiVal.toFixed(1)}` }, exit: null }
      if (allowShort && c > upper && rsiVal > ob) return { entry: { side: 'sell', reason: `close > upper BB · RSI ${rsiVal.toFixed(1)}` }, exit: null }
      if (Math.abs(c - mean) < sd * 0.25) return { entry: null, exit: 'reverted to band mean' }
      return NONE
    }
    if (strategy === 'rsi2-connors') {
      const trendLen = Math.max(10, Math.round(params.trendSma ?? 200))
      if (i + 1 < trendLen + 2) return NONE
      const smaT = smaAt(i, trendLen)
      const rp = Math.max(2, Math.round(params.rsiPeriod ?? 2))
      // LAST rp bar-to-bar changes (parity-fixed — see algo-engine.ts)
      let g = 0
      let l = 0
      for (let k = i - rp + 1; k <= i; k++) {
        const d = bars[k].close - bars[k - 1].close
        if (d >= 0) g += d
        else l -= d
      }
      const rsiVal = l === 0 ? 100 : 100 - 100 / (1 + g / l)
      const exitLen = Math.max(2, Math.round(params.exitSma ?? 5))
      const smaE = smaAt(i, exitLen)
      const exit = c > smaE ? 'Connors recapture (close > exit SMA)' : null
      if (c > smaT && rsiVal < (params.rsiBuy ?? 10)) {
        return { entry: { side: 'buy', reason: `close > trend SMA · RSI(${rp}) ${rsiVal.toFixed(1)}` }, exit }
      }
      return { entry: null, exit }
    }
    if (strategy === 'orb15') {
      if (!orDone || orHigh == null || orLow == null) return NONE
      const onePerSide = (params.onePerSide ?? 1) >= 1
      if (c > orHigh && !(onePerSide && firedLong)) return { entry: { side: 'buy', reason: 'close broke OR high' }, exit: null }
      if (c < orLow && !(onePerSide && firedShort)) return { entry: { side: 'sell', reason: 'close broke OR low' }, exit: null }
      return NONE
    }
    // vwap-fade
    {
      const devPct = params.devPct ?? 0.6
      if (vwapDen <= 0) return NONE
      const vwap = vwapNum / vwapDen
      if (!(vwap > 0)) return NONE
      const dev = ((c - vwap) / vwap) * 100
      const allowShort = (params.allowShort ?? 1) >= 1
      if (dev <= -devPct) return { entry: { side: 'buy', reason: `${dev.toFixed(2)}% below session VWAP` }, exit: null }
      if (allowShort && dev >= devPct) return { entry: { side: 'sell', reason: `+${dev.toFixed(2)}% above session VWAP` }, exit: null }
      if (Math.abs(dev) < 0.08) return { entry: null, exit: 'reverted to session VWAP' }
      return NONE
    }
  }

  // ---- executor state ----
  interface Pos {
    side: 1 | -1
    qty: number
    entryPx: number
    entryTime: number
    tpPx: number | null
    slPx: number | null
  }
  interface Pending {
    side: 1 | -1
  }
  let pos: Pos | null = null
  let pending: Pending | null = null
  let cash = cfg.capital
  // Task 3-d — MARK-TO-MARKET drawdown: peak/trough are tracked on the
  // realized+unrealized equity (cash while flat, cash + open P&L at every
  // bar close while a position is open), so an open trade that dives and
  // recovers is no longer invisible to maxDrawdownPct. The DISPLAYED equity
  // curve stays realized-only (unchanged); metrics.maxDrawdown* are MTM.
  let peak = cfg.capital
  let maxDD = 0
  let maxDDPct = 0
  const mtmTrack = (eq: number): void => {
    if (!Number.isFinite(eq)) return
    if (eq > peak) peak = eq
    const dd = peak - eq
    if (dd > maxDD) {
      maxDD = dd
      maxDDPct = peak > 0 ? (dd / peak) * 100 : 0
    }
  }
  let tradesToday = 0
  let curDay = -1
  let suppressed = 0
  let skippedShorts = 0 // Task 3-d — crypto long-only drops
  // timeframe seconds — min positive bar delta over the head of the series
  // (session/weekend gaps only inflate deltas, so the min is the true tf)
  let tfSec = 60
  for (let k = 1; k < Math.min(n, 61); k++) {
    const d = bars[k].time - bars[k - 1].time
    if (d > 0 && d < tfSec) tfSec = d
  }
  // re-entry control (Task 70-c)
  let cooldownUntil: number | null = null // bar-time seconds — no entries before this
  let prevLongSig = false // raw entry signal on the previously decided bar
  let prevShortSig = false
  const trades: BacktestTrade[] = []
  // Task 9-l — display curve only (metrics DD is MTM); sweep/optimize runs
  // opt out via cfg.collectEquity === false to cut per-run allocation churn.
  const collectEquity = cfg.collectEquity !== false
  const equity: { t: number; equity: number }[] = collectEquity ? [{ t: bars[0]?.time ?? 0, equity: cash }] : []

  const closeTrade = (p: Pos, exitPxRaw: number, exitTime: number, reason: string) => {
    const dir = p.side
    const pnl0 = (exitPxRaw - p.entryPx) * p.qty * dir
    // Task 84 — per-fill notional fees on entry + exit (entry notional uses
    // the SLIPPED entry price the position actually carries)
    const feeCost = fee > 0 ? (p.entryPx + exitPxRaw) * p.qty * fee : 0
    const pnl = pnl0 - feeCost
    cash += pnl
    if (collectEquity) equity.push({ t: exitTime, equity: cash })
    mtmTrack(cash) // realized point of the MTM series (peak/DD updated here)
    // cooldown gate: block entries for N minutes after ANY position close.
    // Anchored at the closing bar's CLOSE (exitTime is the bar OPEN — add the
    // bar duration), matching the live engine's wall-clock gate which arms at
    // detection ≈ bar close (Task 84 parity).
    if (cfg.cooldownMin > 0) cooldownUntil = exitTime + tfSec + cfg.cooldownMin * 60
    trades.push({
      entryTime: p.entryTime,
      exitTime,
      side: dir === 1 ? 'long' : 'short',
      qty: p.qty,
      entryPx: p.entryPx,
      exitPx: exitPxRaw,
      pnl,
      pnlPct: p.entryPx * p.qty > 0 ? (pnl / (p.entryPx * p.qty)) * 100 : 0,
      exitReason: reason,
      holdMin: Math.max(0, (exitTime - p.entryTime) / 60),
    })
  }

  for (let i = 0; i < n; i++) {
    const bar = bars[i]
    // ---- new ET day → reset counters / accumulators (mirrors the engine) ----
    if (dayIdx[i] !== curDay) {
      curDay = dayIdx[i]
      tradesToday = 0
      vwapNum = 0
      vwapDen = 0
      orHigh = null
      orLow = null
      orDone = false
      firedLong = false
      firedShort = false
    }
    // ---- feed day accumulators (equities: regular-session bars only ·
    // crypto: ALL bars of the ET day — 24/7 VWAP / midnight-anchored OR) ----
    if (rth[i] === 1 || cfg.isCrypto) {
      const typ = (bar.high + bar.low + bar.close) / 3
      if (strategy === 'vwap-fade') {
        vwapNum += typ * bar.volume
        vwapDen += bar.volume
      }
      if (strategy === 'orb15' && !orDone) {
        const m = minutes[i]
        // OR window anchor: equities → 09:30 ET open; crypto → ET midnight
        const orAnchor = cfg.isCrypto ? 0 : RTH_START_MIN
        if (m >= orAnchor && m < orAnchor + orMinutes) {
          orHigh = orHigh == null ? bar.high : Math.max(orHigh, bar.high)
          orLow = orLow == null ? bar.low : Math.min(orLow, bar.low)
        } else if (m >= orAnchor + orMinutes && orHigh != null && orLow != null) {
          orDone = true
        }
      }
    }

    if (i < warmup) continue

    // ---- 1) fill the pending entry at THIS bar's open ----
    if (pending && Number.isFinite(bar.open) && bar.open > 0) {
      const dir = pending.side
      // market order fill — adverse slippage against the position direction
      const fill = slip > 0 ? (dir === 1 ? bar.open * (1 + slip) : bar.open * (1 - slip)) : bar.open
      const pctPx = (v: number | null, tp: boolean): number | null => {
        if (v == null || !(v > 0)) return null
        const p = Math.min(100, Math.max(0.01, Math.abs(v)))
        const profitSide = tp ? dir === 1 : dir === -1
        const px = profitSide ? fill * (1 + p / 100) : fill * (1 - p / 100)
        return px > 0 ? px : null
      }
      const slPx = cfg.slMode === 'pct' ? pctPx(cfg.slValue, false) : null
      // Risk-Money sizing (Task 78) — size each trade so the loss to THIS
      // trade's stop ≈ the risk budget, using the actual fill price. Risk-
      // sized trades therefore breathe with volatility exactly like the live
      // engine. Task 78e — % basis resolves the budget from the CURRENT
      // simulated equity (compounds with the curve, like a live account).
      let qty = cfg.qty
      if (cfg.sizingMode === 'risk' && slPx != null) {
        const pct = cfg.riskBasis === 'pct'
        const budget = pct
          ? (cfg.riskMoneyPct != null && cfg.riskMoneyPct > 0 && cash > 0 ? (cash * Math.min(100, cfg.riskMoneyPct)) / 100 : null)
          : (cfg.riskMoney != null && cfg.riskMoney > 0 ? cfg.riskMoney : null)
        if (budget != null) {
          const riskPerUnit = Math.abs(fill - slPx)
          if (riskPerUnit > 0) {
            const raw = budget / riskPerUnit
            if (cfg.isCrypto) {
              const q = Math.floor(raw * 1e4) / 1e4
              if (q >= 0.0001) qty = q
            } else {
              const q = Math.floor(raw)
              if (q >= 1) qty = q
            }
          }
        }
      }
      // Task 3-d — NOTIONAL CAP (buying power): effectiveQty is the requested
      // size clamped to capital × maxNotionalX worth of the fill price, for
      // BOTH sizing modes. The TP/SL brackets derive from the same fill, so
      // the capped position carries proportionally capped bracket P&L. A
      // clamped position worth < $10 is dust → skip the trade entirely.
      const capX = cfg.maxNotionalX != null && cfg.maxNotionalX > 0 ? cfg.maxNotionalX : 1
      const maxNotional = cfg.capital * capX
      const maxQty = cfg.isCrypto
        ? Math.floor((maxNotional / fill) * 1e4) / 1e4 // crypto granularity 4dp
        : Math.floor(maxNotional / fill) // stocks stay whole-share
      const effQty = Math.min(qty, maxQty)
      if (!(effQty > 0) || effQty * fill < 10) {
        // dust — notional below the exchange-minimum ballpark: no trade
        pending = null
        suppressed++
      } else {
        pos = {
          side: dir,
          qty: effQty,
          entryPx: fill,
          entryTime: bar.time,
          tpPx: cfg.tpMode === 'pct' ? pctPx(cfg.tpValue, true) : null,
          slPx,
        }
      }
      pending = null
    }

    // ---- 2) EOD flatten — WALL-CLOCK parity (equity symbols only — crypto
    //         never force-flattens): the live gate fires at 15:45:00 ET on the
    //         engine's tick, NOT on the bar close, so the backtest flattens at
    //         the OPEN of the first bar opening at/after 15:45 (on aligned
    //         1m/5m/15m bars that bar STARTS at the gate) and preempts the
    //         bar's brackets — no post-gate TP/SL fills can happen. Filling at
    //         the CLOSE (the old model) exited 15:46 / 15:50 / 16:00 on 1m/5m/
    //         15m — up to 15 minutes past the live exit through the close.
    const eodGate = cfg.flattenEod && !cfg.isCrypto && minutes[i] >= EOD_FLATTEN_MIN
    if (pos && eodGate) {
      closeTrade(pos, slipPx(bar.open, pos.side === 1 ? -1 : 1), bar.time, 'EOD flatten')
      pos = null
    }

    // ---- 3) resting TP/SL intrabar (stop assumed first — worst case) —
    //         skipped on the EOD gate bar, the position is already flat
    if (pos && !eodGate) {
      let exitPx: number | null = null
      let reason = ''
      if (pos.side === 1) {
        if (pos.slPx != null && bar.low <= pos.slPx) {
          exitPx = slipPx(pos.slPx, -1) // stop-market sell — adverse drift
          reason = 'stop loss'
        } else if (pos.tpPx != null && bar.high >= pos.tpPx) {
          exitPx = pos.tpPx // resting LIMIT — fills at its price, no drift
          reason = 'take profit'
        }
      } else {
        if (pos.slPx != null && bar.high >= pos.slPx) {
          exitPx = slipPx(pos.slPx, 1) // stop-market buy-back — adverse drift
          reason = 'stop loss'
        } else if (pos.tpPx != null && bar.low <= pos.tpPx) {
          exitPx = pos.tpPx // resting LIMIT — fills at its price, no drift
          reason = 'take profit'
        }
      }
      if (exitPx != null) {
        closeTrade(pos, exitPx, bar.time, reason)
        pos = null
      }
    }

    // ---- 4) evaluate the strategy on this closed bar (exits → entries) ----
    const dec = decide(i)
    if (dec.exit && pos) {
      closeTrade(pos, slipPx(bar.close, pos.side === 1 ? -1 : 1), bar.time, dec.exit)
      pos = null
    }
    if (dec.entry && !pos && !pending) {
      // Task 3-d — CRYPTO LONG-ONLY: Alpaca crypto cannot short (trading.ts
      // emulated exit legs are sell-only, qty clamped ≥ 0). Short signals are
      // counted and dropped — the live engine is intentionally untouched.
      if (cfg.isCrypto && dec.entry.side === 'sell') {
        skippedShorts++
      } else {
        // gates (mirrored from the engine's entry path) + re-entry control
        const cooldownBlocked = cooldownUntil != null && bar.time < cooldownUntil
        const edgeBlocked = cfg.requireNewSignal && (
          (dec.entry.side === 'buy' && prevLongSig) ||
          (dec.entry.side === 'sell' && prevShortSig))
        if (cfg.rthOnly && !cfg.isCrypto && rth[i] !== 1) suppressed++
        else if (cfg.flattenEod && !cfg.isCrypto && minutes[i] >= EOD_FLATTEN_MIN) suppressed++
        else if (cooldownBlocked) suppressed++
        else if (edgeBlocked) suppressed++
        else if (tradesToday >= cfg.maxTradesDay) suppressed++
        else {
          pending = { side: dec.entry.side === 'buy' ? 1 : -1 }
          tradesToday++
          if (strategy === 'orb15') {
            if (dec.entry.side === 'buy') firedLong = true
            else firedShort = true
          }
        }
      }
    }
    // per-side signal memory — updated on EVERY decided bar (regardless of
    // gates/outcomes) so the fresh-signal edge fires only on false→true
    prevLongSig = dec.entry?.side === 'buy'
    prevShortSig = dec.entry?.side === 'sell'
    // ---- Task 3-d — MTM drawdown sample: while a position is open, mark it
    // to THIS bar's close and track the peak/trough of realized+unrealized
    // equity (close-based MTM is the standard conservative choice given the
    // stop-first intrabar rule). Flat bars are already tracked in closeTrade.
    if (pos) {
      mtmTrack(cash + (bar.close - pos.entryPx) * pos.qty * pos.side)
    }
  }

  // ---- position still open at the end of data → mark to market ----
  let openAtEnd = false
  if (pos) {
    const lastBar = bars[n - 1]
    closeTrade(pos, slipPx(lastBar.close, pos.side === 1 ? -1 : 1), lastBar.time, 'open at end of data (marked)')
    openAtEnd = true
  }

  // ---- metrics ----
  const evaluated = trades.length
  let wins = 0
  let grossWin = 0
  let grossLoss = 0
  let largestWin = 0
  let largestLoss = 0
  let holdSum = 0
  let longs = 0
  let shorts = 0
  for (const t of trades) {
    if (t.pnl >= 0) {
      wins++
      grossWin += t.pnl
      if (t.pnl > largestWin) largestWin = t.pnl
    } else {
      grossLoss += -t.pnl
      if (-t.pnl > largestLoss) largestLoss = -t.pnl
    }
    holdSum += t.holdMin
    if (t.side === 'long') longs++
    else shorts++
  }
  const losses = evaluated - wins
  const netPnl = cash - cfg.capital
  const spanSec = n > warmup ? bars[n - 1].time - bars[warmup].time : 0
  const metrics: BacktestMetrics = {
    trades: evaluated,
    wins,
    losses,
    winRate: evaluated > 0 ? (wins / evaluated) * 100 : 0,
    netPnl,
    netPct: cfg.capital > 0 ? (netPnl / cfg.capital) * 100 : 0,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? Math.min(999, grossWin / grossLoss) : grossWin > 0 ? 999 : 0,
    maxDrawdown: maxDD,
    maxDrawdownPct: maxDDPct,
    avgHoldMin: evaluated > 0 ? holdSum / evaluated : 0,
    expectancy: evaluated > 0 ? netPnl / evaluated : 0,
    avgWin: wins > 0 ? grossWin / wins : 0,
    avgLoss: losses > 0 ? grossLoss / losses : 0,
    largestWin,
    largestLoss,
    longs,
    shorts,
    tradesPerWeek: spanSec > 0 ? evaluated / ((spanSec / 86400) / 7) : 0,
    finalEquity: cash,
    bars: n,
    from: n > warmup ? bars[warmup].time : (bars[0]?.time ?? 0),
    to: bars[n - 1]?.time ?? 0,
    openAtEnd,
    suppressed,
    skippedShorts,
  }
  return { metrics, trades, equity: collectEquity ? equity : [], warmupBars: warmup }
}

// ---------------------------------------------------------------------------
// scoring + grid-search optimizer
// ---------------------------------------------------------------------------

/** Calmar-style composite: net return % over max drawdown %. Runs with fewer
 *  than minTrades are scored -Infinity (listed, never "best"). */
export function backtestScore(m: BacktestMetrics, minTrades: number): number {
  if (m.trades < minTrades) return -Infinity
  const dd = Math.max(m.maxDrawdownPct, 0.5)
  return m.netPct / dd
}

export interface OptimizeRange {
  key: string
  min: number
  max: number
  step: number
  /** Explicit value grid (Task 87 auto-sweep) — when present it REPLACES the
   *  min/max/step arithmetic so a curated value set (defaults guaranteed
   *  included) can be passed without fighting uniform-step reconstruction. */
  values?: number[]
}

export interface OptimizeRow {
  params: Record<string, number>
  score: number
  metrics: BacktestMetrics
}

export interface OptimizeResult {
  results: OptimizeRow[] // top N by score desc
  best: OptimizeRow | null
  totalCombos: number // full grid size before sampling
  evaluated: number // sims actually run
  skipped: number // invalid combos (e.g. oversold ≥ overbought)
  truncated: boolean // grid was stride-sampled to fit the compute budget
  elapsedMs: number
}

const MAX_PER_DIM = 64
const COMBO_BAR_BUDGET = 12_000_000 // ~1-2s of pure-JS sim work

function dimValues(r: OptimizeRange): number[] {
  if (Array.isArray(r.values) && r.values.length > 0) {
    const vals = [...new Set(
      r.values.filter((v) => Number.isFinite(v)).map((v) => Number(v.toFixed(6))),
    )].sort((a, b) => a - b)
    if (vals.length > 0) return vals
  }
  const step = r.step > 0 ? r.step : 1
  const vals: number[] = []
  const count = Math.floor((r.max - r.min) / step + 1e-9) + 1
  const stride = count > MAX_PER_DIM ? Math.ceil(count / MAX_PER_DIM) : 1
  for (let k = 0; k < count; k += stride) {
    const v = Number((r.min + k * step).toFixed(6))
    if (v <= r.max + 1e-9) vals.push(v)
    if (vals.length >= MAX_PER_DIM) break
  }
  if (vals.length === 0) vals.push(r.min)
  return vals
}

function comboInvalid(strategy: AlgoStrategyId, p: Record<string, number>): boolean {
  if (strategy === 'bb-reversion') return p.rsiOversold >= p.rsiOverbought
  if (strategy === 'rsi2-connors') return p.exitSma >= p.trendSma
  return false
}

/**
 * Task 9-p — mid-matrix heap abort (mirrors the reco-matrix guard in
 * algo-reco.ts): POST-time gates cannot see allocations that happen DURING a
 * long grid search / sweep. Probing every combo converts a fatal OOM (the
 * whole dev server dies, user account state and all) into a catchable error
 * the route surfaces as a plain 500 + toast. 0.78 sits between the 0.70
 * POST gate and the 1.0 fatal ceiling.
 */
const MATRIX_HEAP_ABORT = 0.78
function heapAbortCheck(context: string): void {
  const mem = memoryGuard(MATRIX_HEAP_ABORT)
  if (!mem.ok) {
    throw new Error(
      `${context} aborted — heap ${mem.heapUsedMb}MB / ${mem.limitMb}MB cap. ` +
      `Results so far are lost; retry when the server is quieter (close other backtests first).`,
    )
  }
}

export function optimizeBacktest(
  series: BacktestSeries,
  base: BacktestConfig,
  ranges: OptimizeRange[],
  opts?: { minTrades?: number; maxCombos?: number },
): OptimizeResult {
  const t0 = Date.now()
  const minTrades = Math.max(1, Math.round(opts?.minTrades ?? 8))
  // sanitize: known numeric params only, clamped to the strategy's def range
  const def = ALGO_STRATEGIES[base.strategy]
  const defsByKey = new Map(def.params.map((p) => [p.key, p]))
  const clean: OptimizeRange[] = []
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const d = defsByKey.get(String(r?.key))
    if (!d || d.bool) continue
    const hasValues = Array.isArray(r?.values) && r.values.length > 0
    const min = Number(r.min)
    const max = Number(r.max)
    const step = Number(r.step)
    if (!hasValues && (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step))) continue
    if (!hasValues && (max <= min || step <= 0)) continue
    clean.push({
      key: d.key,
      min: Math.min(d.max, Math.max(d.min, min)),
      max: Math.min(d.max, Math.max(d.min, max)),
      step,
      // Task 87 — explicit grids are sanitized to the param's sanctioned span
      ...(hasValues
        ? { values: r.values!.filter((v) => Number.isFinite(v)).map((v) => Math.min(d.max, Math.max(d.min, Number(v.toFixed(6))))) }
        : {}),
    })
  }
  const dims = clean.map((r) => ({ key: r.key, vals: dimValues(r) }))
  const totalCombos = dims.reduce((a, d) => a * d.vals.length, 1)
  const budget = Math.max(60, Math.min(800, opts?.maxCombos ?? Math.floor(COMBO_BAR_BUDGET / Math.max(1, series.n))))
  const stride = totalCombos > budget ? Math.ceil(totalCombos / budget) : 1

  const results: OptimizeRow[] = []
  let evaluated = 0
  let skipped = 0
  const idx = dims.map(() => 0)
  if (totalCombos > 0) {
    for (let combo = 0; combo < totalCombos; combo += stride) {
      // Task 9-p — per-combo heap probe (see heapAbortCheck)
      heapAbortCheck('Optimization')
      // odometer decode
      let rem = combo
      for (let d = 0; d < dims.length; d++) {
        idx[d] = rem % dims[d].vals.length
        rem = Math.floor(rem / dims[d].vals.length)
      }
      const override: Record<string, number> = {}
      for (let d = 0; d < dims.length; d++) override[dims[d].key] = dims[d].vals[idx[d]]
      const params = { ...base.params, ...override }
      if (comboInvalid(base.strategy, params)) {
        skipped++
        continue
      }
      const res = runBacktest(series, { ...base, params, collectEquity: false })
      evaluated++
      results.push({
        params: override,
        score: backtestScore(res.metrics, minTrades),
        metrics: res.metrics,
      })
      // Task 9-l — bounded retention: a dropped row is ranked >160 in its
      // prefix (≥160 better rows exist), so the global top-100 returned below
      // is bit-identical — only the never-listed tail is discarded early.
      if (results.length > 240) {
        results.sort((a, b) => (b.score - a.score) || (b.metrics.netPct - a.metrics.netPct))
        results.length = 160
      }
    }
  }
  results.sort((a, b) => (b.score - a.score) || (b.metrics.netPct - a.metrics.netPct))
  return {
    results: results.slice(0, 100),
    best: results.length > 0 && results[0].score > -Infinity ? results[0] : null,
    totalCombos,
    evaluated,
    skipped,
    truncated: stride > 1,
    elapsedMs: Date.now() - t0,
  }
}

// ---------------------------------------------------------------------------
// strategy sweep (Task 87) — one click tests EVERY strategy: each runs at its
// defaults plus an AUTO-BUILT optimizer grid, and the top X rows across all
// strategies are ranked for the user to apply.
// ---------------------------------------------------------------------------

export interface SweepOos {
  netPct: number
  profitFactor: number
  winRate: number
  maxDrawdownPct: number
  trades: number
}

export interface SweepRow {
  strategy: AlgoStrategyId
  params: Record<string, number> // FULL param set (defaults + overrides)
  score: number
  metrics: BacktestMetrics
  // Task 3-d — walk-forward verification: the SAME row re-run untouched on the
  // out-of-sample tail (null when OOS produced < 3 trades or OOS is off).
  oos?: SweepOos | null
  // Task 3-d — true when ANY tuned param sits on its grid min/max (weakest
  // evidence: the optimum may lie beyond the searched grid).
  boundary?: boolean
}

export interface SweepPerStrategy {
  strategy: AlgoStrategyId
  totalCombos: number // auto grid size before sampling
  evaluated: number // sims actually run (defaults row + sampled combos)
  skipped: number // invalid combos (e.g. oversold ≥ overbought)
  truncated: boolean // grid was stride-sampled to the compute budget
  scorable: number // rows that cleared minTrades
  bestScore: number | null // best Calmar score for this strategy (null = none scorable)
}

export interface SweepResult {
  rows: SweepRow[] // top X across ALL strategies, score desc
  topX: number
  minTrades: number
  evaluated: number
  skipped: number
  elapsedMs: number
  perStrategy: SweepPerStrategy[]
  // Task 3-d — the OOS fraction actually used (0 = walk-forward off) and the
  // total short signals dropped across every sim by the crypto long-only rule.
  oosFraction?: number
  skippedShorts?: number
}

const SWEEP_VALUES_PER_DIM = 5

/**
 * Auto optimizer grid for one strategy (Task 87): EVERY numeric (non-bool)
 * param is swept with up to 5 values spanning the param's sanctioned
 * min..max, and the strategy's DEFAULT value is always one of them — so the
 * untouched configuration is always inside the grid and tuning can only
 * wander through ranges the catalog itself sanctions.
 */
export function autoOptimizeRanges(strategy: AlgoStrategyId): OptimizeRange[] {
  const def = ALGO_STRATEGIES[strategy]
  const out: OptimizeRange[] = []
  for (const p of def.params) {
    if (p.bool) continue
    const count = Math.floor((p.max - p.min) / p.step + 1e-9) + 1
    if (count <= SWEEP_VALUES_PER_DIM) {
      // the whole grid fits — sweep it verbatim (default is on-grid)
      const vals: number[] = []
      for (let k = 0; k < count; k++) vals.push(Number((p.min + k * p.step).toFixed(6)))
      out.push({ key: p.key, min: p.min, max: vals[vals.length - 1], step: p.step, values: vals })
      continue
    }
    // sample SWEEP_VALUES_PER_DIM evenly spaced indices, forcing the
    // default's index in so the setup value can never fall outside the grid
    const di = Math.min(count - 1, Math.max(0, Math.round((def.defaults[p.key] - p.min) / p.step)))
    const idxs = new Set<number>()
    for (let k = 0; k < SWEEP_VALUES_PER_DIM; k++) {
      idxs.add(Math.min(count - 1, Math.max(0, Math.round((k * (count - 1)) / (SWEEP_VALUES_PER_DIM - 1)))))
    }
    idxs.add(di)
    const vals = [...idxs].sort((a, b) => a - b).map((i) => Number((p.min + i * p.step).toFixed(6)))
    out.push({ key: p.key, min: vals[0], max: vals[vals.length - 1], step: p.step, values: vals })
  }
  return out
}

function sweepSig(strategy: AlgoStrategyId, params: Record<string, number>): string {
  return strategy + '|' + Object.entries(params).map(([k, v]) => `${k}=${v}`).sort().join(',')
}

/**
 * One-click sweep (Task 87): for EVERY strategy in the catalog —
 *   1. replay the strategy's DEFAULTS as-is (always a candidate, even when
 *      the optimizer's stride would skip it);
 *   2. run the auto grid-search (autoOptimizeRanges) through the same
 *      budget/stride machinery as the manual optimizer;
 * then dedupe (strategy+params), rank by the Calmar-style score and return
 * the top `topX` rows. Rows that failed minTrades are never listed.
 * The user's cross-cutting config (qty/sizing/TP-SL/session guards/cost
 * model/capital) is held fixed — only strategy params are optimized.
 *
 * Task 3-d — walk-forward (OOS) + boundary flags:
 *   • `oosFraction` (0..0.5, default 0) splits the series at floor(n·(1−f)):
 *     the sweep runs IN-SAMPLE on bars[0..split) (minTrades applies to IS as
 *     always), then each selected row is RE-RUN untouched on the OOS tail
 *     bars[split..n) (warmup from the OOS start) and the row carries `oos`
 *     metrics (null when the OOS window produced < 3 trades).
 *   • every row carries `boundary` — true when any tuned param equals its
 *     grid min/max (the winner sits on the edge of the searched grid).
 */
export function sweepStrategies(
  series: BacktestSeries,
  base: BacktestConfig,
  opts?: { minTrades?: number; topX?: number; maxCombosPerStrategy?: number; oosFraction?: number },
): SweepResult {
  const t0 = Date.now()
  const minTrades = Math.max(1, Math.round(opts?.minTrades ?? 8))
  const topX = Math.min(20, Math.max(1, Math.round(opts?.topX ?? 8)))
  const oosFraction = Math.min(0.5, Math.max(0, Number(opts?.oosFraction) || 0))
  // ---- walk-forward split (Task 3-d) ----
  // IS = the head (tuning window, ALL sweep runs happen here) · OOS = the
  // untouched tail used ONLY to re-verify the selected rows afterwards.
  const split = oosFraction > 0 ? Math.floor(series.n * (1 - oosFraction)) : series.n
  const oosSeries = oosFraction > 0 && split < series.n && series.n - split >= 30
    ? prepareSeries(series.bars.slice(split))
    : null
  const isSeries = oosSeries ? prepareSeries(series.bars.slice(0, split)) : series
  const perStrategy: SweepPerStrategy[] = []
  const candidates: SweepRow[] = []
  let evaluated = 0
  let skipped = 0
  let skippedShorts = 0
  for (const sid of ALGO_STRATEGY_IDS) {
    // Task 9-p — per-strategy heap probe: the sweep runs every strategy's
    // optimizer back-to-back; catch the hot heap BETWEEN strategies (see
    // heapAbortCheck)
    heapAbortCheck('Strategy sweep')
    const def = ALGO_STRATEGIES[sid]
    const cfg: BacktestConfig = { ...base, strategy: sid, params: { ...def.defaults }, collectEquity: false }
    // grid bounds per dim (same sanitized value sets the optimizer uses) —
    // captured BEFORE the runs so every candidate can be boundary-flagged
    const bounds = autoOptimizeRanges(sid).map((r) => {
      const vals = dimValues(r)
      return { key: r.key, min: vals[0], max: vals[vals.length - 1] }
    })
    const onBoundary = (params: Record<string, number>): boolean =>
      bounds.some((b) => {
        const v = params[b.key]
        return v != null && (Math.abs(v - b.min) < 1e-9 || Math.abs(v - b.max) < 1e-9)
      })
    // (1) untouched defaults — always a candidate
    const baseRun = runBacktest(isSeries, cfg)
    evaluated++
    skippedShorts += baseRun.metrics.skippedShorts ?? 0
    const baseScore = backtestScore(baseRun.metrics, minTrades)
    if (baseScore > -Infinity) {
      candidates.push({ strategy: sid, params: { ...def.defaults }, score: baseScore, metrics: baseRun.metrics, boundary: onBoundary(def.defaults) })
    }
    let scorable = baseScore > -Infinity ? 1 : 0
    let bestScore = baseScore > -Infinity ? baseScore : null
    // (2) auto grid search over the strategy's numeric params
    const opt = optimizeBacktest(isSeries, cfg, autoOptimizeRanges(sid), { minTrades, maxCombos: opts?.maxCombosPerStrategy })
    evaluated += opt.evaluated
    skipped += opt.skipped
    for (const row of opt.results) {
      if (!(row.score > -Infinity)) continue
      scorable++
      if (bestScore == null || row.score > bestScore) bestScore = row.score
      skippedShorts += row.metrics.skippedShorts ?? 0
      candidates.push({
        strategy: sid,
        params: { ...def.defaults, ...row.params },
        score: row.score,
        metrics: row.metrics,
        boundary: onBoundary({ ...def.defaults, ...row.params }),
      })
    }
    perStrategy.push({
      strategy: sid,
      totalCombos: opt.totalCombos,
      evaluated: opt.evaluated + 1,
      skipped: opt.skipped,
      truncated: opt.truncated,
      scorable,
      bestScore,
    })
    // Task 9-l — bounded retention across strategies: the final selection only
    // ever needs the global top-20 (topX ≤ 20); rows outside the running
    // top-200 already have ≥200 better rows ahead of them and can never rank.
    if (candidates.length > 300) {
      candidates.sort((a, b) => (b.score - a.score) || (b.metrics.netPct - a.metrics.netPct))
      candidates.length = 200
    }
  }
  // dedupe identical (strategy, params) rows — a grid combo that lands exactly
  // on the defaults would otherwise appear twice with the same score
  const seen = new Set<string>()
  const unique = candidates.filter((r) => {
    const sig = sweepSig(r.strategy, r.params)
    if (seen.has(sig)) return false
    seen.add(sig)
    return true
  })
  unique.sort((a, b) => (b.score - a.score) || (b.metrics.netPct - a.metrics.netPct))
  // ---- walk-forward verification of the SELECTED rows (Task 3-d) ----
  const rows: SweepRow[] = unique.slice(0, topX).map((r) => {
    if (!oosSeries) return { ...r, oos: null }
    const oosCfg: BacktestConfig = { ...base, strategy: r.strategy, params: { ...r.params }, collectEquity: false }
    const oosRun = runBacktest(oosSeries, oosCfg)
    const m = oosRun.metrics
    // < 3 OOS trades is not evidence either way → null, never a lucky 1-2er
    const oos: SweepOos | null = m.trades >= 3
      ? {
          netPct: Number(m.netPct.toFixed(2)),
          profitFactor: Number(m.profitFactor.toFixed(2)),
          winRate: Number(m.winRate.toFixed(1)),
          maxDrawdownPct: Number(m.maxDrawdownPct.toFixed(2)),
          trades: m.trades,
        }
      : null
    return { ...r, oos }
  })
  return {
    rows,
    topX,
    minTrades,
    evaluated,
    skipped,
    elapsedMs: Date.now() - t0,
    perStrategy,
    oosFraction: oosSeries ? oosFraction : 0,
    skippedShorts,
  }
}
