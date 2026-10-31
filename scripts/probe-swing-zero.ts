// PROBE (v2.2.1) — "For Swing Trade backtest, no symbol can backtest and have
// trade in result." Reproduce the exact wizard→route→engine path for the
// swing lane and attribute every entry blocker:
//   1. bar fetch (n, bars/day, window) through the app's own getBars pipeline
//   2. runBacktest with the route's exact swing config (both strategies)
//   3. gate attribution on zero-trade runs: warmup vs kt<0 vs kt<trendLen vs
//      trend bias vs mid-RSI band vs entry-TF RSI trigger
// Run: bun scripts/probe-swing-zero.ts
import { getBars } from '../src/lib/alpaca'
import { db } from '../src/lib/db'
import { resolveAppSecret } from '../src/lib/app-secret'
import { prepareSeries, runBacktest, type BacktestConfig } from '../src/lib/backtest'
import { ALGO_MAX_DAYS, normalizeAlgoParams } from '../src/lib/algo-strategies'
import { MTF_MID_TF, MTF_TREND_TF } from '../src/lib/algo-strategies'
import { aggregateBars, htfIndexAt } from '../src/lib/mtf'
import { TIMEFRAMES, type Timeframe } from '../src/lib/market-types'

// mirror the engine's Wilder RSI seed (same loop shape as runBacktest)
function wilderRsi(closes: number[], rp: number): Float64Array {
  const n = closes.length
  const arr = new Float64Array(n).fill(Number.NaN)
  let ag = 0
  let al = 0
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1]
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
  return arr
}

function buildCfg(strategy: 'swing-pullback' | 'htf-level-bounce', symbol: string, tf: '1h' | '4h' | '1D'): BacktestConfig {
  const params = normalizeAlgoParams(strategy, {})
  return {
    strategy,
    params,
    qty: 10,
    sizingMode: 'fixed',
    riskMoney: null,
    isCrypto: symbol.includes('/'),
    tpMode: 'none',
    tpValue: null,
    slMode: 'pct',
    slValue: 2,
    trailMode: 'off',
    trailArmPct: null,
    trailGivePct: null,
    maxTradesDay: 0,
    rthOnly: false,
    flattenEod: false,
    cooldownMin: 0,
    requireNewSignal: false,
    capital: 10000,
    slippageBps: 2,
    feeBps: 1,
    spreadBps: 2,
    dynSlip: true,
    collectEquity: false,
    mtf: { trendTf: MTF_TREND_TF[tf], midTf: MTF_MID_TF[tf] },
  }
}

// replicate the engine's swing-pullback entry gates per bar and count where
// entries die (only meaningful on the evaluable window i >= warmup)
function attribute(bars: ReturnType<typeof prepareSeries>['bars'], warmup: number, tf: '1h' | '4h' | '1D', strategy: 'swing-pullback' | 'htf-level-bounce') {
  const trendSec = TIMEFRAMES[MTF_TREND_TF[tf] as Timeframe].seconds
  const midSec = TIMEFRAMES[MTF_MID_TF[tf] as Timeframe].seconds
  const trendAgg = aggregateBars(bars, trendSec)
  const midAgg = aggregateBars(bars, midSec)
  const tps = new Float64Array(trendAgg.length + 1)
  for (let k = 0; k < trendAgg.length; k++) tps[k + 1] = tps[k] + trendAgg[k].close
  const midRsi = wilderRsi(midAgg.map((b) => b.close), 14)
  const entryRsi = wilderRsi(bars.map((b) => b.close), 14)
  const closes = bars.map((b) => b.close)
  const trendLen = 50
  let ktNeg = 0
  let ktShort = 0
  let trendOk = 0
  let trendOkDown = 0
  let midOk = 0
  let trigOk = 0
  let fullOk = 0
  let evaluable = 0
  for (let i = warmup; i < bars.length; i++) {
    evaluable++
    const kt = htfIndexAt(bars[i].time, trendAgg, trendSec)
    const km = htfIndexAt(bars[i].time, midAgg, midSec)
    if (kt < 0 || km < 0) { ktNeg++; continue }
    if (kt < trendLen) { ktShort++; continue }
    const smaT = (tps[kt + 1] - tps[kt + 1 - trendLen]) / trendLen
    const tClose = trendAgg[kt].close
    const up = tClose > smaT
    const down = tClose < smaT
    if (!up && !down) continue
    if (up) trendOk++
    if (down) trendOkDown++
    const mv = midRsi[km]
    const midPass = Number.isFinite(mv) && mv >= 40 && mv <= 70
    if (!midPass) continue
    midOk++
    const rv = entryRsi[i]
    if (!Number.isFinite(rv)) continue
    if (up && rv < 40) fullOk++
    else if (down && rv > 60) fullOk++
  }
  void closes
  return { evaluable, ktNeg, ktShort, trendOk, trendOkDown, midOk, fullOk, trendBars: trendAgg.length, midBars: midAgg.length }
}

async function main() {
  await resolveAppSecret()
  // stocks need Alpaca keys (a user with saved keys or env); crypto majors
  // stream keyless from Binance — so with no keyed user we still exercise the
  // full engine path on crypto symbols with a dummy cache-owner id.
  const users = await db.user.findMany({ take: 20 })
  const keyed = users.find((x) => {
    const s = (x.settings as { alpacaPaperKeyIdEnc?: string; alpacaKeyIdEnc?: string } | null) || null
    return !!(s?.alpacaPaperKeyIdEnc || s?.alpacaKeyIdEnc)
  })
  const uid = keyed?.id ?? 'probe-swing-zero'

  const cases: { sym: string; tf: '1h' | '4h' | '1D'; days: number }[] = []
  for (const sym of keyed ? ['TSLA', 'AAPL', 'BTC/USD'] : ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
    for (const tf of ['1h', '4h', '1D'] as const) {
      cases.push({ sym, tf, days: 180 }) // the OLD wizard seed (pre-v2.2.2)
      cases.push({ sym, tf, days: ALGO_MAX_DAYS[tf] }) // the maximum the route allows
    }
    cases.push({ sym, tf: '1D', days: 90 }) // guaranteed starved → zeroTrade banner path
  }

  for (const c of cases) {
    let res
    try {
      res = await getBars(c.sym, c.tf as Timeframe, uid, { lookbackDays: c.days })
    } catch (e) {
      console.log(`${c.sym} ${c.tf} ${c.days}d — getBars THREW: ${e instanceof Error ? e.message : e}`)
      continue
    }
    const bars = res.bars
    const tag = `${c.sym.padEnd(8)} ${c.tf.padEnd(2)} ${String(c.days).padStart(4)}d`
    if (res.demo || bars.length < 80) {
      console.log(`${tag} — bars=${bars.length} demo=${res.demo} truncated=${res.truncated ?? false} (route would 400)`)
      continue
    }
    const spanDays = (bars[bars.length - 1].time - bars[0].time) / 86400
    const perDay = (bars.length / Math.max(1, spanDays)).toFixed(2)
    const series = prepareSeries(bars)
    const lines: string[] = []
    for (const strat of ['swing-pullback', 'htf-level-bounce'] as const) {
      const r = runBacktest(series, buildCfg(strat, c.sym, c.tf))
      const evaluable = bars.length - r.warmupBars
      lines.push(`${strat}: warmup=${r.warmupBars} evaluable=${evaluable} trades=${r.metrics.trades} (L${r.metrics.longs}/S${r.metrics.shorts}) supp=${r.metrics.suppressed} skipShort=${r.metrics.skippedShorts ?? 0}`)
      if (r.metrics.trades === 0) {
        const z = r.metrics.zeroTrade
        lines.push(`    zeroTrade[${z?.code}]: ${z?.message ?? '(no reason given)'}`)
      }
      if (r.metrics.trades === 0 && evaluable > 0) {
        const a = attribute(bars, r.warmupBars, c.tf, strat)
        lines.push(`    gates: evaluable=${a.evaluable} kt<0=${a.ktNeg} kt<trendLen=${a.ktShort} trendUpBars=${a.trendOk} trendDownBars=${a.trendOkDown} midOk=${a.midOk} trigOk=${a.fullOk} | trendBars=${a.trendBars} midBars=${a.midBars}`)
      }
    }
    console.log(`${tag} — bars=${bars.length} (~${perDay}/day) src=${res.source ?? res.reason ?? '-'}`)
    for (const l of lines) console.log('   ' + l)
  }
}

main()
  .catch((e) => { console.error('probe failed:', e); process.exitCode = 1 })
  .finally(() => db.$disconnect())
