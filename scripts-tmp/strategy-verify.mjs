// Probe: verify strategy-fired orders on Alpaca paper (read-only).
// Shows recent orders with legs/plan info for the symbols the strategies trade.
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'

const r = await fetch(`${BASE}/v2/orders?status=all&limit=15&direction=desc`, {
  headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC },
})
const orders = await r.json()
for (const o of orders) {
  console.log(JSON.stringify({
    id: o.id.slice(0, 8), symbol: o.symbol, side: o.side, type: o.type,
    class: o.order_class, status: o.status, qty: o.qty,
    coid: o.client_order_id?.slice(0, 40),
    tp: o.take_profit?.limit_price, sl: o.stop_loss?.stop_price,
    filled: o.filled_qty, avg: o.filled_avg_price,
    created: o.created_at?.slice(5, 19),
  }))
}
console.log('--- positions ---')
const p = await fetch(`${BASE}/v2/positions`, {
  headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC },
})
const positions = await p.json()
for (const q of positions) {
  console.log(JSON.stringify({ symbol: q.symbol, qty: q.qty, avg: q.avg_entry_price, side: q.side }))
}
