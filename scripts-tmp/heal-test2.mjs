// Heal test v2 — correct leg discovery (top-level after activation).
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
const sellRows = async () => {
  const o = await api('/v2/orders?status=open&limit=500&nested=true')
  const out = []
  for (const x of o.body || []) {
    if (x.symbol === 'AAPL' && x.side === 'sell') out.push(x)
    for (const l of x.legs || []) if (l.symbol === 'AAPL' && l.side === 'sell') out.push({ ...l, _legOf: x.id })
  }
  return out
}

// 1) market bracket AAPL qty 1 (base_price echo retry)
let last = 340
let place = null
for (let i = 0; i < 3 && !place?.body?.id; i++) {
  const tp0 = (last * 1.05).toFixed(2)
  const sl0 = (last * 0.95).toFixed(2)
  console.log(`place attempt ${i}: last=${last} TP=${tp0} SL=${sl0}`)
  place = await api('/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', time_in_force: 'day',
      order_class: 'bracket', take_profit: { limit_price: tp0 }, stop_loss: { stop_price: sl0 },
      client_order_id: 'heal2-' + Date.now() + '-' + i,
    }),
  })
  console.log('  ->', place.status, String(JSON.stringify(place.body)).slice(0, 160))
  if (!place.body?.id && place.body?.base_price) last = parseFloat(place.body.base_price)
}
if (!place?.body?.id) process.exit(1)
const parent = place.body

// 2) wait for fill
let st = parent.status
for (let i = 0; i < 12 && st !== 'filled'; i++) { await sleep(1000); st = (await api(`/v2/orders/${parent.id}`)).body?.status }
console.log('parent:', parent.id.slice(0, 8), st)
if (st !== 'filled') process.exit(1)
await sleep(1500)

// 3) legs are TOP-LEVEL sell orders now — cancel BOTH (simulate the race loss)
let rows = await sellRows()
console.log('open AAPL sell rows:', rows.map((r) => `${r.type}@${r.limit_price || r.stop_price}:${r.status}${r._legOf ? '(leg)' : ''}`).join(', '))
for (const r of rows) {
  const d = await api(`/v2/orders/${r.id}`, { method: 'DELETE' })
  console.log(`cancel ${r.type} ${r.id.slice(0, 8)} -> ${d.status}`)
}
await sleep(2500)
rows = await sellRows()
console.log('after cancel, open AAPL sell rows:', rows.length, '(want 0 = naked position)')
if (rows.length > 0) process.exit(1)

// 4) wait for supervisor heal cycles
console.log('waiting 45s for supervisor heal...')
await sleep(45000)

rows = await sellRows()
console.log('--- AAPL sell rows after heal window ---')
for (const r of rows) console.log(JSON.stringify({ id: r.id.slice(0, 8), type: r.type, class: r.order_class, status: r.status, lim: r.limit_price, stop: r.stop_price, role: r.group_role }))
const tp = rows.find((r) => r.type === 'limit')
const sl = rows.find((r) => r.type === 'stop' || r.type === 'stop_limit')
console.log(tp && sl ? `HEAL OK: TP=${tp.limit_price} SL=${sl.stop_price} (planned ${(last * 1.05).toFixed(2)} / ${(last * 0.95).toFixed(2)})` : 'HEAL FAILED — no OCO legs')

// 5) cleanup
for (const r of rows) if (!r._legOf) await api(`/v2/orders/${r.id}`, { method: 'DELETE' })
await sleep(1500)
const pos = await api('/v2/positions/AAPL')
if (pos.status === 200) console.log('cleanup close AAPL ->', (await api('/v2/positions/AAPL', { method: 'DELETE' })).status)
console.log('HEAL TEST V2 DONE')
