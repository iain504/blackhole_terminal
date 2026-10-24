// Debug the rsi2-connors divergence: dump both engines' internals around the
// first divergence bar.
import { getBars } from '@/lib/alpaca'
import { prepareSeries, runBacktest, type BacktestConfig } from '@/lib/backtest'
import { evalStrategy } from '@/lib/algo-engine'
import { normalizeAlgoParams } from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'

const TF_SEC = 300
const { bars } = await getBars('BTC/USD', '5m', 'parity-probe')
let all = bars.slice()
const nowSec = Math.floor(Date.now() / 1000)
while (all.length > 0 && all[all.length - 1].time + TF_SEC > nowSec) all = all.slice(0, -1)

const params = normalizeAlgoParams('rsi2-connors', {})
console.log('normalized params:', JSON.stringify(params))
const trendLen = Math.max(10, Math.round(params.trendSma ?? 200))
console.log('trendLen =', trendLen, '· bt warmup =', trendLen + 2)

const idx = all.findIndex((b) => b.time === 1792542900)
console.log('divergence bar index:', idx, 'of', all.length)

// what did the live engine decide at the bars around it?
for (let i = Math.max(0, idx - 2); i <= idx + 2 && i < all.length; i++) {
  const win = all.slice(0, i + 1)
  const closes = win.map((b) => b.close)
  const smaT = closes.slice(win.length - trendLen).reduce((a, b) => a + b, 0) / trendLen
  const g = closes[win.length - 1] - closes[win.length - 2]
  const g2 = closes[win.length - 2] - closes[win.length - 3]
  const l = (g < 0 ? -g : 0) + (g2 < 0 ? -g2 : 0)
  const gg = (g >= 0 ? g : 0) + (g2 >= 0 ? g2 : 0)
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + gg / l)
  const res = evalStrategy('rsi2-connors' as never, params, win as never, {})
  console.log(
    `i=${i} t=${all[i].time} close=${all[i].close.toFixed(2)} smaT(${trendLen})=${smaT.toFixed(2)} rsi2=${rsi.toFixed(1)}` +
      ` → entry=${res.entry ? res.entry.side : 'null'} exit=${res.exit ? 'yes' : 'null'}`,
  )
}

// backtest decisions — extract from a run which bar it ACCEPTED first
const cfg: BacktestConfig = {
  strategy: 'rsi2-connors',
  params,
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
}
const res = runBacktest(prepareSeries(all), cfg)
console.log('bt first trade:', JSON.stringify(res.trades[0]))
console.log('bt warmupBars:', res.warmupBars)
