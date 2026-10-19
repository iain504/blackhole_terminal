// sanity-probe src/lib/indicators.ts math against hand-computed values
import { readFileSync } from 'fs'
// transpile-free: strip types via bun's TS support
const mod = await import('/home/z/my-project/src/lib/indicators.ts')
const { sma, ema, bollinger, rsi, macd, computeOverlays, stripMargins, normalizeIndicators } = mod

const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
const s3 = sma(closes, 3)
console.log('SMA3:', JSON.stringify(s3), '→ expect [null,null,11,12,13,14,15,16,17,18]')
const e3 = ema(closes, 3)
// seed = mean(10,11,12)=11; k=0.5: 13*.5+11*.5=12; 14*.5+12*.5=13; ...
console.log('EMA3:', JSON.stringify(e3), '→ expect [null,null,11,12,13,14,15,16,17,18]')

const bb = bollinger([2, 4, 6, 8, 6, 4, 2, 4, 6, 8], 5, 2)
console.log('BB mid@4:', bb.mid[4], '→ expect 5.2 ; upper@4:', bb.upper[4], '→ expect 5.2+2*sd')

const r14 = rsi([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28], 14)
console.log('RSI14 (stockcharts classic):', r14[14]?.toFixed(2), '→ expect ≈70.46')

const m = macd(closes.map((c, i) => c + (i % 3) * 0.5), 2, 4, 2)
console.log('MACD first non-null macd idx:', m.macd.findIndex((v) => v != null), '→ expect 3 (slow-1)')
console.log('MACD signal first non-null idx:', m.signal.findIndex((v) => v != null), '→ expect >=4')

const bars = closes.map((c, i) => ({ time: 1000 + i * 60, open: c, high: c, low: c, close: c, volume: 1 }))
const ov = computeOverlays(bars, normalizeIndicators({ sma: { enabled: true, period: 3 }, ema: { enabled: false, period: 50 }, bb: { enabled: false, period: 20, mult: 2 }, rsi: { enabled: false, period: 14 }, macd: { enabled: false, fast: 12, slow: 26, signal: 9 } }))
console.log('computeOverlays sma points:', ov.sma?.length, 'first:', JSON.stringify(ov.sma?.[0]))

console.log('strips none:', JSON.stringify(stripMargins(false, false)))
console.log('strips rsi:', JSON.stringify(stripMargins(true, false)))
console.log('strips both:', JSON.stringify(stripMargins(true, true)))
