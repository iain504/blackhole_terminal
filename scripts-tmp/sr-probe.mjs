// Synthetic sanity check for detectSrLevels (Task 58) — pivot-count semantics
const bars = []
let t = 1700000000
for (let c = 0; c < 10; c++) {
  const jig = () => (Math.random() - 0.5) * 0.6
  for (let i = 0; i < 6; i++) bars.push({ time: t++, high: 105 + i, low: 103 + i, close: 104 + i })
  for (let i = 0; i < 3; i++) bars.push({ time: t++, high: 101 + jig(), low: 100 + jig(), close: 100.5 })
  for (let i = 0; i < 6; i++) bars.push({ time: t++, high: 102 + i * 1.4, low: 101 + i * 1.4, close: 102 + i * 1.4 })
  for (let i = 0; i < 2; i++) bars.push({ time: t++, high: 110 + jig(), low: 109 + jig(), close: 109.5 })
  for (let i = 0; i < 3; i++) bars.push({ time: t++, high: 109 - i, low: 106 - i, close: 107 - i })
}
const { detectSrLevels } = await import('../src/lib/sr.ts')
const levels = detectSrLevels(bars, { minTouches: 3, maxLevels: 6, tolPct: 0.012 })
console.log(JSON.stringify(levels.map(l => ({ price: +l.price.toFixed(2), touches: l.touches, side: l.side }))))
const sup = levels.find(l => l.side === 'support')
const res = levels.find(l => l.side === 'resistance')
console.log('CHECK levels found:', levels.length >= 2)
console.log('CHECK resistance~110 (>=8 touches):', !!res && res.touches >= 8 && res.price > 108 && res.price < 112)
console.log('CHECK some support <=103 (>=8 touches):', !!sup && sup.touches >= 8 && sup.price < 104)
console.log('CHECK minTouches 11 → none:', detectSrLevels(bars, { minTouches: 11, maxLevels: 6, tolPct: 0.012 }).length === 0)
// flat-shelf case: 12 bars flat at 50, visited twice, elsewhere random walk
const bars2 = []
let p = 60
for (let i = 0; i < 30; i++) { bars2.push({ time: t++, high: p + 1, low: p - 1, close: p }); p += (i % 2 ? 0.5 : -0.5) }
for (let i = 0; i < 8; i++) bars2.push({ time: t++, high: 50.4, low: 50, close: 50.2 })
for (let i = 0; i < 20; i++) { bars2.push({ time: t++, high: 55 + Math.sin(i) * 2, low: 53 + Math.sin(i) * 2, close: 54 }) }
for (let i = 0; i < 8; i++) bars2.push({ time: t++, high: 50.5, low: 49.9, close: 50.1 })
for (let i = 0; i < 15; i++) { bars2.push({ time: t++, high: 52, low: 50.8, close: 51 }) }
const l2 = detectSrLevels(bars2, { minTouches: 2, maxLevels: 6, tolPct: 0.01 })
console.log('FLAT SHELF:', JSON.stringify(l2.map(l => ({ price: +l.price.toFixed(2), touches: l.touches, side: l.side }))))
console.log('CHECK shelf ~50 detected with >=2 touches:', l2.some(l => l.price > 49 && l.price < 51.2 && l.touches >= 2))
