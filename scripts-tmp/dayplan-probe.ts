// Task 83 probe: verify dayplan math on synthetic 5m sessions
import { analyzeDay, groupSessions, openingRange, atrWilder, relVolume } from '../src/lib/dayplan'

// build 4 prior sessions + a live session of 5m bars around price 100
let t = Math.floor(Date.now() / 1000 / 300) * 300 - 4 * 78 * 300 - 10 * 78 * 300 // start well in the past
const bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
let price = 100
for (let s = 0; s < 5; s++) {
  for (let i = 0; i < 78; i++) {
    // drift: prior sessions oscillate 99..101; last session ramps up then holds above OR
    const drift = s === 4 ? (i < 6 ? 0.02 : 0.05) : Math.sin((i + s * 10) / 7) * 0.08
    const open = price
    price = price + drift
    const high = Math.max(open, price) + 0.05
    const low = Math.min(open, price) - 0.05
    bars.push({ time: t, open, high, low, close: price, volume: s === 4 ? 1500 : 1000 })
    t += 300
  }
  t += 16 * 3600 // overnight gap (next UTC day)
}
const sess = groupSessions(bars)
console.log('sessions:', sess.length, 'bars per session:', sess.map((s) => s.bars.length).join(','))
console.log('session keys:', sess.map((s) => s.key).join(','))

const or = openingRange(sess[4], 15, 300)
console.log('OR(15m):', or.high.toFixed(2), or.low.toFixed(2), 'complete:', or.complete)
console.log('ATR14(5m):', atrWilder(bars, 14)?.toFixed(4))
console.log('RVOL:', relVolume(sess)?.toFixed(2))

// live price above OR high → breakout-retest long
const p = or.high + 0.4
const a = analyzeDay({ price: p, side: 'auto', orMinutes: 15, tfSec: 300, bars })
console.log('\n== BREAKOUT case ==')
console.log('bias', a.bias, 'orState', a.orState)
console.log('checks:', a.checks.map((c) => `${c.key}:${c.state}`).join(' | '))
console.log('plan:', a.plan && `${a.plan.side} ${a.plan.setup} entry=${a.plan.entry.toFixed(2)} sl=${a.plan.sl.toFixed(2)} tp=${a.plan.tp.toFixed(2)} rr=${a.plan.rr.toFixed(2)} tpSrc=${a.plan.tpSource} ct=${a.plan.countertrend}`)
const g = a.plan!
console.log('geom ok:', g.sl < g.entry && g.entry < g.tp, 'risk ATR-multiple:', ((g.entry - g.sl) / (atrWilder(bars, 14) ?? 1)).toFixed(2))

// forced short while price above vwap → countertrend reversion
const b = analyzeDay({ price: p, side: 'short', orMinutes: 15, tfSec: 300, bars })
console.log('\n== FORCED SHORT (countertrend) ==')
console.log('plan:', b.plan && `${b.plan.side} ${b.plan.setup} entry=${b.plan.entry.toFixed(2)} sl=${b.plan.sl.toFixed(2)} tp=${b.plan.tp.toFixed(2)} rr=${b.plan.rr.toFixed(2)} ct=${b.plan.countertrend}`)
console.log('counter check:', b.checks.find((c) => c.key === 'counter')?.state)
console.log('geom ok:', b.plan!.tp < b.plan!.entry && b.plan!.entry < b.plan!.sl)

// young session — OR incomplete
const bars2 = bars.slice(0, 4 * 78 + 2)
const c = analyzeDay({ price: 100.5, side: 'auto', orMinutes: 15, tfSec: 300, bars: bars2 })
console.log('\n== OR FORMING ==')
console.log('err:', c.err)

// price below OR low → short breakdown-retest
const bars3 = bars.map((bb, i) => {
  if (i >= 4 * 78) {
    const k = i - 4 * 78
    const delta = k < 6 ? -0.03 : -0.08
    const open = bb.open
    const close = open + delta
    return { ...bb, open, close, high: Math.max(open, close) + 0.03, low: Math.min(open, close) - 0.03 }
  }
  return bb
})
const d = analyzeDay({ price: openingRange(groupSessions(bars3)[4], 15, 300).low - 0.4, side: 'auto', orMinutes: 15, tfSec: 300, bars: bars3 })
console.log('\n== BREAKDOWN case ==')
console.log('bias', d.bias, 'orState', d.orState)
console.log('plan:', d.plan && `${d.plan.side} ${d.plan.setup} entry=${d.plan.entry.toFixed(2)} sl=${d.plan.sl.toFixed(2)} tp=${d.plan.tp.toFixed(2)} rr=${d.plan.rr.toFixed(2)} geom ok=${d.plan.tp < d.plan.entry && d.plan.entry < d.plan.sl}`)
