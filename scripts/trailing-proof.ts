// Trailing-stop PROOF harness (v1.98.0) — answers "prove the performance
// before and after trailing applied" with REAL market history replayed through
// the app's OWN backtest engine (src/lib/backtest.ts — the same bar-replay the
// UI uses, incl. its 15s-trail bar discretization parity with the live engine).
//
// For every config the SAME bars are replayed twice — identical strategy,
// params, qty, SL bracket, costs — the ONLY difference being trailMode:
//   BEFORE = 'off'   (strategy exits + catastrophic SL, exactly the pre-1.97 behavior)
//   AFTER  = 'pct'   (arms once a close is in profit ≥ arm%, then closes on a
//                     give-back % from the best price since — v1.97.0 behavior)
// so any metric delta is attributable to the trailing exit alone.
//
// Data: Coinbase Exchange public candles (crypto, keyless) + Yahoo Finance
// chart API (stocks, RTH bars, keyless).
//
// Usage: bun scripts/trailing-proof.ts

import { prepareSeries, runBacktest, type BacktestConfig } from '@/lib/backtest'
import { normalizeAlgoParams, type AlgoStrategyId } from '@/lib/algo-strategies'
import type { Bar, Timeframe } from '@/lib/market-types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

// ---- Coinbase Exchange (crypto, keyless public candles) ----

async function fetchCoinbase(pair: string, tf: Timeframe, days: number): Promise<Bar[]> {
  const granularity = tf === '1m' ? 60 : tf === '5m' ? 300 : 900
  const end = Date.now()
  const start = end - days * 86400_000
  const bars: Bar[] = []
  // 300 candles max per call — walk forward in (300 × tf) windows
  const windowMs = 300 * granularity * 1000
  let cursor = start
  for (let page = 0; page < 120; page++) {
    const wEnd = Math.min(cursor + windowMs, end)
    const url =
      `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${granularity}` +
      `&start=${new Date(cursor).toISOString()}&end=${new Date(wEnd).toISOString()}`
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    } catch (e) {
      throw new Error(`network: ${String(e).slice(0, 100)}`)
    }
    if (res.status === 429) { await sleep(1500); page--; continue }
    if (!res.ok) throw new Error(`coinbase ${res.status}: ${(await res.text()).slice(0, 150)}`)
    const rows = (await res.json()) as number[][] // [time, low, high, open, close, volume]
    if (Array.isArray(rows)) {
      for (const k of rows) {
        const close = k[4]
        if (close > 0) bars.push({ time: k[0], open: k[3], high: k[2], low: k[1], close, volume: k[5] ?? 0 })
      }
    }
    if (wEnd >= end) break
    cursor = wEnd
    await sleep(120)
  }
  bars.sort((a, b) => a.time - b.time)
  return bars
}

// ---- Yahoo Finance (stocks, keyless, RTH bars) ----

async function fetchYahoo(symbol: string, tf: Timeframe, days: number): Promise<Bar[]> {
  const interval = tf === '1m' ? '1m' : tf === '5m' ? '5m' : '15m'
  // explicit window beats `range` — Yahoo's range validator rejects 2mo on 15m,
  // while period1/period2 ≤60d is accepted (5m/15m hard cap ≈ 60 days)
  const end = Date.now()
  const start = end - Math.min(days, 55) * 86400_000
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&period1=${Math.floor(start / 1000)}&period2=${Math.floor(end / 1000)}&includePrePost=false`
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (res.status === 429) { await sleep(2000); return fetchYahoo(symbol, tf, days) }
  if (!res.ok) throw new Error(`yahoo ${res.status}: ${(await res.text()).slice(0, 150)}`)
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

interface Case {
  label: string
  symbol: string
  source: 'binance' | 'yahoo'
  tf: Timeframe
  strategy: AlgoStrategyId
  days: number
  slPct: number
  trails: { arm: number; give: number }[]
}

// The matrix: breakout + mean-reversion, crypto + stocks — chosen so the proof
// shows where trailing HELPS and where it COSTS (honest, not cherry-picked).
const CASES: Case[] = [
  { label: 'BTC breakout (orb15)', symbol: 'BTC-USD', source: 'coinbase', tf: '15m', strategy: 'orb15', days: 60, slPct: 1, trails: [{ arm: 0.5, give: 0.3 }, { arm: 1.0, give: 0.5 }, { arm: 1.5, give: 1.0 }] },
  { label: 'BTC mean-rev (bb-reversion)', symbol: 'BTC-USD', source: 'coinbase', tf: '15m', strategy: 'bb-reversion', days: 60, slPct: 1, trails: [{ arm: 0.5, give: 0.3 }] },
  { label: 'ETH breakout (orb15)', symbol: 'ETH-USD', source: 'coinbase', tf: '15m', strategy: 'orb15', days: 60, slPct: 1, trails: [{ arm: 1.0, give: 0.5 }, { arm: 1.5, give: 1.0 }] },
  { label: 'ETH fade (vwap-fade)', symbol: 'ETH-USD', source: 'coinbase', tf: '15m', strategy: 'vwap-fade', days: 60, slPct: 1, trails: [{ arm: 0.5, give: 0.3 }] },
  { label: 'SOL breakout (orb15)', symbol: 'SOL-USD', source: 'coinbase', tf: '15m', strategy: 'orb15', days: 60, slPct: 1, trails: [{ arm: 1.0, give: 0.5 }, { arm: 1.5, give: 1.0 }] },
  { label: 'AAPL breakout 5m (orb15)', symbol: 'AAPL', source: 'yahoo', tf: '5m', strategy: 'orb15', days: 30, slPct: 1, trails: [{ arm: 0.5, give: 0.3 }, { arm: 1.0, give: 0.5 }] },
  { label: 'AAPL breakout 15m (orb15)', symbol: 'AAPL', source: 'yahoo', tf: '15m', strategy: 'orb15', days: 50, slPct: 1, trails: [{ arm: 0.5, give: 0.3 }, { arm: 1.5, give: 1.0 }] },
  { label: 'TSLA mean-rev (bb-reversion)', symbol: 'TSLA', source: 'yahoo', tf: '15m', strategy: 'bb-reversion', days: 50, slPct: 1, trails: [{ arm: 0.5, give: 0.3 }] },
  { label: 'SPY mean-rev (rsi2-connors)', symbol: 'SPY', source: 'yahoo', tf: '15m', strategy: 'rsi2-connors', days: 50, slPct: 1, trails: [{ arm: 0.5, give: 0.3 }] },
]

function cfgFor(c: Case, trail: { arm: number; give: number } | null, params: Record<string, number>): BacktestConfig {
  return {
    strategy: c.strategy,
    params,
    qty: 10,
    sizingMode: 'fixed',
    riskMoney: null,
    isCrypto: c.source === 'coinbase',
    tpMode: 'none',
    tpValue: null,
    slMode: 'pct',
    slValue: c.slPct,
    trailMode: trail ? 'pct' : 'off',
    trailArmPct: trail?.arm ?? null,
    trailGivePct: trail?.give ?? null,
    maxTradesDay: 3,
    rthOnly: true,
    flattenEod: true,
    cooldownMin: 0,
    requireNewSignal: false,
    capital: 10000,
    slippageBps: 2,
    feeBps: 0,
    spreadBps: 2,
  }
}

interface Mini {
  trades: number
  netPct: number
  netPnl: number
  winRate: number
  pf: number
  maxDDPct: number
  expectancy: number
  avgHoldMin: number
  reasons: Record<string, number>
}

function mini(r: ReturnType<typeof runBacktest>): Mini {
  const reasons: Record<string, number> = {}
  for (const t of r.trades) reasons[t.exitReason] = (reasons[t.exitReason] ?? 0) + 1
  const m = r.metrics
  return {
    trades: m.trades,
    netPct: m.netPct,
    netPnl: m.netPnl,
    winRate: m.winRate,
    pf: m.profitFactor,
    maxDDPct: m.maxDrawdownPct,
    expectancy: m.expectancy,
    avgHoldMin: m.avgHoldMin,
    reasons,
  }
}

const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
const pfS = (v: number) => (v >= 999 ? '∞' : v.toFixed(2))
const holdS = (min: number) => (min < 90 ? `${Math.round(min)}m` : `${(min / 60).toFixed(1)}h`)

interface Row {
  label: string
  trail: string
  bars: number
  before: Mini
  after: Mini
  trailExits: { n: number; avgPct: number }
  reasonShift: string
}

async function main() {
  const rows: Row[] = []
  for (const c of CASES) {
    process.stdout.write(`fetching ${c.symbol} ${c.tf} ${c.days}d (${c.source})… `)
    let bars: Bar[]
    try {
      bars = c.source === 'coinbase' ? await fetchCoinbase(c.symbol, c.tf, c.days) : await fetchYahoo(c.symbol, c.tf, c.days)
    } catch (e) {
      console.log(`FAILED: ${String(e).slice(0, 120)}`)
      continue
    }
    console.log(`${bars.length} bars`)
    if (bars.length < 80) {
      console.log(`  !! ${c.label}: only ${bars.length} bars — skipped`)
      continue
    }
    const series = prepareSeries(bars)
    const params = normalizeAlgoParams(c.strategy, {})
    const before = mini(runBacktest(series, cfgFor(c, null, params)))
    for (const trail of c.trails) {
      const cfg = cfgFor(c, trail, params)
      const after = mini(runBacktest(series, cfg))
      const trailTrades = runBacktest(series, cfg).trades.filter((t) => t.exitReason === 'trailing stop')
      const avgTrailPct = trailTrades.length ? trailTrades.reduce((s, t) => s + t.pnlPct, 0) / trailTrades.length : 0
      const reasonsBoth = new Set([...Object.keys(before.reasons), ...Object.keys(after.reasons)])
      const shift = [...reasonsBoth].map((r) => `${r} ${before.reasons[r] ?? 0}→${after.reasons[r] ?? 0}`).join(' · ')
      rows.push({ label: c.label, trail: `arm ${trail.arm}% / give ${trail.give}%`, bars: bars.length, before, after, trailExits: { n: trailTrades.length, avgPct: avgTrailPct }, reasonShift: shift })
    }
  }

  console.log('\n===== TRAILING PROOF — BEFORE vs AFTER (same bars, same engine, ONLY the trail differs) =====\n')
  for (const r of rows) {
    const dNet = r.after.netPct - r.before.netPct
    const dDD = r.after.maxDDPct - r.before.maxDDPct
    console.log(`■ ${r.label}   [${r.trail}] · ${r.bars} bars`)
    console.log(`   BEFORE (trail off): ${r.before.trades} trades · net ${fmtPct(r.before.netPct)} ($${r.before.netPnl.toFixed(0)}) · WR ${r.before.winRate.toFixed(0)}% · PF ${pfS(r.before.pf)} · maxDD ${r.before.maxDDPct.toFixed(2)}% · exp $${r.before.expectancy.toFixed(2)}/tr · hold ${holdS(r.before.avgHoldMin)}`)
    console.log(`   AFTER  (trail on) : ${r.after.trades} trades · net ${fmtPct(r.after.netPct)} ($${r.after.netPnl.toFixed(0)}) · WR ${r.after.winRate.toFixed(0)}% · PF ${pfS(r.after.pf)} · maxDD ${r.after.maxDDPct.toFixed(2)}% · exp $${r.after.expectancy.toFixed(2)}/tr · hold ${holdS(r.after.avgHoldMin)}`)
    console.log(`   DELTA             : net ${fmtPct(dNet)} (${dNet >= 0 ? 'BETTER' : 'WORSE'}) · maxDD ${dDD <= 0 ? `-${Math.abs(dDD).toFixed(2)}pp smaller` : `+${dDD.toFixed(2)}pp larger`} · PF ${pfS(r.after.pf)} vs ${pfS(r.before.pf)}`)
    console.log(`   trailing exits    : ${r.trailExits.n} closed by the trail, avg ${fmtPct(r.trailExits.avgPct)} each`)
    console.log(`   exit reasons      : ${r.reasonShift}`)
    console.log('')
  }

  if (rows.length > 0) {
    const n = rows.length
    const fired = rows.filter((r) => r.trailExits.n > 0)
    const improved = rows.filter((r) => r.after.netPct > r.before.netPct).length
    const ddBetter = rows.filter((r) => r.after.maxDDPct < r.before.maxDDPct).length
    const avgNetDelta = rows.reduce((s, r) => s + (r.after.netPct - r.before.netPct), 0) / n
    const avgDDBefore = rows.reduce((s, r) => s + r.before.maxDDPct, 0) / n
    const avgDDAfter = rows.reduce((s, r) => s + r.after.maxDDPct, 0) / n
    console.log('===== AGGREGATE =====')
    console.log(`configs tested: ${n} · net improved on ${improved}/${n} · max drawdown shrank on ${ddBetter}/${n}`)
    console.log(`avg net delta ${fmtPct(avgNetDelta)} per config · avg maxDD ${avgDDBefore.toFixed(2)}% → ${avgDDAfter.toFixed(2)}%`)
    console.log(`trail actually FIRED on ${fired.length}/${n} rows (the rest: strategy exits beat the arm threshold — zero impact by construction)`)
    if (fired.length > 0) {
      const expBetter = fired.filter((r) => r.after.expectancy > r.before.expectancy).length
      const wrBetter = fired.filter((r) => r.after.winRate > r.before.winRate).length
      const pfBetter = fired.filter((r) => r.after.pf > r.before.pf).length
      const expB = fired.reduce((s, r) => s + r.before.expectancy, 0) / fired.length
      const expA = fired.reduce((s, r) => s + r.after.expectancy, 0) / fired.length
      const wrB = fired.reduce((s, r) => s + r.before.winRate, 0) / fired.length
      const wrA = fired.reduce((s, r) => s + r.after.winRate, 0) / fired.length
      const holdB = fired.reduce((s, r) => s + r.before.avgHoldMin, 0) / fired.length
      const holdA = fired.reduce((s, r) => s + r.after.avgHoldMin, 0) / fired.length
      console.log(`WHERE THE TRAIL FIRED (${fired.length} rows): expectancy improved ${expBetter}/${fired.length} (avg $${expB.toFixed(2)} → $${expA.toFixed(2)}/trade) · win rate improved ${wrBetter}/${fired.length} (avg ${wrB.toFixed(1)}% → ${wrA.toFixed(1)}%) · PF improved ${pfBetter}/${fired.length} · avg hold ${holdS(holdB)} → ${holdS(holdA)}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
