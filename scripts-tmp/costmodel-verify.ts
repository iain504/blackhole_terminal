// Verify the Task 84 cost model: runBacktest(slippageBps=2, feeBps=10) should
// reproduce the parity probe's independent re-pricing of the same trades
// (rsi2-connors has no TP legs, so every exit is a slipped strategy exit).
import { getBars } from '@/lib/alpaca'
import { prepareSeries, runBacktest, type BacktestConfig } from '@/lib/backtest'
import { normalizeAlgoParams } from '@/lib/algo-strategies'

const TF_SEC = 300
const { bars } = await getBars('BTC/USD', '5m', 'parity-probe')
let all = bars.slice()
const nowSec = Math.floor(Date.now() / 1000)
while (all.length > 0 && all[all.length - 1].time + TF_SEC > nowSec) all = all.slice(0, -1)

const mk = (slip: number, fee: number): BacktestConfig => ({
  strategy: 'rsi2-connors',
  params: normalizeAlgoParams('rsi2-connors', {}),
  qty: 1,
  sizingMode: 'fixed',
  riskMoney: null,
  isCrypto: true,
  tpMode: 'none',
  tpValue: null,
  slMode: 'none',
  slValue: null,
  maxTradesDay: 999999,
  rthOnly: false,
  flattenEod: false,
  cooldownMin: 0,
  requireNewSignal: false,
  capital: 10000,
  slippageBps: slip,
  feeBps: fee,
})

const r0 = runBacktest(prepareSeries(all), mk(0, 0))
const rC = runBacktest(prepareSeries(all), mk(2, 10))
console.log(`frictionless : trades=${r0.metrics.trades} netPnl=$${r0.metrics.netPnl.toFixed(2)} (${r0.metrics.netPct.toFixed(2)}%)`)
console.log(`slip2+fee10  : trades=${rC.metrics.trades} netPnl=$${rC.metrics.netPnl.toFixed(2)} (${rC.metrics.netPct.toFixed(2)}%)`)
console.log(`probe estimate was: $-9575.95`)
// trade-count and signal parity must be unaffected by costs
console.log(`trade count unchanged: ${r0.metrics.trades === rC.metrics.trades ? 'YES' : 'NO'}`)
