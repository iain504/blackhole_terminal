// Probe: BTC/USD 1m RSI(2) values (same math as src/lib/indicators.ts rsi())
const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=40')
const k = await r.json()
const closes = k.map((c) => parseFloat(c[4]))
function rsi(closes, period) {
  const out = new Array(closes.length).fill(null)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  const write = (i) => { out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) }
  write(period)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    write(i)
  }
  return out
}
const vals = rsi(closes, 2)
console.log('last 8 RSI(2) 1m values:', vals.slice(-8).map((v) => v?.toFixed(1)).join(' '))
console.log('crossed 50 in last 8 bars:', vals.slice(-8).some((v, i, arr) => i > 0 && arr[i - 1] != null && ((arr[i - 1] <= 50 && v > 50) || (arr[i - 1] >= 50 && v < 50))))
