// Verify the SPCX OCO legs share a group (buy OCO against the short). Read-only.
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

const r = await fetch(BASE + '/v2/orders?status=open&limit=500&nested=true', { headers: H })
const orders = await r.json()
for (const o of orders || []) {
  if (!String(o.symbol).includes('SPCX')) continue
  console.log(JSON.stringify({
    id: String(o.id).slice(0, 8),
    side: o.side, type: o.type, class: o.order_class, qty: o.qty,
    lim: o.limit_price, stop: o.stop_price, status: o.status,
    legs: (o.legs || []).map((l) => ({
      side: l.side, type: l.type, qty: l.qty, lim: l.limit_price, stop: l.stop_price, status: l.status,
    })),
  }, null, 1))
}
console.log('DONE')
