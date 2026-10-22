const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const T = await import('../src/lib/trading.ts')
const A = await import('../src/lib/alpaca.ts')
const mode = await T.resolveTradeMode(UID)
const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC, 'content-type': 'application/json' }
const api = (p, o) => fetch('https://paper-api.alpaca.markets' + p, { headers: H, ...o }).then(r => r.json())

// 1) check the OTO SL-only order — did it fill, did the stop leg activate?
await new Promise(r => setTimeout(r, 2500))
const oto = await api('/v2/orders/40725404-9429-4a9a-8745-00fda4741035')
console.log('OTO status =', oto.status, 'filled_qty =', oto.filled_qty)
const allOrders = await api('/v2/orders?status=open&limit=50&nested=true')
const fOrders = allOrders.filter(o => o.symbol === 'F')
console.log('F open orders:', JSON.stringify(fOrders.map(o => ({ t: o.type, st: o.status, stop: o.stop_price, legs: (o.legs||[]).map(l => ({ t: l.type, st: l.status, stop: l.stop_price })) }))))

// 2) CRYPTO path via placeOrderWithExits (engine path): BTC/USD SL-only 1%
const { quotes: bq } = await A.getQuotes(['BTC/USD'], UID)
const bref = bq.find(q => q.symbol === 'BTC/USD')?.price
console.log('BTC ref =', bref)
const bsl = Math.round(bref * 0.99 * 100) / 100
const r = await T.placeOrderWithExits(UID, mode, { symbol: 'BTC/USD', side: 'buy', qty: 0.0001, type: 'market', stop_loss: bsl })
console.log('crypto result:', JSON.stringify({ n: r.results.length, errors: r.errors, splitNote: r.splitNote, entryStatus: r.results[0]?.status }, null, 2))
await new Promise(rr => setTimeout(rr, 2500))
const bOrders = await api('/v2/orders?status=open&limit=50')
console.log('BTC open orders:', JSON.stringify(bOrders.filter(o => o.symbol === 'BTCUSD').map(o => ({ t: o.type, st: o.status, stop: o.stop_price, lim: o.limit_price, qty: o.qty, coid: (o.client_order_id||'').slice(0, 30) }))))
const bPos = await api('/v2/positions/BTCUSD').catch(() => null)
console.log('BTC position:', bPos?.symbol, bPos?.qty, 'avail', bPos?.qty_available)
process.exit(0)
