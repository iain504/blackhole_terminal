const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC }
const raw = await fetch('https://paper-api.alpaca.markets/v2/orders?status=all&limit=100&direction=desc', { headers: H })
console.log('http', raw.status)
const all = await raw.json()
console.log('total orders returned:', Array.isArray(all) ? all.length : all)
const btc = all.filter(o => (o.symbol || '').includes('BTC'))
console.log('BTC orders:', btc.length)
for (const o of btc.slice(0, 6)) console.log(JSON.stringify({ t: o.type, side: o.side, st: o.status, qty: o.qty, stop: o.stop_price, coid: (o.client_order_id || '').slice(0, 34), created: o.created_at?.slice(11, 19), canceled: o.canceled_at?.slice(11, 19) }))
process.exit(0)
