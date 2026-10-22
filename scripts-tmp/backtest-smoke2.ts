// Task 62 smoke #2 — FAVORABLE case: strictly mean-reverting (bounded) series
// → range-fade strategies should produce healthy win rates & strategy exits.
import { prepareSeries, runBacktest, type BacktestConfig } from '../src/lib/backtest'
import type { Bar } from '../src/lib/market-types'

const base = Date.UTC(2026, 0, 5, 14, 30) / 1000
const bars: Bar[] = []
const rnd = (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()
let k = 0
for (let d = 0; d < 30; d++) {
  const dayStart = base + d * 86400
  const dow = new Date(dayStart * 1000).getUTCDay()
  if (dow === 0 || dow === 6) continue
  for (let j = 0; j < 78; j++, k++) {
    const t = dayStart + j * 300
    // bounded oscillation around 100 — no accumulated drift
    const price = 100 + Math.sin(k / 5.5) * 0.9 + Math.sin(k / 23) * 1.4
    const open = k === 0 ? price : bars[bars.length - 1].close
    const close = price
    bars.push({ time: t, open, high: Math.max(open, close) + rnd() * 0.1, low: Math.min(open, close) - rnd() * 0.1, close, volume: 900 })
  }
}
console.log(`bars: ${bars.length}, close range: ${Math.min(...bars.map((b) => b.close)).toFixed(2)}–${Math.max(...bars.map((b) => b.close)).toFixed(2)}`)
const series = prepareSeries(bars)

const cfg: BacktestConfig = {
  strategy: 'bb-reversion',
  params: { bbPeriod: 20, bbStd: 2, rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 65, allowShort: 1 },
  qty: 10, sizingMode: 'fixed' as const, riskMoney: null, isCrypto: false, tpMode: 'pct', tpValue: 1.2, slMode: 'pct', slValue: 1.2,
  maxTradesDay: 3, rthOnly: true, flattenEod: true, cooldownMin: 0, requireNewSignal: false, capital: 10000,
}
const bb = runBacktest(series, cfg)
const reasons = new Map<string, number>()
for (const t of bb.trades) reasons.set(t.exitReason, (reasons.get(t.exitReason) ?? 0) + 1)
console.log('[bb-reversion range]', { trades: bb.metrics.trades, winRate: +bb.metrics.winRate.toFixed(1), net: +bb.metrics.netPnl.toFixed(2), pf: +bb.metrics.profitFactor.toFixed(2), dd: +bb.metrics.maxDrawdownPct.toFixed(2) })
console.log('exit reasons:', Object.fromEntries(reasons))

const vf = runBacktest(series, { ...cfg, strategy: 'vwap-fade', params: { devPct: 0.5, allowShort: 1 }, tpMode: 'none', tpValue: null, slValue: 1.2 })
const vr = new Map<string, number>()
for (const t of vf.trades) vr.set(t.exitReason, (vr.get(t.exitReason) ?? 0) + 1)
console.log('[vwap-fade range]', { trades: vf.metrics.trades, winRate: +vf.metrics.winRate.toFixed(1), net: +vf.metrics.netPnl.toFixed(2) })
console.log('exit reasons:', Object.fromEntries(vr))

// SL-first worst-case check: craft one bar that spans BOTH tp and sl from fill
// (impossible to hit both in reality; engine must book the STOP)
const two: Bar[] = bars.slice(0, 400)
two.push({ time: two[two.length - 1].time + 300, open: two[two.length - 1].close, high: 200, low: 1, close: 100, volume: 100 })
const s2 = prepareSeries(two)
const r2 = runBacktest(s2, cfg)
const last = r2.trades[r2.trades.length - 1]
console.log('[SL-first] last trade exit reason (must be a stop):', last?.exitReason, last?.exitPx)
