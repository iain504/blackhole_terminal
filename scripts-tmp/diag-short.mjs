// Diagnostic: what does Alpaca report for a SHORT position's qty fields?
// Read-only — no POST/DELETE/PATCH.
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

async function api(path) {
  const r = await fetch(BASE + path, { headers: H })
  const txt = await r.text()
  let body = null
  try { body = JSON.parse(txt) } catch { body = txt }
  return { status: r.status, body }
}

const pos = await api('/v2/positions')
console.log('=== ALL POSITIONS ===', pos.status)
for (const p of pos.body || []) {
  console.log(JSON.stringify({
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    qty_available: p.qty_available,
    avg: p.avg_entry_price,
    asset_class: p.asset_class,
  }))
}

const open = await api('/v2/orders?status=open&limit=500')
console.log('\n=== OPEN ORDERS ===', open.status)
for (const o of open.body || []) {
  console.log(JSON.stringify({
    id: String(o.id).slice(0, 8),
    sym: o.symbol, side: o.side, type: o.type, class: o.order_class,
    qty: o.qty, filled: o.filled_qty, status: o.status,
    lim: o.limit_price, stop: o.stop_price,
    coid: (o.client_order_id || '').slice(0, 24),
  }))
}
console.log('\nDIAG DONE')
