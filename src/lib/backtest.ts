// Backtest engine (Task 62) — pure, synchronous bar-replay simulator for the
// Algo strategies, plus a grid-search parameter optimizer.
//
// PARITY CONTRACT with the live engine (src/lib/algo-engine.ts):
//   • the decision rules below MUST mirror evalStrategy() exactly — the same
//     comparisons, thresholds and exit strings (rsi2's RSI reads the LAST rp
//     changes, orb15 marks one-per-side on entry — keep both sides in sync);
//   • day accumulators (session VWAP / opening range) consume only the current
//     ET day's REGULAR-session bars, reset on every ET day change;
//   • exits resolve BEFORE entries on the same bar (an exit + fresh entry can
//     both execute, like the live cycle).
//
// EXECUTION MODEL (documented assumptions — no slippage/fees/commission):
//   • strategy exits decided on a bar close fill at that bar's CLOSE (the live
//     engine market-orders seconds after the close);
//   • entry signals fill at the NEXT bar's OPEN (conservative for close-driven
//     systems) — % TP/SL legs derive from the FILL price;
//   • TP/SL are resting brackets: checked intrabar against every bar's high/
//     low INCLUDING the entry bar; when both could hit in one bar the STOP is
//     assumed first (worst case);
//   • flattenEod closes the position at the first bar opening at/after 15:45
//     ET (fill at that bar's close) and suppresses entries from 15:45 ET;
//   • rthOnly gates entries to regular-session bars (exits/brackets run 24h,
//     like the live engine);
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
import { sessionOf, etDateKey, etMinutesOfDay } from '@/lib/sessions'
import { ALGO_STRATEGIES, normalizeAlgoParams, type AlgoStrategyId } from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'

const EOD_FLATTEN_MIN = 15 * 60 + 45 // 15:45 ET — same as the live engine
const RTH_START_MIN = 9 * 60 + 30

export interface BacktestConfig {
  strategy: AlgoStrategyId
  params: Record<string, number>
  qty: number
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

  // warmup: bars needed before the first decision
  let warmup = 1
  if (strategy === 'bb-reversion') warmup = Math.max(5, Math.round(params.bbPeriod ?? 20)) + 2
  if (strategy === 'rsi2-connors') warmup = Math.max(10, Math.round(params.trendSma ?? 200)) + 2

  // ---- Wilder RSI (bb-reversion) — one incremental pass, O(1)/bar ----
  // (live re-seeds from its rolling window start; after ~3×period bars both
  // converge to the same steady state — backtest seeds from history start)
  let rsiArr: Float64Array | null = null
  if (strategy === 'bb-reversion') {
    const rp = Math.max(2, Math.round(params.rsiPeriod ?? 14))
    const arr = new Float64Array(n).fill(Number.NaN)
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
  let peak = cfg.capital
  let maxDD = 0
  let maxDDPct = 0
  let tradesToday = 0
  let curDay = -1
  let suppressed = 0
  // re-entry control (Task 70-c)
  let cooldownUntil: number | null = null // bar-time seconds — no entries before this
  let prevLongSig = false // raw entry signal on the previously decided bar
  let prevShortSig = false
  const trades: BacktestTrade[] = []
  const equity: { t: number; equity: number }[] = [{ t: bars[0]?.time ?? 0, equity: cash }]

  const closeTrade = (p: Pos, exitPx: number, exitTime: number, reason: string) => {
    const dir = p.side
    const pnl = (exitPx - p.entryPx) * p.qty * dir
    cash += pnl
    equity.push({ t: exitTime, equity: cash })
    if (cash > peak) peak = cash
    const dd = peak - cash
    if (dd > maxDD) {
      maxDD = dd
      maxDDPct = peak > 0 ? (dd / peak) * 100 : 0
    }
    // cooldown gate: block entries for N minutes after ANY position close
    // (wall-clock equivalent: bar timestamps — a signal bar may not OPEN
    // before the cooldown expires)
    if (cfg.cooldownMin > 0) cooldownUntil = exitTime + cfg.cooldownMin * 60
    trades.push({
      entryTime: p.entryTime,
      exitTime,
      side: dir === 1 ? 'long' : 'short',
      qty: p.qty,
      entryPx: p.entryPx,
      exitPx,
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
    // ---- feed day accumulators (regular-session bars only) ----
    if (rth[i] === 1) {
      const typ = (bar.high + bar.low + bar.close) / 3
      if (strategy === 'vwap-fade') {
        vwapNum += typ * bar.volume
        vwapDen += bar.volume
      }
      if (strategy === 'orb15' && !orDone) {
        const m = minutes[i]
        if (m >= RTH_START_MIN && m < RTH_START_MIN + orMinutes) {
          orHigh = orHigh == null ? bar.high : Math.max(orHigh, bar.high)
          orLow = orLow == null ? bar.low : Math.min(orLow, bar.low)
        } else if (m >= RTH_START_MIN + orMinutes && orHigh != null && orLow != null) {
          orDone = true
        }
      }
    }

    if (i < warmup) continue

    // ---- 1) fill the pending entry at THIS bar's open ----
    if (pending && Number.isFinite(bar.open) && bar.open > 0) {
      const fill = bar.open
      const dir = pending.side
      const pctPx = (v: number | null, tp: boolean): number | null => {
        if (v == null || !(v > 0)) return null
        const p = Math.min(100, Math.max(0.01, Math.abs(v)))
        const profitSide = tp ? dir === 1 : dir === -1
        const px = profitSide ? fill * (1 + p / 100) : fill * (1 - p / 100)
        return px > 0 ? px : null
      }
      pos = {
        side: dir,
        qty: cfg.qty,
        entryPx: fill,
        entryTime: bar.time,
        tpPx: cfg.tpMode === 'pct' ? pctPx(cfg.tpValue, true) : null,
        slPx: cfg.slMode === 'pct' ? pctPx(cfg.slValue, false) : null,
      }
      pending = null
    }

    // ---- 2) resting TP/SL intrabar (stop assumed first — worst case) ----
    if (pos) {
      let exitPx: number | null = null
      let reason = ''
      if (pos.side === 1) {
        if (pos.slPx != null && bar.low <= pos.slPx) {
          exitPx = pos.slPx
          reason = 'stop loss'
        } else if (pos.tpPx != null && bar.high >= pos.tpPx) {
          exitPx = pos.tpPx
          reason = 'take profit'
        }
      } else {
        if (pos.slPx != null && bar.high >= pos.slPx) {
          exitPx = pos.slPx
          reason = 'stop loss'
        } else if (pos.tpPx != null && bar.low <= pos.tpPx) {
          exitPx = pos.tpPx
          reason = 'take profit'
        }
      }
      if (exitPx != null) {
        closeTrade(pos, exitPx, bar.time, reason)
        pos = null
      }
    }

    // ---- 3) EOD flatten (any session, like the live engine's clock gate) ----
    if (pos && cfg.flattenEod && minutes[i] >= EOD_FLATTEN_MIN) {
      closeTrade(pos, bar.close, bar.time, 'EOD flatten')
      pos = null
    }

    // ---- 4) evaluate the strategy on this closed bar (exits → entries) ----
    const dec = decide(i)
    if (dec.exit && pos) {
      closeTrade(pos, bar.close, bar.time, dec.exit)
      pos = null
    }
    if (dec.entry && !pos && !pending) {
      // gates (mirrored from the engine's entry path) + re-entry control
      const cooldownBlocked = cooldownUntil != null && bar.time < cooldownUntil
      const edgeBlocked = cfg.requireNewSignal && (
        (dec.entry.side === 'buy' && prevLongSig) ||
        (dec.entry.side === 'sell' && prevShortSig))
      if (cfg.rthOnly && rth[i] !== 1) suppressed++
      else if (cfg.flattenEod && minutes[i] >= EOD_FLATTEN_MIN) suppressed++
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
    // per-side signal memory — updated on EVERY decided bar (regardless of
    // gates/outcomes) so the fresh-signal edge fires only on false→true
    prevLongSig = dec.entry?.side === 'buy'
    prevShortSig = dec.entry?.side === 'sell'
  }

  // ---- position still open at the end of data → mark to market ----
  let openAtEnd = false
  if (pos) {
    const lastBar = bars[n - 1]
    closeTrade(pos, lastBar.close, lastBar.time, 'open at end of data (marked)')
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
  }
  return { metrics, trades, equity, warmupBars: warmup }
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
    const min = Number(r.min)
    const max = Number(r.max)
    const step = Number(r.step)
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) continue
    if (max <= min || step <= 0) continue
    clean.push({
      key: d.key,
      min: Math.min(d.max, Math.max(d.min, min)),
      max: Math.min(d.max, Math.max(d.min, max)),
      step,
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
      const res = runBacktest(series, { ...base, params })
      evaluated++
      results.push({
        params: override,
        score: backtestScore(res.metrics, minTrades),
        metrics: res.metrics,
      })
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
