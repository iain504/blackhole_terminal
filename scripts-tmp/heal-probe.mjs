// Manually walk the supervisor heal conditions against real data.
const KEY = process.env.APCA_API_KEY_ID
const SEC = process.env.APCA_API_KEY_SECRET
if (!KEY || !SEC) { console.error('Missing APCA_API_KEY_ID / APCA_API_KEY_SECRET env vars'); process.exit(1) }
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }
const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { headers: H, ...opts })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) place + fill a bracket
let last = 340
let place = null
for (let i = 0; i < 3 && !place?.body?.id; i++) {
  place = await api('/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', time_in_force: 'day',
      order_class: 'bracket',
      take_profit: { limit_price: (last * 1.05).toFixed(2) },
      stop_loss: { stop_price: (last * 0.95).toFixed(2) },
      client_order_id: 'heal3-' + Date.now() + '-' + i,
    }),
  })
  if (!place.body?.id && place.body?.base_price) last = parseFloat(place.body.base_price)
}
const parent = place.body
let st = parent.status
for (let i = 0; i < 12 && st !== 'filled'; i++) { await sleep(1000); st = (await api(`/v2/orders/${parent.id}`)).body?.status }
console.log('parent', parent.id.slice(0, 8), st)
await sleep(1200)

// 2) cancel the TP leg (held SL cascades)
const open = await api('/v2/orders?status=open&limit=500&nested=true')
for (const o of open.body || []) {
  if (o.symbol === 'AAPL' && o.side === 'sell') {
    console.log('canceling', o.type, o.id.slice(0, 8), '->', (await api(`/v2/orders/${o.id}`, { method: 'DELETE' })).status)
  }
}
await sleep(2500)

// 3) replicate the cycle's fetch + conditions
const orders = (await api('/v2/orders?status=all&limit=500&direction=desc')).body
const positions = (await api('/v2/positions')).body
const norm = (s) => String(s).replace('/', '').toUpperCase()
const posSet = new Set(positions.map((p) => norm(p.symbol)))
console.log('positions:', [...posSet].join(','))
const OCO_OPEN = ['new', 'open', 'accepted', 'pending_new', 'held', 'partially_filled']

for (const o of orders) {
  if ((o.asset_class === 'crypto' || o.symbol.includes('/')) || o.status !== 'filled') continue
  const isBracket = String(o.order_class || '') === 'bracket' || o.group_role === 'entry'
  if (!isBracket) continue
  if (o.symbol !== 'AAPL') continue
  console.log('\nCANDIDATE parent', o.id.slice(0, 8), 'grp', String(o.group_id).slice(0, 8), 'filled_at', o.filled_at)
  const family = orders.filter((x) => x.group_id && x.group_id === o.group_id && x.id !== o.id)
  console.log('  family:', family.map((l) => `${l.type}:${l.status}:${l.limit_price || l.stop_price}:role=${l.group_role}`).join(' | ') || 'EMPTY')
  if (family.length === 0) { console.log('  -> SKIP: no family rows in status=all'); continue }
  if (family.some((l) => OCO_OPEN.includes(l.status))) { console.log('  -> SKIP: a leg is alive'); continue }
  const tpLeg = family.find((l) => l.group_role === 'take_profit')
  const slLeg = family.find((l) => l.group_role === 'stop_loss')
  const tp = tpLeg ? parseFloat(tpLeg.limit_price || '') : NaN
  const sl = slLeg ? parseFloat(slLeg.stop_price || '') : NaN
  console.log('  tp=', tp, 'sl=', sl)
  if (!Number.isFinite(tp) && !Number.isFinite(sl)) { console.log('  -> SKIP: no prices'); continue }
  if (!posSet.has(norm(o.symbol))) { console.log('  -> SKIP: no position'); continue }
  const openNow = await api('/v2/orders?status=open&limit=500&nested=true')
  const exitSide = o.side === 'buy' ? 'sell' : 'buy'
  const hasExit = (openNow.body || []).some((x) => norm(x.symbol) === norm(o.symbol) && x.side === exitSide && OCO_OPEN.includes(x.status) && x.status !== 'held')
  console.log('  hasExit:', hasExit)
  if (hasExit) { console.log('  -> SKIP: exits exist'); continue }
  console.log('  => ALL CONDITIONS PASS — supervisor should attach OCO now')
}
console.log('\nleaving state for 40s...')
await sleep(40000)
const after = await api('/v2/orders?status=open&limit=500&nested=true')
const rows = []
for (const x of after.body || []) {
  if (x.symbol === 'AAPL' && x.side === 'sell') rows.push(x)
  for (const l of x.legs || []) if (l.symbol === 'AAPL' && l.side === 'sell') rows.push({ ...l, _leg: 1 })
}
console.log('after 40s, AAPL sell rows:', JSON.stringify(rows.map((r) => `${r.type}@${r.limit_price || r.stop_price}:${r.status}`)))
console.log('DONE (position left OPEN for inspection)')
