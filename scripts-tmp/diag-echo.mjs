// Diagnostic: inspect the real state of the user's ECHO bracket-order flow.
// Read-only — no POST/DELETE/PATCH.
const KEY = process.env.APCA_API_KEY_ID
const SEC = process.env.APCA_API_KEY_SECRET
if (!KEY || !SEC) { console.error('Missing APCA_API_KEY_ID / APCA_API_KEY_SECRET env vars'); process.exit(1) }
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

async function api(path) {
  const r = await fetch(BASE + path, { headers: H })
  const txt = await r.text()
  let body = null
  try { body = JSON.parse(txt) } catch { body = txt }
  return { status: r.status, body }
}

const fmt = (o) =>
  o
    ? {
        id: String(o.id).slice(0, 8),
        sym: o.symbol,
        side: o.side,
        type: o.type,
        class: o.order_class,
        qty: o.qty,
        filled: o.filled_qty,
        status: o.status,
        lim: o.limit_price,
        stop: o.stop_price,
        coid: (o.client_order_id || '').slice(0, 28),
        legs: (o.legs || []).map((l) => `${l.type}/${l.side}@${l.limit_price || l.stop_price} ${l.status} ${String(l.id).slice(0, 8)}`),
        created: o.created_at,
        filledAt: o.filled_at,
      }
    : null

// 1) position
const pos = await api('/v2/positions/ECHO')
console.log('=== POSITION ECHO ===', pos.status)
console.log(JSON.stringify(pos.body, null, 1)?.slice(0, 900))

// 2) all open orders (flat + nested)
const [flat, nested] = await Promise.all([
  api('/v2/orders?status=open&limit=500'),
  api('/v2/orders?status=open&limit=500&nested=true'),
])
console.log('\n=== OPEN (flat) ===')
for (const o of flat.body || []) console.log(JSON.stringify(fmt(o)))
console.log('\n=== OPEN (nested) ===')
for (const o of nested.body || []) console.log(JSON.stringify(fmt(o)))

// 3) recent closed orders (all symbols, last 50, then filter ECHO + show legs)
const closed = await api('/v2/orders?status=closed&limit=100&direction=desc')
console.log('\n=== CLOSED (recent, all) ===')
for (const o of closed.body || []) {
  const isEcho = (o.symbol || '').includes('ECHO')
  const hasLegs = (o.legs || []).length > 0
  if (isEcho || hasLegs) console.log(JSON.stringify(fmt(o)))
}

// 4) recent fill activities for ECHO
const acts = await api('/v2/account/activities/FILL?direction=desc&page_size=30')
console.log('\n=== FILLS (recent 30) ===')
for (const a of acts.body || []) {
  if ((a.symbol || '').includes('ECHO')) console.log(JSON.stringify({ ...a, order_id: String(a.order_id).slice(0, 8) }))
}
console.log('\nDIAG DONE')
