const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC }
const api = (p) => fetch('https://paper-api.alpaca.markets' + p, { headers: H }).then(r => r.json())
const all = await api('/v2/orders?status=all&limit=100&direction=desc')
console.log('BTCUSD orders (any status):')
for (const o of all.filter(o => o.symbol === 'BTCUSD')) {
  console.log(JSON.stringify({ id: o.id.slice(-8), t: o.type, side: o.side, st: o.status, qty: o.qty, filled: o.filled_qty, stop: o.stop_price, lim: o.limit_price, coid: (o.client_order_id || '').slice(0, 34), created: o.created_at?.slice(11, 19), canceled: o.canceled_at?.slice(11, 19), failed: o.failed_at?.slice(11, 19) }))
}
const p = await api('/v2/positions/BTCUSD')
console.log('position:', p.symbol, 'qty', p.qty, 'avail', p.qty_available)
process.exit(0)
