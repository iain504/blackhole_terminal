import { analyzeDay, groupSessions, openingRange, atrWilder } from '../src/lib/dayplan'
// ramping session that CLOSES above its OR high and above vwap (classic ORB long)
let t = Math.floor(Date.now() / 1000 / 300) * 300 - 4 * 78 * 300 - 10 * 78 * 300
const bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
let price = 100
for (let s = 0; s < 5; s++) {
  for (let i = 0; i < 78; i++) {
    const drift = s === 4 ? (i < 3 ? 0.01 : 0.09) : Math.sin((i + s * 10) / 7) * 0.08
    const open = price
    price = price + drift
    bars.push({ time: t, open, high: Math.max(open, price) + 0.05, low: Math.min(open, price) - 0.05, close: price, volume: s === 4 ? 1500 : 1000 })
    t += 300
  }
  t += 16 * 3600
}
const last = bars[bars.length - 1].close
const a = analyzeDay({ price: last, side: 'auto', orMinutes: 15, tfSec: 300, bars })
console.log('p=', last.toFixed(2), 'bias', a.bias, 'orState', a.orState, 'vwap', a.vwap?.toFixed(2), 'orHigh', a.or?.high.toFixed(2))
console.log('checks:', a.checks.map((c) => `${c.key}:${c.state}`).join(' | '))
const g = a.plan!
console.log('plan:', `${g.side} ${g.setup} entry=${g.entry.toFixed(2)} sl=${g.sl.toFixed(2)} tp=${g.tp.toFixed(2)} rr=${g.rr.toFixed(2)} src=${g.tpSource}`)
console.log('geom ok:', g.sl < g.entry && g.entry < g.tp, 'risk×ATR:', ((g.entry - g.sl) / (atrWilder(bars, 14) ?? 1)).toFixed(2))
console.log('entry rests below market (retest):', g.entry < last)
