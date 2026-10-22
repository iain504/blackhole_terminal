const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC }
const api = (p) => fetch('https://paper-api.alpaca.markets' + p, { headers: H }).then(r => r.json())
const closed = await api('/v2/orders?status=closed&limit=15&direction=desc')
for (const o of closed.filter(o => o.symbol === 'F')) {
  console.log(JSON.stringify({ side: o.side, type: o.type, status: o.status, filled: o.filled_qty, px: o.filled_avg_price, coid: (o.client_order_id || '').slice(0, 46), filledAt: o.filled_at?.slice(11, 19) }))
}
const pos = await api('/v2/positions')
console.log('F position now:', (Array.isArray(pos) ? pos : []).find(p => p.symbol === 'F')?.qty ?? 'FLAT')
process.exit(0)
