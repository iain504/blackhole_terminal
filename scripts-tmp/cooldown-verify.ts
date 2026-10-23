// Cooldown anchor sanity: with cooldownMin=30 no entry signal bar may open
// before (exit bar close + 30min) — verify across a run.
import { getBars } from '@/lib/alpaca'
import { prepareSeries, runBacktest, type BacktestConfig } from '@/lib/backtest'
import { normalizeAlgoParams } from '@/lib/algo-strategies'
const TF_SEC = 300
const { bars } = await getBars('BTC/USD', '5m', 'parity-probe')
let all = bars.slice()
const nowSec = Math.floor(Date.now() / 1000)
while (all.length > 0 && all[all.length - 1].time + TF_SEC > nowSec) all = all.slice(0, -1)
const cfg: BacktestConfig = {
  strategy: 'rsi2-connors', params: normalizeAlgoParams('rsi2-connors', {}), qty: 1,
  sizingMode: 'fixed', riskMoney: null, isCrypto: true, tpMode: 'none', tpValue: null,
  slMode: 'none', slValue: null, maxTradesDay: 999999, rthOnly: false, flattenEod: false,
  cooldownMin: 30, requireNewSignal: false, capital: 10000,
}
const r = runBacktest(prepareSeries(all), cfg)
let bad = 0
for (let i = 1; i < r.trades.length; i++) {
  const prev = r.trades[i - 1]
  const sigOpen = r.trades[i].entryTime - TF_SEC // signal bar opens here
  const gate = prev.exitTime + TF_SEC + 30 * 60 // exit bar close + 30min
  if (sigOpen < gate) { bad++; console.log(`VIOLATION: sig@${sigOpen} < gate@${gate}`) }
}
console.log(`cooldown=30m: trades=${r.trades.length} violations=${bad} → ${bad === 0 ? 'OK ✓' : 'BROKEN ✗'}`)
