// Inspect SPCX orders in detail (nested legs, client ids, timestamps). Read-only.
const KEY = process.env.APCA_API_KEY_ID
const SEC = process.env.APCA_API_KEY_SECRET
if (!KEY || !SEC) { console.error('Missing APCA_API_KEY_ID / APCA_API_KEY_SECRET env vars'); process.exit(1) }
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

const r = await fetch(BASE + '/v2/orders?status=open&limit=500&nested=true', { headers: H })
const orders = await r.json()
for (const o of orders || []) {
  if (!String(o.symbol).includes('SPCX')) continue
  console.log(JSON.stringify({
    id: String(o.id).slice(0, 8),
    sym: o.symbol, side: o.side, type: o.type, class: o.order_class,
    qty: o.qty, status: o.status, lim: o.limit_price, stop: o.stop_price,
    coid: o.client_order_id,
    created: o.created_at,
    legs: (o.legs || []).map((l) => ({
      id: String(l.id).slice(0, 8), side: l.side, type: l.type, qty: l.qty,
      lim: l.limit_price, stop: l.stop_price, status: l.status, coid: l.client_order_id,
    })),
  }, null, 1))
}
console.log('DONE')
