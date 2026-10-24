// Probe Alpaca paper API: what happens when you PATCH / DELETE one leg of an
// active bracket order (stock TP/SL)? Ground-truth for the drag bug.
const KEY = process.env.APCA_API_KEY_ID
const SEC = process.env.APCA_API_KEY_SECRET
if (!KEY || !SEC) { console.error('Missing APCA_API_KEY_ID / APCA_API_KEY_SECRET env vars'); process.exit(1) }
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { headers: H, ...opts })
  const txt = await r.text()
  let body = null
  try { body = JSON.parse(txt) } catch { body = txt }
  return { status: r.status, body }
}

const log = (...a) => console.log(...a)

// 1) place a market bracket on AAPL (1 qty, TP +15%, SL -15%)
// data endpoints 404 on this key — seed from the last 422 base_price echo
let last = 342.62
// fall back to the base_price Alpaca echoes in a 422
let place = null
for (let i = 0; i < 3 && !place?.body?.id; i++) {
  const tp0 = (last * 1.15).toFixed(2)
  const sl0 = (last * 0.85).toFixed(2)
  log(`AAPL last=${last} -> TP=${tp0} SL=${sl0}`)
  place = await api('/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', time_in_force: 'day',
      order_class: 'bracket',
      take_profit: { limit_price: tp0 },
      stop_loss: { stop_price: sl0 },
      client_order_id: 'probe-bracket-' + Date.now() + '-' + i,
    }),
  })
  log('place:', place.status, JSON.stringify(place.body).slice(0, 300))
  if (!place.body?.id && place.body?.base_price) last = parseFloat(place.body.base_price)
}
if (!place?.body?.id) process.exit(1)
const parentId = place.body.id

await new Promise((r) => setTimeout(r, 1500))

// 2) find legs (open orders flat list)
const open = await api('/v2/orders?status=open&limit=500')
const flat = []
for (const o of open.body || []) {
  flat.push(o)
  for (const l of o.legs || []) flat.push(l)
}
const tpLeg = flat.find((o) => o.type === 'limit' && o.side === 'sell' && o.symbol === 'AAPL')
const slLeg = flat.find((o) => (o.type === 'stop' || o.type === 'stop_limit') && o.side === 'sell' && o.symbol === 'AAPL')
log('legs:', { tp: tpLeg?.id, tpPx: tpLeg?.limit_price, sl: slLeg?.id, slPx: slLeg?.stop_price })
if (!tpLeg || !slLeg) { log('!! legs not found; open list=', JSON.stringify(open.body).slice(0, 800)); process.exit(1) }

// 3) TEST A — direct PATCH on the TP leg
const pa = await api(`/v2/orders/${tpLeg.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ limit_price: (last * 1.2).toFixed(2) }),
})
log('PATCH leg:', pa.status, JSON.stringify(pa.body).slice(0, 400))

await new Promise((r) => setTimeout(r, 1200))
const openA = await api('/v2/orders?status=open&limit=500')
const flatA = []
for (const o of openA.body || []) { flatA.push(o); for (const l of o.legs || []) flatA.push(l) }
const tpA = flatA.find((o) => o.type === 'limit' && o.side === 'sell' && o.symbol === 'AAPL')
const slA = flatA.find((o) => (o.type === 'stop' || o.type === 'stop_limit') && o.side === 'sell' && o.symbol === 'AAPL')
log('after PATCH leg -> TP:', tpA ? `${tpA.id} @ ${tpA.limit_price} (client=${(tpA.client_order_id || '').slice(0, 20)})` : 'GONE',
  '| SL:', slA ? `${slA.id} @ ${slA.stop_price}` : 'GONE')

// 4) TEST B — DELETE the surviving SL leg, see the cascade
if (slA) {
  const del = await api(`/v2/orders/${slA.id}`, { method: 'DELETE' })
  log('DELETE SL leg:', del.status, del.body ? JSON.stringify(del.body).slice(0, 200) : '(no body)')
  await new Promise((r) => setTimeout(r, 1200))
  const openB = await api('/v2/orders?status=open&limit=500')
  const flatB = []
  for (const o of openB.body || []) { flatB.push(o); for (const l of o.legs || []) flatB.push(l) }
  const tpB = flatB.find((o) => o.type === 'limit' && o.side === 'sell' && o.symbol === 'AAPL')
  const slB = flatB.find((o) => (o.type === 'stop' || o.type === 'stop_limit') && o.side === 'sell' && o.symbol === 'AAPL')
  log('after DELETE SL -> TP:', tpB ? tpB.id : 'GONE', '| SL:', slB ? slB.id : 'GONE')
}

// 5) cleanup: cancel parent family + close position
await api(`/v2/orders/${parentId}`).then(async (o) => {
  const id = o.body?.replaced_by || parentId
  return api(`/v2/orders/${id}`, { method: 'DELETE' })
})
const pos = await api('/v2/positions/AAPL')
if (pos.status === 200) {
  await api('/v2/positions/AAPL', { method: 'DELETE', headers: { ...H } })
  log('cleanup: closed AAPL position')
}
log('PROBE DONE')
