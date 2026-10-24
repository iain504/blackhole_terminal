// What happened to the AAPL SL leg?
const KEY = process.env.APCA_API_KEY_ID
const SEC = process.env.APCA_API_KEY_SECRET
if (!KEY || !SEC) { console.error('Missing APCA_API_KEY_ID / APCA_API_KEY_SECRET env vars'); process.exit(1) }
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }
const api = async (p) => { const r = await fetch(BASE + p, { headers: H }); const t = await r.text(); try { return JSON.parse(t) } catch { return t } }

const closed = await api('/v2/orders?status=closed&limit=100&direction=desc')
for (const o of closed) {
  if (o.symbol !== 'AAPL') continue
  console.log(JSON.stringify({
    id: String(o.id).slice(0, 8), side: o.side, type: o.type, class: o.order_class,
    qty: o.qty, status: o.status, lim: o.limit_price, stop: o.stop_price,
    role: o.group_role, grp: String(o.group_id || '').slice(0, 8),
    created: o.created_at?.slice(11, 19), canceled: o.canceled_at?.slice(11, 19),
    filledAt: o.filled_at?.slice(11, 19), coid: (o.client_order_id || '').slice(0, 24),
  }))
}
