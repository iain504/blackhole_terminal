const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const T = await import('../src/lib/trading.ts')
const A = await import('../src/lib/alpaca.ts')
const mode = await T.resolveTradeMode(UID)

// ---- TEST 1: STOCK, raw Alpaca order_class='oto' with ONLY stop_loss ----
const { quotes: fq } = await A.getQuotes(['F'], UID)
const fref = fq.find(q => q.symbol === 'F')?.price
const body = {
  symbol: 'F', qty: '1', side: 'buy', type: 'market', time_in_force: 'day',
  order_class: 'oto', stop_loss: { stop_price: (fref * 0.99).toFixed(2) },
  client_order_id: 'ttb-test-slonly-' + Date.now(),
}
const r1 = await fetch('https://paper-api.alpaca.markets/v2/orders', {
  method: 'POST',
  headers: { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const j1 = await r1.json().catch(() => ({}))
console.log('STOCK oto SL-only ->', r1.status, JSON.stringify(j1).slice(0, 400))
globalThis.otoId = j1.id
process.exit(0)
