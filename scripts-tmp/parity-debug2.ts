// Debug vwap-fade + orb15 divergence: dump sim decisions + accumulator state
// around each divergence, vs the backtest trade list.
import { getBars } from '@/lib/alpaca'
import { prepareSeries, runBacktest, type BacktestConfig } from '@/lib/backtest'
import { evalStrategy } from '@/lib/algo-engine'
import { normalizeAlgoParams } from '@/lib/algo-strategies'
import { sessionOf, etDateKey, etMinutesOfDay } from '@/lib/sessions'
import type { Bar } from '@/lib/market-types'

const TF_SEC = 300
const RTH_START_MIN = 9 * 60 + 30
const { bars } = await getBars('BTC/USD', '5m', 'parity-probe')
let all = bars.slice()
const nowSec = Math.floor(Date.now() / 1000)
while (all.length > 0 && all[all.length - 1].time + TF_SEC > nowSec) all = all.slice(0, -1)

const cfg = (strategy: string): BacktestConfig => ({
  strategy: strategy as never,
  params: normalizeAlgoParams(strategy as never, {}),
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
})

function dump(strategy: 'vwap-fade' | 'orb15', focusTimes: number[]) {
  const params = normalizeAlgoParams(strategy as never, {})
  const orMinutes = Math.max(5, Math.round(params.orMinutes ?? 15))
  const bt = runBacktest(prepareSeries(all), cfg(strategy))
  console.log(`\n===== ${strategy} (devPct=${params.devPct ?? '-'} orMin=${orMinutes}) =====`)
  console.log('bt trades:', bt.trades.map((t) => `sig@${t.entryTime - TF_SEC} ${t.side} exit@${t.exitTime}`).join(' | '))

  // sim walk with full state dump
  let vwapNum = 0, vwapDen = 0, orHigh: number | null = null, orLow: number | null = null, orDone = false
  let firedLong = false, firedShort = false
  let curDay = ''
  let pos: 'buy' | 'sell' | null = null
  const focus = new Set(focusTimes)
  for (let i = 0; i < all.length; i++) {
    const bar = all[i]
    const dk = etDateKey(bar.time)
    if (dk !== curDay) {
      curDay = dk
      vwapNum = 0; vwapDen = 0; orHigh = null; orLow = null; orDone = false
      firedLong = false; firedShort = false
    }
    if (sessionOf(bar.time) === 'regular') {
      const typ = (bar.high + bar.low + bar.close) / 3
      if (strategy === 'vwap-fade') { vwapNum += typ * bar.volume; vwapDen += bar.volume }
      if (strategy === 'orb15' && !orDone) {
        const m = etMinutesOfDay(bar.time)
        if (m >= RTH_START_MIN && m < RTH_START_MIN + orMinutes) {
          orHigh = orHigh == null ? bar.high : Math.max(orHigh, bar.high)
          orLow = orLow == null ? bar.low : Math.min(orLow, bar.low)
        } else if (m >= RTH_START_MIN + orMinutes && orHigh != null && orLow != null) orDone = true
      }
    }
    const res = evalStrategy(strategy as never, params, all.slice(0, i + 1) as never, {
      vwapNum, vwapDen, orHigh, orLow, orDone, firedLong, firedShort,
    } as never)
    let acted = ''
    if (res.exit && pos) { acted += ` EXIT(${res.exit})`; pos = null }
    if (res.entry && !pos) {
      acted += ` ENTRY(${res.entry.side})`
      pos = res.entry.side
      if (strategy === 'orb15') { if (res.entry.side === 'buy') firedLong = true; else firedShort = true }
    }
    const interesting = acted !== '' || focus.has(bar.time)
    if (interesting) {
      const extra = strategy === 'vwap-fade'
        ? `vwap=${vwapDen > 0 ? (vwapNum / vwapDen).toFixed(2) : '-'} dev=${vwapDen > 0 ? (((bar.close - vwapNum / vwapDen) / (vwapNum / vwapDen)) * 100).toFixed(3) : '-'}%`
        : `or=${orDone ? `${orLow?.toFixed(2)}–${orHigh?.toFixed(2)}` : 'forming'} fired=${firedLong ? 'L' : '-'}${firedShort ? 'S' : '-'}`
      console.log(`i=${i} t=${bar.time} c=${bar.close.toFixed(2)} ${extra} pos=${pos ?? 'flat'}${acted}`)
    }
  }
}

dump('vwap-fade', [1792503900])
dump('orb15', [])
