// Task 78e probe — Risk Money % basis:
//  1. riskBudgetUsd helper: usd passthrough · pct × equity · clamps · null cases
//  2. backtest % sizing: every SL exit loses ≈ pct × CURRENT sim equity
//     (compounding), not pct × starting capital — via a deterministic ORB
//     breakout series (RTH-aligned 5m bars, 4 identical breakouts + crashes)
// Run: bun scripts-tmp/t78e-risk-pct-probe.ts
import { prepareSeries, runBacktest, type BacktestConfig, type BacktestTrade } from '../src/lib/backtest'
import { riskBudgetUsd, riskMoneyLabel } from '../src/lib/algo-strategies'

let fails = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) fails += 1
  console.log(`${cond ? 'PASS' : 'FAIL'} · ${name}${extra ? ` — ${extra}` : ''}`)
}

// ---- 1. riskBudgetUsd ----
check('usd passthrough', riskBudgetUsd('usd', 250, null, null) === 250)
check('usd ignores equity', riskBudgetUsd('usd', 250, null, 50_000) === 250)
check('usd null/0 → null', riskBudgetUsd('usd', null, null, 1000) === null && riskBudgetUsd('usd', 0, null, 1000) === null)
check('pct 1% of 20k = 200', Math.abs((riskBudgetUsd('pct', null, 1, 20_000) ?? 0) - 200) < 1e-9)
check('pct 0.5% of 81600 = 408', Math.abs((riskBudgetUsd('pct', null, 0.5, 81_600) ?? 0) - 408) < 1e-9)
check('pct clamps >100', riskBudgetUsd('pct', null, 250, 10_000) === 10_000)
check('pct no equity → null', riskBudgetUsd('pct', null, 1, null) === null && riskBudgetUsd('pct', null, 1, 0) === null)
check('pct no pct → null', riskBudgetUsd('pct', null, null, 20_000) === null)
check('label usd/pct', riskMoneyLabel('usd', 250, null) === '$250' && riskMoneyLabel('pct', null, 0.75) === '0.75%')

// ---- 2. backtest % sizing (deterministic ORB series) ----
// 2024-01-02 09:30 ET = 1704205800, 5m bars. OR(15m) = first 3 bars @ 100.
// Then 4 breakout→crash cycles: signal close > OR-high, fill next open,
// same-bar crash trips the 1% SL. onePerSide=0 so each breakout re-fires.
const T0 = 1_704_205_800 // 09:30 ET
const bar = (i: number, o: number, h: number, l: number, c: number) => ({
  time: T0 + i * 300, open: o, high: h, low: l, close: c, volume: 1000,
})
const bars = [
  bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 100, 100, 100), // OR = 100
  bar(3, 100, 102, 100, 102), // close > OR high → BUY (fills b4 open)
  bar(4, 102, 102, 98, 99), //   SL intrabar @ 100.98 (fill 102 × 0.99)
  bar(5, 99, 103, 99, 103), //   breakout again → BUY (fills b6 open)
  bar(6, 103, 103, 99, 100), //  SL @ 101.97
  bar(7, 100, 104, 100, 104), // breakout → BUY (fills b8 open)
  bar(8, 104, 104, 100, 101), // SL @ 102.96
  bar(9, 101, 105, 101, 105), // breakout → BUY (fills b10 open)
  bar(10, 105, 105, 101, 102), // SL @ 103.95
  bar(11, 102, 105, 102, 105), bar(12, 105, 105, 105, 105), // tail, no signal
]
const series = prepareSeries(bars as never)
const cfg: BacktestConfig = {
  strategy: 'orb15',
  params: { orMinutes: 15, onePerSide: 0 },
  qty: 10, sizingMode: 'risk', riskBasis: 'pct', riskMoney: null, riskMoneyPct: 1,
  isCrypto: false,
  tpMode: 'none', tpValue: null,
  slMode: 'pct', slValue: 1,
  maxTradesDay: 50, rthOnly: false, flattenEod: false, cooldownMin: 0, requireNewSignal: false,
  capital: 10_000,
}
const res = runBacktest(series, cfg)
const slTrades: BacktestTrade[] = res.trades.filter((t) => t.exitReason.toLowerCase().includes('stop'))
check('backtest produced 4 SL trades', slTrades.length === 4, `got ${slTrades.length}: ${res.trades.map((t) => t.reason).join(' | ')}`)
if (slTrades.length === 4) {
  // budget for trade k = (capital + Σ pnl of trades closed before its entry) × 1%
  let cash = 10_000
  let maxErr = 0
  const losses: number[] = []
  for (const t of slTrades) {
    const expect = (cash * 1) / 100
    const loss = Math.abs(t.pnl)
    losses.push(loss)
    maxErr = Math.max(maxErr, Math.abs(loss - expect))
    cash += t.pnl
  }
  check('every SL loss ≈ 1% of CURRENT sim equity (≤ 1 share of floor error)', maxErr <= 1.05, `max |loss − 1%·cash| = $${maxErr.toFixed(4)}`)
  check('budget compounds (losses strictly shrink as equity falls)', losses.every((l, i) => i === 0 || l < losses[i - 1]), losses.map((l) => l.toFixed(2)).join(' → '))
  console.log(`  SL losses ($): ${losses.map((l) => l.toFixed(2)).join(', ')}`)
}
// fixed-mode regression: same series with qty 10 → every trade qty stays 10
// (fixed QTY, not fixed $ — losses vary with each fill's stop distance)
const fixedCfg: BacktestConfig = { ...cfg, sizingMode: 'fixed', riskBasis: 'usd', riskMoney: 200, riskMoneyPct: null }
const fixedRes = runBacktest(series, fixedCfg)
const fixedSl = fixedRes.trades.filter((t) => t.exitReason.toLowerCase().includes('stop'))
check('fixed-mode regression: 4 SL trades, all qty 10', fixedSl.length === 4 && fixedSl.every((t) => t.qty === 10), fixedSl.map((t) => `qty${t.qty}`).join(', '))

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
