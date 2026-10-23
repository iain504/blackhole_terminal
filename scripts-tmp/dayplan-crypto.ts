// BTC/USD 24/7 crypto path — real Binance bars through the app's own API shape
const res = await fetch('http://localhost:3000/api/market/bars?symbol=BTC%2FUSD&tf=5m&days=10').then(r => r.json()).catch(() => null)
const bars = (res?.bars ?? []) as { time: number; open: number; high: number; low: number; close: number; volume: number }[]
console.log('bars:', bars.length, 'last close:', bars[bars.length - 1]?.close)
const { analyzeDay } = await import('../src/lib/dayplan')
const a = analyzeDay({ price: bars[bars.length - 1].close, side: 'auto', orMinutes: 15, tfSec: 300, bars })
console.log('sessions:', a.sessions, 'sessionDate:', a.sessionDate)
console.log('bias:', a.bias, 'orState:', a.orState, 'vwap:', a.vwap?.toFixed(2), 'rvol:', a.rvol?.toFixed(2), 'atr:', a.atr?.toFixed(2))
console.log('checks:', a.checks.map(c => `${c.key}=${c.state}`).join(' | '))
console.log('err:', a.err)
if (a.plan) {
  const g = a.plan
  const ok = g.side === 'long' ? g.sl < g.entry && g.entry < g.tp : g.tp < g.entry && g.entry < g.sl
  console.log('plan:', `${g.side} ${g.setup} entry=${g.entry} sl=${g.sl} tp=${g.tp} rr=${g.rr.toFixed(2)} geomOk=${ok}`)
}
