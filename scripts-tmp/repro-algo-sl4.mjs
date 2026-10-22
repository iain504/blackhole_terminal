const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const T = await import('../src/lib/trading.ts')
const A = await import('../src/lib/alpaca.ts')
const mode = await T.resolveTradeMode(UID)
const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC, 'content-type': 'application/json' }
const api = (p, o) => fetch('https://paper-api.alpaca.markets' + p, { headers: H, ...o }).then(r => r.json())

// crypto SL-only via the real engine path
const { quotes: bq } = await A.getQuotes(['BTC/USD'], UID)
const bref = bq.find(q => q.symbol === 'BTC/USD')?.price
const bsl = Math.round(bref * 0.99 * 100) / 100
const r = await T.placeOrderWithExits(UID, mode, { symbol: 'BTC/USD', side: 'buy', qty: 0.0002, type: 'market', stop_loss: bsl })
console.log('crypto result:', JSON.stringify({ n: r.results.length, errors: r.errors, splitNote: r.splitNote }, null, 2))
await new Promise(rr => setTimeout(rr, 2500))
const bOrders = await api('/v2/orders?status=open&limit=50')
console.log('BTC open orders:', JSON.stringify(bOrders.filter(o => o.symbol === 'BTCUSD').map(o => ({ t: o.type, st: o.status, stop: o.stop_price, lim: o.limit_price, qty: o.qty, coid: (o.client_order_id||'').slice(0, 24) }))))
const bPos = await api('/v2/positions/BTCUSD')
console.log('BTC position qty:', bPos?.qty, 'avail:', bPos?.qty_available)

// ---- CLEANUP: cancel every open order on F/BTCUSD, then close both positions ----
for (const o of bOrders.filter(o => o.symbol === 'BTCUSD' || o.symbol === 'F')) {
  const c = await fetch('https://paper-api.alpaca.markets/v2/orders/' + o.id, { method: 'DELETE', headers: H })
  console.log('cancel', o.symbol, o.type, '->', c.status)
}
await new Promise(rr => setTimeout(rr, 1200))
const cf = await T.closePositionFull(UID, mode, 'F')
console.log('close F ->', cf.close.status, cf.close.error || '')
const cb = await T.closePositionFull(UID, mode, 'BTC/USD')
console.log('close BTC ->', cb.close.status, cb.close.error || '')
process.exit(0)
