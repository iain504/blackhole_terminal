// Verify the OCO-swap result for ECHO after adding SL via the UI.
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: H })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}

const pos = await api('/v2/positions/ECHO')
console.log('position qty_available:', pos.body?.qty_available, '| qty:', pos.body?.qty)

const open = await api('/v2/orders?status=open&limit=500&nested=true')
console.log('\n--- open ECHO orders (flat+nested) ---')
const flat = []
for (const o of open.body || []) {
  flat.push(o)
  for (const l of o.legs || []) flat.push({ ...l, _parent: o.symbol })
}
for (const o of flat) {
  if (!String(o.symbol).includes('ECHO')) continue
  console.log(JSON.stringify({
    id: String(o.id).slice(0, 8), sym: o.symbol, side: o.side, type: o.type, class: o.order_class,
    qty: o.qty, status: o.status, lim: o.limit_price, stop: o.stop_price,
    role: o.group_role, grp: String(o.group_id || '').slice(0, 8), parent: o._parent || null,
  }))
}

const closed = await api('/v2/orders?status=closed&limit=50&direction=desc')
console.log('\n--- recently closed ECHO orders ---')
for (const o of closed.body || []) {
  if (!String(o.symbol).includes('ECHO')) continue
  if (!['canceled', 'cancelled', 'rejected', 'expired'].includes(o.status)) continue
  if (String(o.id).startsWith('4ee146bf') || String(o.id).startsWith('1f51e099') || String(o.id).startsWith('b00e7139'))
    console.log(JSON.stringify({ id: String(o.id).slice(0, 8), type: o.type, lim: o.limit_price, stop: o.stop_price, status: o.status }))
}
console.log('\nDONE')
