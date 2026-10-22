// Task 70-c regression probe — runs the backtest simulator on DETERMINISTIC
// synthetic bars for all four strategies with the new re-entry gates OFF
// (cooldownMin 0, requireNewSignal false). Dumps metrics JSON so the pre/post
// change results can be diffed (must be identical).
// Run: bun scripts-tmp/t70-regression.ts <out.json>
import { prepareSeries, runBacktest, type BacktestConfig } from '../src/lib/backtest'
import type { Bar } from '../src/lib/market-types'
import type { AlgoStrategyId } from '../src/lib/algo-strategies'

const base = Date.UTC(2026, 0, 5, 14, 30) / 1000 // Mon Jan 5 2026 09:30 ET
const rnd = (() => { let s = 20260207; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) })()

function buildBars(days: number, shape: 'mixed' | 'grind-down'): Bar[] {
  const bars: Bar[] = []
  let price = 100
  for (let d = 0; d < days; d++) {
    const dayStart = base + d * 86400
    const dow = new Date(dayStart * 1000).getUTCDay()
    if (dow === 0 || dow === 6) continue
    const mode = d % 4
    for (let k = 0; k < 78; k++) {
      const t = dayStart + k * 300
      let drift = 0
      if (shape === 'grind-down') drift = -0.05
      else if (mode === 2) drift = 0.05
      else if (mode === 3) drift = -0.05
      const wave = mode === 2 || mode === 3 ? 0 : Math.sin(k / 5.5) * 0.9
      const open = price
      price = price + drift + wave + (rnd() - 0.5) * 0.25
      const close = price
      const hi = Math.max(open, close) + rnd() * 0.12
      const lo = Math.min(open, close) - rnd() * 0.12
      bars.push({ time: t, open, high: hi, low: lo, close, volume: 800 + Math.round(rnd() * 400) })
    }
  }
  return bars
}

// ORB repeat scenario: tight opening range, then a chunky up-ramp with
// pullbacks that keep tripping the 0.5% SL while closes stay above the OR high.
function buildOrbBars(days: number): Bar[] {
  const bars: Bar[] = []
  let price = 100
  for (let d = 0; d < days; d++) {
    const dayStart = base + d * 86400
    const dow = new Date(dayStart * 1000).getUTCDay()
    if (dow === 0 || dow === 6) continue
    for (let k = 0; k < 78; k++) {
      const t = dayStart + k * 300
      let close: number
      if (k < 3) close = 100 + (rnd() - 0.5) * 0.06 // 09:30-09:45 OR window
      else {
        // chunky ramp: two up steps then a pullback step, repeating
        const phase = (k - 3) % 3
        close = price + (phase === 2 ? -0.55 : 0.85) + (rnd() - 0.5) * 0.08
        price = close
      }
      const open = k === 0 ? close : bars[bars.length - 1].close
      const hi = Math.max(open, close) + rnd() * 0.05
      const lo = Math.min(open, close) - rnd() * 0.05
      bars.push({ time: t, open, high: hi, low: lo, close, volume: 1000 })
    }
  }
  return bars
}

const MIXED = prepareSeries(buildBars(60, 'mixed'))
const DOWN = prepareSeries(buildBars(60, 'grind-down'))
const ORB = prepareSeries(buildOrbBars(30))

const cfgs: { name: string; series: typeof MIXED; cfg: BacktestConfig }[] = [
  {
    name: 'bb-reversion',
    series: DOWN,
    cfg: { strategy: 'bb-reversion', params: { bbPeriod: 20, bbStd: 2, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, allowShort: 1 }, qty: 10, sizingMode: 'fixed' as const, riskMoney: null, isCrypto: false, tpMode: 'pct', tpValue: 1, slMode: 'pct', slValue: 0.5, maxTradesDay: 50, rthOnly: true, flattenEod: true, cooldownMin: 0, requireNewSignal: false, capital: 10000 },
  },
  {
    name: 'rsi2-connors',
    series: MIXED,
    cfg: { strategy: 'rsi2-connors', params: { rsiPeriod: 2, rsiBuy: 10, trendSma: 200, exitSma: 5 }, qty: 10, sizingMode: 'fixed' as const, riskMoney: null, isCrypto: false, tpMode: 'pct', tpValue: 1.5, slMode: 'pct', slValue: 1, maxTradesDay: 50, rthOnly: true, flattenEod: true, cooldownMin: 0, requireNewSignal: false, capital: 10000 },
  },
  {
    name: 'orb15',
    series: ORB,
    cfg: { strategy: 'orb15', params: { orMinutes: 15, onePerSide: 0 }, qty: 10, sizingMode: 'fixed' as const, riskMoney: null, isCrypto: false, tpMode: 'pct', tpValue: 1, slMode: 'pct', slValue: 0.5, maxTradesDay: 50, rthOnly: true, flattenEod: true, cooldownMin: 0, requireNewSignal: false, capital: 10000 },
  },
  {
    name: 'vwap-fade',
    series: MIXED,
    cfg: { strategy: 'vwap-fade', params: { devPct: 0.4, allowShort: 1 }, qty: 10, sizingMode: 'fixed' as const, riskMoney: null, isCrypto: false, tpMode: 'pct', tpValue: 1, slMode: 'pct', slValue: 0.5, maxTradesDay: 50, rthOnly: true, flattenEod: true, cooldownMin: 0, requireNewSignal: false, capital: 10000 },
  },
]

const out: Record<string, unknown> = { capturedAt: 'deterministic' }
for (const { name, series, cfg } of cfgs) {
  const r = runBacktest(series, cfg)
  out[name] = {
    trades: r.metrics.trades,
    netPnl: Number(r.metrics.netPnl.toFixed(6)),
    netPct: Number(r.metrics.netPct.toFixed(6)),
    winRate: Number(r.metrics.winRate.toFixed(4)),
    grossWin: Number(r.metrics.grossWin.toFixed(6)),
    grossLoss: Number(r.metrics.grossLoss.toFixed(6)),
    maxDrawdown: Number(r.metrics.maxDrawdown.toFixed(6)),
    longs: r.metrics.longs,
    shorts: r.metrics.shorts,
    first12: r.trades.slice(0, 12).map((t) => [t.entryTime, t.exitTime, t.side, Number(t.pnl.toFixed(6)), t.exitReason]),
  }
}
const path = process.argv[2] || 'scripts-tmp/t70-regression-out.json'
await (await import("node:fs/promises")).writeFile(path, JSON.stringify(out, null, 2))
console.log(`wrote ${path}`)
for (const k of Object.keys(out)) {
  if (k === 'capturedAt') continue
  const v = out[k] as { trades: number; netPnl: number }
  console.log(`${k}: trades=${v.trades} netPnl=${v.netPnl.toFixed(2)}`)
}
