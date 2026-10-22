// Task 78 probe — Risk Money sizing math (shared helper + backtest integration)
import { riskSizedQty } from '../src/lib/algo-strategies'
import { prepareSeries, runBacktest, type BacktestConfig } from '../src/lib/backtest'
import type { Bar } from '../src/lib/market-types'

// helper: $200 risk, entry $355, SL 1% → risk/share = $3.55 → 56.3 → 56 shares
console.log('stock 56 expected:', riskSizedQty(200, 355, 1, false))
// tighter stop → larger size: SL 0.5% → risk/share $1.775 → 112.6 → 112
console.log('stock 112 expected:', riskSizedQty(200, 355, 0.5, false))
// too-small budget: $1 risk at $3.55/share → null (cannot buy 1 share within budget)
console.log('null expected:', riskSizedQty(1, 355, 1, false))
// crypto floors to 4dp: $100 risk, entry 81600, SL 1% → risk/u $816 → 0.1225
console.log('crypto 0.1225 expected:', riskSizedQty(100, 81600, 1, true))
// invalid inputs
console.log('null expected (no sl):', riskSizedQty(200, 355, 0, false))

// backtest integration: constant $ risk per trade — every SL exit should lose ≈ riskMoney
const bars: Bar[] = []
let px = 100
let t = Math.floor(Date.UTC(2025, 0, 6, 14, 30) / 1000)
// 30 days of 5m bars in a gentle random walk (RTH only, Mon–Fri)
const rnd = (() => { let s = 42; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff } })()
for (let d = 0; d < 30; d++) {
  const day = new Date(t * 1000)
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) { t += 86400; d--; continue }
  for (let i = 0; i < 78; i++) {
    const open = px
    px = Math.max(1, px + (rnd() - 0.5) * 1.2)
    bars.push({ time: t, open, high: Math.max(open, px) + 0.1, low: Math.min(open, px) - 0.1, close: px, volume: 10000 })
    t += 300
  }
  t += 86400 - 78 * 300
}
const cfg: BacktestConfig = {
  strategy: 'bb-reversion', params: { bbPeriod: 20, bbStd: 2, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, allowShort: 1 },
  qty: 10, sizingMode: 'risk', riskMoney: 200, isCrypto: false,
  tpMode: 'pct', tpValue: 1.5, slMode: 'pct', slValue: 1,
  maxTradesDay: 50, rthOnly: true, flattenEod: true, cooldownMin: 0, requireNewSignal: false, capital: 10000,
}
const res = runBacktest(prepareSeries(bars), cfg)
const slLosses = res.trades.filter((tr) => tr.exitReason === 'stop loss' && tr.pnl < 0)
const worst = Math.max(...slLosses.map((tr) => Math.abs(tr.pnl)))
const best = Math.min(...slLosses.map((tr) => Math.abs(tr.pnl)))
console.log(`risk-sized backtest: ${res.trades.length} trades, ${slLosses.length} stop-loss exits`)
console.log(`stop-loss losses range: $${best.toFixed(2)} – $${worst.toFixed(2)} (expect ≈ $200 ±1 share flooring)`)
const fixedCfg: BacktestConfig = { ...cfg, sizingMode: 'fixed', riskMoney: null }
const fixed = runBacktest(prepareSeries(bars), fixedCfg)
console.log(`fixed-qty backtest unchanged: ${fixed.trades.length} trades, all qty=10: ${fixed.trades.every((tr) => tr.qty === 10)}`)
