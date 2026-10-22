// Task 62 smoke test — backtest engine sanity on SYNTHETIC bars (no network).
// Run: bun scripts-tmp/backtest-smoke.ts
import { prepareSeries, runBacktest, optimizeBacktest, type BacktestConfig } from '../src/lib/backtest'
import type { Bar } from '../src/lib/market-types'

// ---------- synthetic data ----------
// 10 trading days of 5m RTH bars (09:30-16:00 ET). We build bars in UTC such
// that 14:30 UTC = 09:30 EST (winter). Day d: base date 2026-01-05 (Mon).
const base = Date.UTC(2026, 0, 5, 14, 30) / 1000 // Mon Jan 5 2026 09:30 ET
const bars: Bar[] = []
let price = 100
const rnd = (() => { let s = 42; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()
for (let d = 0; d < 20; d++) {
  const dayStart = base + d * 86400
  const dow = new Date(dayStart * 1000).getUTCDay()
  if (dow === 0 || dow === 6) continue // skip weekends
  const mode = d % 4 // 0-1 range, 2 trend up, 3 trend down
  for (let k = 0; k < 78; k++) {
    const t = dayStart + k * 300
    // shape: sine for range days, drift for trend days
    let drift = 0
    if (mode === 2) drift = 0.06
    if (mode === 3) drift = -0.06
    const wave = mode === 2 || mode === 3 ? 0 : Math.sin(k / 5.5) * 0.9
    const open = price
    price = price + drift + wave + (rnd() - 0.5) * 0.25
    const close = price
    const hi = Math.max(open, close) + rnd() * 0.12
    const lo = Math.min(open, close) - rnd() * 0.12
    bars.push({ time: t, open, high: hi, low: lo, close, volume: 800 + Math.round(rnd() * 400) })
  }
}
console.log(`synthetic bars: ${bars.length}`)

const series = prepareSeries(bars)

const baseCfg: BacktestConfig = {
  strategy: 'bb-reversion',
  params: { bbPeriod: 20, bbStd: 2, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, allowShort: 1 },
  qty: 10, sizingMode: 'fixed' as const, riskMoney: null, isCrypto: false,
  tpMode: 'pct', tpValue: 1.5,
  slMode: 'pct', slValue: 1,
  maxTradesDay: 3,
  rthOnly: true,
  flattenEod: true,
  cooldownMin: 0,
  requireNewSignal: false,
  capital: 10000,
}

// ---- 1. bb-reversion on range days ----
const bb = runBacktest(series, baseCfg)
console.log('\n[bb-reversion]', JSON.stringify(bb.metrics, (k, v) => (k === 'from' || k === 'to' ? new Date(v * 1000).toISOString().slice(0, 16) : v), 1))
console.log('trades:', bb.trades.length, 'first 3:', bb.trades.slice(0, 3).map((t) => `${t.side} ${t.entryPx.toFixed(2)}->${t.exitPx.toFixed(2)} ${t.exitReason} pnl=${t.pnl.toFixed(2)}`))

// ---- 2. rsi2-connors on trend days ----
const r2 = runBacktest(series, { ...baseCfg, strategy: 'rsi2-connors', params: { rsiPeriod: 2, rsiBuy: 15, trendSma: 50, exitSma: 5 }, tpMode: 'none', tpValue: null })
console.log('\n[rsi2]', { trades: r2.metrics.trades, winRate: r2.metrics.winRate.toFixed(1), net: r2.metrics.netPnl.toFixed(2), pf: r2.metrics.profitFactor.toFixed(2) })
console.log('first 3:', r2.trades.slice(0, 3).map((t) => `${t.side} @${t.entryPx.toFixed(2)} -> ${t.exitReason} pnl=${t.pnl.toFixed(2)}`))

// ---- 3. orb15 ----
const orb = runBacktest(series, { ...baseCfg, strategy: 'orb15', params: { orMinutes: 15, onePerSide: 1 }, tpMode: 'pct', tpValue: 0.8, slValue: 0.5 })
console.log('\n[orb15]', { trades: orb.metrics.trades, winRate: orb.metrics.winRate.toFixed(1), net: orb.metrics.netPnl.toFixed(2), suppressed: orb.metrics.suppressed })
// per-day entry cap: <= 2 trades per day when onePerSide
const perDay = new Map<string, number>()
for (const t of orb.trades) {
  const dk = new Date(t.entryTime * 1000).toISOString().slice(0, 10)
  perDay.set(dk, (perDay.get(dk) ?? 0) + 1)
}
console.log('per-day entry counts (must be <=2 with onePerSide):', [...perDay.values()])

// ---- 4. vwap-fade ----
const vf = runBacktest(series, { ...baseCfg, strategy: 'vwap-fade', params: { devPct: 0.25, allowShort: 1 }, tpMode: 'none', tpValue: null })
console.log('\n[vwap-fade]', { trades: vf.metrics.trades, winRate: vf.metrics.winRate.toFixed(1), net: vf.metrics.netPnl.toFixed(2) })

// ---- 5. maxTradesDay respected (cap 1) ----
const capped = runBacktest(series, { ...baseCfg, maxTradesDay: 1 })
const perDayCap = new Map<string, number>()
for (const t of capped.trades) {
  const dk = new Date(t.entryTime * 1000).toISOString().slice(0, 10)
  perDayCap.set(dk, (perDayCap.get(dk) ?? 0) + 1)
}
console.log('\n[maxTradesDay=1] max per day (must be <=1):', Math.max(0, ...[...perDayCap.values()]), 'trades:', capped.metrics.trades)

// ---- 6. optimizer grid (bbStd 1.5-2.5 x rsiOs 20-35) ----
const opt = optimizeBacktest(series, baseCfg, [
  { key: 'bbStd', min: 1.5, max: 2.5, step: 0.25 },
  { key: 'rsiOversold', min: 20, max: 35, step: 5 },
], { minTrades: 5 })
console.log('\n[optimize]', { total: opt.totalCombos, evaluated: opt.evaluated, skipped: opt.skipped, truncated: opt.truncated, ms: opt.elapsedMs })
console.log('top 3:', opt.results.slice(0, 3).map((r) => ({ p: r.params, score: r.score.toFixed(2), net: r.metrics.netPct.toFixed(2), trades: r.metrics.trades })))

// ---- 7. equity curve monotonic-ish + DD sane ----
let peakEq = -Infinity
let ddOk = true
for (const pt of bb.equity) {
  if (pt.equity > peakEq) peakEq = pt.equity
  if (pt.equity > peakEq + 1e-9) ddOk = false
}
console.log('\nequity points:', bb.equity.length, 'never-above-peak:', ddOk, 'final≈metrics.finalEquity:', Math.abs(bb.equity[bb.equity.length - 1].equity - bb.metrics.finalEquity) < 1e-6)

// ---- 8. perf guard: 40k-bar series × 200 combos ----
const bigBars: Bar[] = []
let p2 = 100
for (let i = 0; i < 40000; i++) {
  const t = base + i * 300
  p2 += Math.sin(i / 9) * 0.4 + (rnd() - 0.5) * 0.2
  bigBars.push({ time: t, open: p2, high: p2 + 0.1, low: p2 - 0.1, close: p2 + (rnd() - 0.5) * 0.15, volume: 1000 })
}
const bigSeries = prepareSeries(bigBars)
const t0 = Date.now()
const optBig = optimizeBacktest(bigSeries, baseCfg, [
  { key: 'bbStd', min: 1, max: 4, step: 0.1 },
  { key: 'bbPeriod', min: 10, max: 60, step: 2 },
  { key: 'rsiOversold', min: 10, max: 40, step: 2 },
], {})
console.log(`\n[perf] 40k bars, grid ${optBig.totalCombos} (evaluated ${optBig.evaluated}): ${Date.now() - t0}ms wall`)
console.log('OK')
