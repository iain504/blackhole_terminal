// Statistical significance audit for the Algo full-feature sweep
// (scripts/algo-top-configs.ts → /tmp/algo-top-configs.json).
//
// Answers: "isn't the number of trades in the backtest too few to prove
// the result?" — with numbers instead of hand-waving.
//
// Part A — replay each delivered top config through the app's own engine and
//          compute per-trade net bps, t-stat, two-sided p, DAY-BLOCK bootstrap
//          95% CI (trades cluster by day, iid bootstrap would understate
//          variance), first-half vs second-half stability, and how many trades
//          the observed edge/σ ratio would need for t ≈ 2.
// Part B — pooled per-strategy evidence across symbols (bigger n; still
//          in-sample and selection-biased — labeled as such).
// Part C — TRUE out-of-sample walk-forward: re-optimize on the first 65% of
//          bars (same grids, same track friction), then trade the last 35%
//          untouched. Unbiased by construction. Pooled OOS = the decisive stat.
//
// Usage: bun scripts/algo-significance.ts   (needs /tmp/algo-top-configs.json)

import { readFileSync } from 'fs'
import {
  prepareSeries,
  runBacktest,
  optimizeBacktest,
  backtestScore,
  type BacktestConfig,
  type OptimizeRange,
  type BacktestResult,
} from '@/lib/backtest'
import {
  ALGO_STRATEGIES,
  normalizeAlgoParams,
  applyRegimePreset,
  type AlgoStrategyId,
  type AlgoTimeframe,
} from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const CAPITAL = 25_000
const NOTIONAL = 5_000
const DAYS = 55
const SPLIT_FRAC = 0.65
const MIN_TRADES_IS = 7
const Z = 1.96
const COSTS = { slippageBps: 2, feeBps: 0.35, spreadBps: 2, dynSlip: true }

// ---- parsed sweep JSON (loose local types) ----
interface JsonTrail { label: string; arm: number | null; give: number | null }
interface JsonCand {
  track: 'research' | 'live'
  strategy: AlgoStrategyId
  tf: AlgoTimeframe
  params: Record<string, number>
  tpMode: 'atr' | 'none'
  tpValue: number
  slValue: number
  cooldown: number
  reqNew: boolean
  trail: JsonTrail
  metrics: { trades: number; netPct: number; winRate: number; profitFactor: number; expectancy: number }
  grossExpBps: number
  score: number
  evaluated: number
}
interface JsonRecord {
  symbol: string
  tf: AlgoTimeframe
  bars: number
  atrBase: number
  qty: number
  winner: JsonCand | null
  all: JsonCand[]
}

// ---- data ----
async function fetchYahoo(symbol: string, tf: AlgoTimeframe): Promise<Bar[]> {
  const interval = tf === '5m' ? '5m' : '15m'
  const end = Date.now()
  const start = end - DAYS * 86400_000
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&period1=${Math.floor(start / 1000)}&period2=${Math.floor(end / 1000)}&includePrePost=false`
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    } catch {
      await sleep(1500)
      continue
    }
    if (res.status === 429) {
      await sleep(2500)
      continue
    }
    if (!res.ok) throw new Error(`yahoo ${res.status}: ${(await res.text()).slice(0, 120)}`)
    const j = (await res.json()) as {
      chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] } }[] }
    }
    const r = j.chart?.result?.[0]
    const ts = r?.timestamp ?? []
    const q = r?.indicators?.quote?.[0]
    const bars: Bar[] = []
    for (let i = 0; i < ts.length; i++) {
      const o = q?.open?.[i], h = q?.high?.[i], l = q?.low?.[i], c = q?.close?.[i]
      if (o == null || h == null || l == null || c == null || c <= 0) continue
      bars.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q?.volume?.[i] ?? 0 })
    }
    bars.sort((a, b) => a.time - b.time)
    return bars
  }
  throw new Error(`yahoo: retries exhausted for ${symbol} ${tf}`)
}

// ---- config builders (mirrors scripts/algo-top-configs.ts exactly) ----
function baseCfg(
  strategy: AlgoStrategyId,
  qty: number,
  params: Record<string, number>,
  tpMode: 'atr' | 'none' = 'atr',
  frictionless = false,
): BacktestConfig {
  return {
    strategy,
    params,
    qty,
    sizingMode: 'fixed',
    riskMoney: null,
    isCrypto: false,
    tpMode,
    tpValue: 2,
    slMode: 'atr',
    slValue: 2,
    trailMode: 'off',
    trailArmPct: null,
    trailGivePct: null,
    maxTradesDay: 4,
    rthOnly: true,
    flattenEod: true,
    cooldownMin: 0,
    requireNewSignal: false,
    capital: CAPITAL,
    slippageBps: frictionless ? 0 : COSTS.slippageBps,
    feeBps: frictionless ? 0 : COSTS.feeBps,
    spreadBps: frictionless ? 0 : COSTS.spreadBps,
    dynSlip: frictionless ? false : COSTS.dynSlip,
    collectEquity: false,
  }
}

function cfgFromJson(c: JsonCand, qty: number, frictionless = false): BacktestConfig {
  return {
    ...baseCfg(c.strategy, qty, c.params, c.tpMode, frictionless),
    tpValue: c.tpValue,
    slValue: c.slValue,
    cooldownMin: c.cooldown,
    requireNewSignal: c.reqNew,
    trailMode: c.trail.arm != null && c.trail.give != null ? 'pct' : 'off',
    trailArmPct: c.trail.arm,
    trailGivePct: c.trail.give,
  }
}

interface TrailVariant { label: string; arm: number | null; give: number | null }

function trailVariants(atrBase: number): TrailVariant[] {
  const mk = (k: number): TrailVariant => {
    const arm = +(Math.min(6, Math.max(0.3, k * atrBase))).toFixed(2)
    const give = +(Math.max(0.15, arm * 0.5)).toFixed(2)
    return { label: `arm ${arm}% / give ${give}%`, arm, give }
  }
  const seen = new Set<string>()
  const out: TrailVariant[] = [{ label: 'off', arm: null, give: null }]
  for (const k of [0.75, 1.5, 2.5, 4, 6]) {
    const v = mk(k)
    const key = `${v.arm}/${v.give}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

const GRIDS: Record<AlgoStrategyId, OptimizeRange[]> = {
  'bb-reversion': [
    { key: 'bbStd', values: [1.6, 2, 2.4, 2.8] },
    { key: 'rsiOversold', values: [20, 25, 30] },
    { key: 'rsiOverbought', values: [70, 75, 80] },
    { key: 'tpValue', values: [2.5, 3.5, 5] },
    { key: 'slValue', values: [2, 3, 4] },
  ],
  'rsi2-connors': [
    { key: 'rsiPeriod', values: [2, 3] },
    { key: 'rsiBuy', values: [5, 10, 15] },
    { key: 'trendSma', values: [50, 100, 150, 200] },
    { key: 'exitSma', values: [3, 5, 10] },
    { key: 'tpValue', values: [2.5, 4, 6] },
    { key: 'slValue', values: [2, 3, 4] },
  ],
  'orb15': [
    { key: 'orMinutes', values: [5, 15, 30, 60] },
    { key: 'orbVolMult', values: [0, 1, 2, 3] },
    { key: 'tpValue', values: [2.5, 4, 6, 8] },
    { key: 'slValue', values: [1.5, 2, 3, 4] },
  ],
  'vwap-fade': [
    { key: 'devPct', values: [0.3, 0.5, 0.8, 1.2, 1.6] },
    { key: 'trendSoftPct', values: [0.5, 1.5, 3] },
    { key: 'tpValue', values: [1.5, 2.5, 3.5] },
    { key: 'slValue', values: [1.5, 2, 3] },
  ],
}

// ---- statistics ----
function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
}
function std(a: number[]): number {
  if (a.length < 2) return NaN
  const m = mean(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))
}
function gammln(xx: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let x = xx
  let y = xx
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200
  const EPS = 3e-12
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}
function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
}
// two-sided p for Student t
function tTestP(t: number, df: number): number {
  if (!Number.isFinite(t) || df < 1) return NaN
  return ibeta(df / 2, 0.5, df / (df + t * t))
}
function tStat(a: number[]): number {
  const s = std(a)
  if (!Number.isFinite(s) || s === 0) return NaN
  return mean(a) / (s / Math.sqrt(a.length))
}

// day-block bootstrap 95% CI of the mean (resample whole trading days —
// preserves intra-day clustering and cross-symbol macro-day correlation in pools)
function bootCI(byDay: number[][], iters = 10_000, seed = 42): [number, number] {
  const D = byDay.length
  const N = byDay.reduce((s, d) => s + d.length, 0)
  if (D < 2 || N === 0) return [NaN, NaN]
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const means: number[] = []
  for (let it = 0; it < iters; it++) {
    let sum = 0
    let cnt = 0
    for (let d = 0; d < D; d++) {
      const pick = byDay[Math.floor(rnd() * D)]
      for (const x of pick) {
        sum += x
        cnt++
      }
    }
    if (cnt > 0) means.push(sum / cnt)
  }
  if (!means.length) return [NaN, NaN]
  means.sort((a, b) => a - b)
  return [means[Math.floor(0.025 * means.length)], means[Math.ceil(0.975 * means.length) - 1]]
}

function dayGroups(trades: BacktestResult['trades']): number[][] {
  const m = new Map<string, number[]>()
  for (const t of trades) {
    const d = new Date(t.entryTime * 1000).toISOString().slice(0, 10)
    const arr = m.get(d) ?? []
    arr.push(t.pnlPct * 100)
    m.set(d, arr)
  }
  return [...m.values()]
}

function splitHalf(byDay: [string, number[]][]): { h1: number; h2: number } {
  const days = byDay.map(([d]) => d).sort()
  const mid = days[Math.floor(days.length / 2)]
  const h1: number[] = []
  const h2: number[] = []
  for (const [d, vals] of byDay) (d < mid ? h1 : h2).push(...vals)
  return { h1: mean(h1), h2: mean(h2) }
}

const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—')

interface Replay {
  rec: JsonRecord
  cand: JsonCand
  bps: number[]
  byDay: [string, number[]][]
  t: number
  p: number
  ci: [number, number]
  halves: { h1: number; h2: number }
  needN: number
}

async function replay(rec: JsonRecord, cand: JsonCand, bars: Bar[]): Promise<Replay> {
  const series = prepareSeries(bars)
  const res = runBacktest(series, cfgFromJson(cand, rec.qty))
  const byDay = [...res.trades.reduce((m, t) => {
    const d = new Date(t.entryTime * 1000).toISOString().slice(0, 10)
    const arr = m.get(d) ?? []
    arr.push(t.pnlPct * 100)
    m.set(d, arr)
    return m
  }, new Map<string, number[]>()).entries()]
  const bps = res.trades.map((t) => t.pnlPct * 100)
  const t = tStat(bps)
  const mu = mean(bps)
  const sd = std(bps)
  return {
    rec,
    cand,
    bps,
    byDay,
    t,
    p: tTestP(t, bps.length - 1),
    ci: bootCI(dayGroups(res.trades)),
    halves: splitHalf(byDay),
    needN: Number.isFinite(mu) && mu > 0 && Number.isFinite(sd) ? Math.ceil(((Z * sd) / mu) ** 2) : NaN,
  }
}

// ---- walk-forward: optimize on first 65%, trade last 35% untouched ----
interface WfResult {
  symbol: string
  tf: AlgoTimeframe
  delivered: { track: string; strategy: AlgoStrategyId }
  chosen: { track: string; strategy: AlgoStrategyId; tpMode: string; tpValue: number; slValue: number; trail: string; re: string }
  isCostedBps: number[]
  oosCostedBps: number[]
  oosTrades: BacktestResult['trades']
  isGrossBps: number[] | null
  oosGrossBps: number[] | null
}

async function walkForward(rec: JsonRecord, pick: JsonCand, bars: Bar[]): Promise<WfResult | null> {
  const iSplit = Math.floor(bars.length * SPLIT_FRAC)
  if (iSplit < 300) return null
  const splitTime = bars[iSplit].time
  const barsIS = bars.slice(0, iSplit)
  const seriesIS = prepareSeries(barsIS)
  const seriesFull = prepareSeries(bars)
  const strategy = pick.strategy
  const tf = rec.tf
  const qty = rec.qty
  const variants = trailVariants(seriesIS.atrBase * 100)
  const fadeStrat = strategy === 'bb-reversion' || strategy === 'vwap-fade'
  const frictionlessTrack = pick.track === 'research'

  type OptOut = Awaited<ReturnType<typeof optimizeBacktest>>
  const bases: { params: Record<string, number> }[] = []
  if (frictionlessTrack) {
    bases.push({ params: normalizeAlgoParams(strategy, applyRegimePreset('research', strategy, tf, {})) })
  } else {
    const liveBase = normalizeAlgoParams(strategy, applyRegimePreset('live', strategy, tf, {}))
    bases.push({ params: liveBase })
    if (fadeStrat) bases.push({ params: normalizeAlgoParams(strategy, { ...liveBase, allowShort: 0 }) })
  }

  let opt: OptOut | null = null
  let optParams: Record<string, number> | null = null
  for (const b of bases) {
    try {
      const o = await optimizeBacktest(seriesIS, baseCfg(strategy, qty, b.params, 'atr', frictionlessTrack), GRIDS[strategy], { minTrades: MIN_TRADES_IS })
      if (o.best && Number.isFinite(o.best.score) && (!opt?.best || o.best.score > opt.best.score)) {
        opt = o
        optParams = b.params
      }
    } catch {
      /* try next base */
    }
  }
  if (!opt?.best || !optParams) return null
  const winParams = normalizeAlgoParams(strategy, { ...optParams, ...opt.best.params })
  const tpV = opt.best.params.tpValue ?? 2
  const slV = opt.best.params.slValue ?? 2

  // bake-off on IS with the track's friction convention
  type Row = { tpMode: 'atr' | 'none'; v: TrailVariant; cooldown: number; reqNew: boolean; score: number }
  const scored: Row[] = []
  for (const tpMode of ['atr', 'none'] as const) {
    for (const re of [
      { cooldown: 0, reqNew: false },
      { cooldown: 60, reqNew: false },
      { cooldown: 0, reqNew: true },
    ]) {
      for (const v of variants) {
        const cfg: BacktestConfig = {
          ...baseCfg(strategy, qty, winParams, tpMode, frictionlessTrack),
          tpValue: tpV,
          slValue: slV,
          cooldownMin: re.cooldown,
          requireNewSignal: re.reqNew,
          trailMode: v.arm != null && v.give != null ? 'pct' : 'off',
          trailArmPct: v.arm,
          trailGivePct: v.give,
        }
        const r = runBacktest(seriesIS, cfg)
        scored.push({ tpMode, v, cooldown: re.cooldown, reqNew: re.reqNew, score: backtestScore(r.metrics, MIN_TRADES_IS) })
      }
    }
  }
  scored.sort((a, b) => b.score - a.score)
  let chosen = scored[0]
  if (!Number.isFinite(chosen.score)) return null
  const plainRow = scored.find((s) => s.v.label === 'off' && s.cooldown === 0 && !s.reqNew)!
  if (chosen.score > 0 && Number.isFinite(plainRow.score) && plainRow.score >= chosen.score * 0.97) chosen = plainRow

  // full-series costed run; split trades at the walk-forward boundary
  const costedCfg: BacktestConfig = {
    ...baseCfg(strategy, qty, winParams, chosen.tpMode, false),
    tpValue: tpV,
    slValue: slV,
    cooldownMin: chosen.cooldown,
    requireNewSignal: chosen.reqNew,
    trailMode: chosen.v.arm != null && chosen.v.give != null ? 'pct' : 'off',
    trailArmPct: chosen.v.arm,
    trailGivePct: chosen.v.give,
  }
  const resCosted = runBacktest(seriesFull, costedCfg)
  const isTrades = resCosted.trades.filter((t) => t.entryTime < splitTime)
  const oosTrades = resCosted.trades.filter((t) => t.entryTime >= splitTime)
  let isGrossBps: number[] | null = null
  let oosGrossBps: number[] | null = null
  if (frictionlessTrack) {
    const resGross = runBacktest(seriesFull, { ...costedCfg, slippageBps: 0, feeBps: 0, spreadBps: 0, dynSlip: false })
    isGrossBps = resGross.trades.filter((t) => t.entryTime < splitTime).map((t) => t.pnlPct * 100)
    oosGrossBps = resGross.trades.filter((t) => t.entryTime >= splitTime).map((t) => t.pnlPct * 100)
  }
  return {
    symbol: rec.symbol,
    tf,
    delivered: { track: pick.track, strategy: pick.strategy },
    chosen: {
      track: pick.track,
      strategy,
      tpMode: chosen.tpMode,
      tpValue: tpV,
      slValue: slV,
      trail: chosen.v.label,
      re: chosen.cooldown > 0 ? 'cd60' : chosen.reqNew ? 'reqNew' : 'plain',
    },
    isCostedBps: isTrades.map((t) => t.pnlPct * 100),
    oosCostedBps: oosTrades.map((t) => t.pnlPct * 100),
    oosTrades,
    isGrossBps,
    oosGrossBps,
  }
}

// ---- main ----
async function main() {
  // sweep JSON = SymbolResult[][] (per symbol → [15m record, 5m record]) — flatten
  const all = (JSON.parse(readFileSync('/tmp/algo-top-configs.json', 'utf8')) as JsonRecord[][]).flat()

  // bars cache — one fetch per (symbol, tf), reused across replay + walk-forward
  const cache = new Map<string, Bar[]>()
  console.log('fetching bars…')
  const pairs = new Set<string>()
  for (const rec of all) pairs.add(`${rec.symbol}|${rec.tf}`)
  for (const p of pairs) {
    const [sym, tf] = p.split('|') as [string, AlgoTimeframe]
    try {
      cache.set(p, await fetchYahoo(sym, tf))
    } catch (e) {
      console.log(`fetch FAIL ${p}: ${String(e).slice(0, 100)}`)
    }
    await sleep(300)
  }

  // ---- Part A: replay every winner (both TFs), report the 10 per-symbol picks ----
  const replays: Replay[] = []
  for (const rec of all) {
    if (!rec.winner) continue
    const bars = cache.get(`${rec.symbol}|${rec.tf}`)
    if (!bars) continue
    replays.push(await replay(rec, rec.winner, bars))
  }
  // per-symbol pick = same rule as the sweep (highest score)
  const picks: Replay[] = []
  for (const sym of [...new Set(all.map((r) => r.symbol))]) {
    const rs = replays.filter((r) => r.rec.symbol === sym).sort((a, b) => b.cand.score - a.cand.score)
    if (rs.length) picks.push(rs[0])
  }

  console.log('\n========== A. SIGNIFICANCE OF THE 10 DELIVERED CONFIGS (net of costs) ==========')
  console.log('SYM  | TF  | STRAT         | TRK |  n | meanbps |   σ |     t |    p   | day-boot 95% CI   | H1/H2 bps     | n for t≈2')
  for (const r of picks) {
    const ci = `[${fmt(r.ci[0], 0)}, ${fmt(r.ci[1], 0)}]`
    const halves = `${fmt(r.halves.h1, 0)}/${fmt(r.halves.h2, 0)}`
    console.log(
      `${r.rec.symbol.padEnd(4)} | ${r.rec.tf.padEnd(3)} | ${r.cand.strategy.padEnd(13)} | ${r.cand.track.slice(0, 4).padEnd(3)} | ${String(r.bps.length).padStart(2)} | ${fmt(mean(r.bps), 1).padStart(7)} | ${fmt(std(r.bps), 0).padStart(3)} | ${fmt(r.t, 2).padStart(5)} | ${r.p < 0.0001 ? '<1e-4' : r.p.toFixed(4)} | ${ci.padEnd(17)} | ${halves.padEnd(13)} | ${String(r.needN).padStart(5)}`,
    )
  }
  const sigCount = picks.filter((r) => r.p < 0.05).length
  const ciZero = picks.filter((r) => r.ci[0] <= 0 && r.ci[1] >= 0).length
  console.log(`→ individually significant at p<0.05: ${sigCount}/10 · CI still contains 0: ${ciZero}/10`)

  // ---- Part B: pooled per-strategy + overall (in-sample, selection-biased) ----
  console.log('\n========== B. POOLED EVIDENCE, all 20 TF-winners (in-sample, selection-biased) ==========')
  console.log('POOL               |  n | meanbps |   σ |     t |    p   | day-boot 95% CI   ')
  const pools: { name: string; reps: Replay[] }[] = []
  for (const s of Object.keys(ALGO_STRATEGIES) as AlgoStrategyId[]) {
    pools.push({ name: s, reps: replays.filter((r) => r.cand.strategy === s) })
  }
  pools.push({ name: 'ALL (20 winners)', reps: replays })
  for (const pool of pools) {
    if (!pool.reps.length) continue
    const byDayMap = new Map<string, number[]>()
    for (const r of pool.reps) for (const [d, vals] of r.byDay) {
      const arr = byDayMap.get(d) ?? []
      arr.push(...vals)
      byDayMap.set(d, arr)
    }
    const bps = pool.reps.flatMap((r) => r.bps)
    const t = tStat(bps)
    const p = tTestP(t, bps.length - 1)
    const ci = bootCI([...byDayMap.values()])
    console.log(
      `${pool.name.padEnd(18)} | ${String(bps.length).padStart(2)} | ${fmt(mean(bps), 1).padStart(7)} | ${fmt(std(bps), 0).padStart(3)} | ${fmt(t, 2).padStart(5)} | ${p < 0.0001 ? '<1e-4' : p.toFixed(4)} | [${fmt(ci[0], 0)}, ${fmt(ci[1], 0)}]`,
    )
  }
  // winner's-curse hurdle: sqrt(2 ln N) for the total combos the sweep evaluated
  let nCombos = 0
  for (const rec of all) for (const c of rec.all) nCombos += c.evaluated + 36
  console.log(`→ sweep evaluated ≈ ${nCombos} combos; max-of-N hurdle for t ≈ √(2·ln N) ≈ ${Math.sqrt(2 * Math.log(nCombos)).toFixed(2)} (upper bound — neighbours are correlated)`)

  // ---- Part C: walk-forward out-of-sample ----
  console.log('\n========== C. WALK-FORWARD OUT-OF-SAMPLE (optimize first 65%, trade last 35% untouched) ==========')
  const wf: WfResult[] = []
  for (const r of picks) {
    const bars = cache.get(`${r.rec.symbol}|${r.rec.tf}`)
    if (!bars) continue
    process.stdout.write(`WF ${r.rec.symbol} ${r.rec.tf} (${r.cand.track}/${r.cand.strategy})…\n`)
    try {
      const w = await walkForward(r.rec, r.cand, bars)
      if (w) wf.push(w)
      else console.log(`  skipped (IS optimize found nothing with ${MIN_TRADES_IS}+ trades)`)
    } catch (e) {
      console.log(`  WF ERROR ${String(e).slice(0, 140)}`)
    }
  }
  console.log('\nSYM  | TF  | IS-chosen config (track/strat/TP/SL/trail/re)        | IS n | IS bps | OOS n | OOS bps | OOS WR% | IS→OOS')
  for (const w of wf) {
    const isM = mean(w.isCostedBps)
    const oosM = mean(w.oosCostedBps)
    const wr = w.oosTrades.length ? (100 * w.oosTrades.filter((t) => t.pnl > 0).length) / w.oosTrades.length : NaN
    const deg = Number.isFinite(isM) && isM !== 0 ? `${(oosM / isM * 100).toFixed(0)}%` : '—'
    const cfgStr = `${w.chosen.track}/${w.chosen.strategy.slice(0, 6)} TP ${w.chosen.tpMode === 'none' ? 'off' : w.chosen.tpValue + 'x'} / SL ${w.chosen.slValue}x ${w.chosen.trail === 'off' ? 'trailOff' : w.chosen.trail} ${w.chosen.re}`
    console.log(
      `${w.symbol.padEnd(4)} | ${w.tf.padEnd(3)} | ${cfgStr.padEnd(52).slice(0, 52)} | ${String(w.isCostedBps.length).padStart(4)} | ${fmt(isM, 0).padStart(6)} | ${String(w.oosCostedBps.length).padStart(5)} | ${fmt(oosM, 1).padStart(7)} | ${fmt(wr, 0).padStart(7)} | ${deg.padStart(6)}`,
    )
  }
  // pooled OOS
  const oosAll = wf.flatMap((w) => w.oosCostedBps)
  const oosByDay = new Map<string, number[]>()
  for (const w of wf) {
    for (const t of w.oosTrades) {
      const d = new Date(t.entryTime * 1000).toISOString().slice(0, 10)
      const arr = oosByDay.get(d) ?? []
      arr.push(t.pnlPct * 100)
      oosByDay.set(d, arr)
    }
  }
  if (oosAll.length) {
    const t = tStat(oosAll)
    const p = tTestP(t, oosAll.length - 1)
    const ci = bootCI([...oosByDay.values()])
    const posSym = wf.filter((w) => mean(w.oosCostedBps) > 0).length
    console.log(`\nPOOLED OOS: n=${oosAll.length} · mean ${fmt(mean(oosAll), 1)} bps · σ ${fmt(std(oosAll), 0)} · t=${fmt(t, 2)} · p=${p < 0.0001 ? '<1e-4' : p.toFixed(4)} · day-boot 95% CI [${fmt(ci[0], 0)}, ${fmt(ci[1], 0)}] · symbols OOS-positive: ${posSym}/${wf.length}`)
    for (const s of Object.keys(ALGO_STRATEGIES) as AlgoStrategyId[]) {
      const ws = wf.filter((w) => w.chosen.strategy === s)
      const bps = ws.flatMap((w) => w.oosCostedBps)
      if (!bps.length) continue
      console.log(`  OOS ${s.padEnd(13)} n=${String(bps.length).padStart(3)} · mean ${fmt(mean(bps), 1)} bps · symbols ${ws.length}`)
    }
  }

  console.log('\ndone.')
}

void main()
