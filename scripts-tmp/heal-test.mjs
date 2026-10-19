// Heal test: 1) place a market bracket (AAPL qty 1, TP +5% / SL -5%);
// 2) wait for fill; 3) cancel BOTH legs (simulating the Alpaca replace/fill
// race that killed the user's ECHO legs); 4) wait for the app's OCO
// supervisor to heal the naked position; 5) verify OCO legs re-attached.
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }
const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { headers: H, ...opts })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) market bracket (retry with echoed base_price on 422)
let last = 270
let place = null
for (let i = 0; i < 3 && !place?.body?.id; i++) {
  const tp0 = (last * 1.05).toFixed(2)
  const sl0 = (last * 0.95).toFixed(2)
  console.log(`attempt ${i}: AAPL last=${last} TP=${tp0} SL=${sl0}`)
  place = await api('/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', time_in_force: 'day',
      order_class: 'bracket',
      take_profit: { limit_price: tp0 },
      stop_loss: { stop_price: sl0 },
      client_order_id: 'heal-test-' + Date.now() + '-' + i,
    }),
  })
  console.log('  ->', place.status, JSON.stringify(place.body).slice(0, 220))
  if (!place.body?.id && place.body?.base_price) last = parseFloat(place.body.base_price)
}
if (!place?.body?.id) process.exit(1)
const parent = place.body
const tpPx = parseFloat(parent.legs?.find((l) => l.type === 'limit')?.limit_price || last * 1.05)
const slPx = parseFloat(parent.legs?.find((l) => l.type === 'stop')?.stop_price || last * 0.95)
console.log(`parent ${parent.id} created; planned TP=${tpPx} SL=${slPx}`)

// 2) wait for fill
let status = parent.status
for (let i = 0; i < 10 && status !== 'filled'; i++) {
  await sleep(1000)
  const o = await api(`/v2/orders/${parent.id}`)
  status = o.body?.status
}
console.log('parent status:', status)
if (status !== 'filled') process.exit(1)

// 3) find + cancel both legs
const open = await api('/v2/orders?status=open&limit=500&nested=true')
const flat = []
for (const o of open.body || []) for (const l of o.legs || []) if (l.symbol === 'AAPL') flat.push(l)
const legs = flat.filter((l) => l.side === 'sell')
console.log('legs found:', legs.map((l) => `${l.type}@${l.limit_price || l.stop_price}:${l.status}`).join(', '))
for (const l of legs) {
  const d = await api(`/v2/orders/${l.id}`, { method: 'DELETE' })
  console.log(`cancel ${l.type} ${String(l.id).slice(0, 8)} ->`, d.status)
}
await sleep(2000)

// confirm both legs canceled
const open2 = await api('/v2/orders?status=open&limit=500&nested=true')
const stillOpen = []
for (const o of open2.body || []) for (const l of o.legs || []) if (l.symbol === 'AAPL' && l.side === 'sell') stillOpen.push(l)
const topOpen = (open2.body || []).filter((o) => o.symbol === 'AAPL' && o.side === 'sell')
console.log('AAPL sell legs still open after cancel:', stillOpen.length, '| top-level sell orders:', topOpen.length)

// 4) wait for supervisor cycles to heal (browser keeps the supervisor alive)
console.log('waiting 40s for supervisor heal cycles...')
await sleep(40000)

const open3 = await api('/v2/orders?status=open&limit=500&nested=true')
const healed = []
for (const o of open3.body || []) {
  if (o.symbol !== 'AAPL' || o.side !== 'sell') continue
  healed.push(o)
  for (const l of o.legs || []) healed.push({ ...l, _leg: true })
}
console.log('--- AAPL sell orders after heal window ---')
for (const o of healed) {
  console.log(JSON.stringify({
    id: String(o.id).slice(0, 8), type: o.type, class: o.order_class, status: o.status,
    lim: o.limit_price, stop: o.stop_price, role: o.group_role, leg: !!o._leg,
  }))
}
const tp = healed.find((o) => o.type === 'limit')
const sl = healed.find((o) => o.type === 'stop' || o.type === 'stop_limit')
const ok = tp && sl && parseFloat(tp.limit_price) === tpPx && parseFloat(sl.stop_price) === slPx
console.log(ok ? `HEAL OK: OCO legs restored at TP=${tp.limit_price} SL=${sl.stop_price}` : 'HEAL FAILED or prices differ')

// 5) cleanup: cancel exits + close position
for (const o of healed) {
  if (o._leg) continue
  await api(`/v2/orders/${o.id}`, { method: 'DELETE' })
}
await sleep(1500)
const pos = await api('/v2/positions/AAPL')
if (pos.status === 200) {
  const c = await api('/v2/positions/AAPL', { method: 'DELETE' })
  console.log('cleanup close AAPL ->', c.status)
}
console.log('HEAL TEST DONE')
