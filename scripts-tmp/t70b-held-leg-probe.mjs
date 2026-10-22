// Task 70b — probe (a) legal trail_percent range on Alpaca, (b) what PATCH and
// CANCEL do to a HELD (armed OCO sibling) leg, using a DISPOSABLE bracket.
// Everything is cleaned up: bracket canceled / position closed at the end.
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const KEY = decrypt(u.settings.alpacaKeyIdEnc)
const SEC = decrypt(u.settings.alpacaSecretEnc)
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }
const HOST = 'https://paper-api.alpaca.markets'
const alp = async (path, opts) => {
  const r = await fetch(`${HOST}${path}`, { headers: H, ...opts })
  let j = null
  try { j = await r.json() } catch { /* 204 */ }
  return { status: r.status, j }
}
const POST = (body) => alp('/v2/orders', { method: 'POST', body: JSON.stringify(body) })

// ---------- (a) trail_percent legal range: probe with far-from-market BUY trails (never trigger) ----------
console.log('=== trail_percent bounds probes (BUY trailing_stop on F, stop above market — canceled immediately) ===')
const q = await alp('/v2/stocks/F/trades/latest') // IEX feed key works for data? if 403 use hardcoded price
const px = parseFloat(q.j?.trade?.p) || 12
console.log('F last price:', px)
for (const t of [0.05, 0.1, 10, 15, 20]) {
  const r = await POST({ symbol: 'F', qty: '1', side: 'buy', type: 'trailing_stop', time_in_force: 'gtc', trail_percent: String(t) })
  const ok = r.status === 200 && r.j?.id
  console.log(`trail ${String(t).padStart(5)}% -> ${r.status} ${ok ? `ACCEPTED (stop would be ~${(px * (1 + t / 100)).toFixed(2)})` : (r.j?.message || r.j?.code || '').slice(0, 110)}`)
  if (ok) {
    const c = await alp(`/v2/orders/${r.j.id}`, { method: 'DELETE' })
    console.log(`   canceled probe order: ${c.status}`)
  }
}

// ---------- (b) held-leg behavior on a DISPOSABLE bracket ----------
console.log('\n=== disposable bracket: market buy 1xF with TP+SL -> probe held SL leg ===')
const br = await POST({ symbol: 'F', qty: '1', side: 'buy', type: 'market', time_in_force: 'day', order_class: 'bracket', take_profit: { limit_price: (px * 1.5).toFixed(2) }, stop_loss: { stop_price: (px * 0.5).toFixed(2) } })
if (!(br.status === 200 && br.j?.id)) { console.log('bracket failed:', br.status, br.j); process.exit(1) }
console.log('bracket parent:', br.j.id, br.j.status)
// wait for the fill + legs
let legs = []
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000))
  const o = await alp(`/v2/orders/${br.j.id}`)
  if (o.j?.status === 'filled' && o.j?.legs?.length) { legs = o.j.legs; break }
  legs = o.j?.legs || []
}
const tp = legs.find(l => l.type === 'limit')
const sl = legs.find(l => l.type === 'stop' || l.type === 'stop_limit')
console.log('TP leg:', tp?.id, tp?.status, tp?.limit_price, ' | SL leg:', sl?.id, sl?.status, sl?.stop_price)
if (!sl || sl.status !== 'held') { console.log('SL leg not held yet — probing anyway with current status:', sl?.status) }

// probe 1: PATCH the held SL leg
if (sl) {
  const p1 = await alp(`/v2/orders/${sl.id}`, { method: 'PATCH', body: JSON.stringify({ stop_price: (px * 0.4).toFixed(2) }) })
  console.log(`PATCH held SL -> ${p1.status} ${p1.status === 200 ? 'REPLACED: id=' + p1.j.id + ' status=' + p1.j.status + ' stop=' + p1.j.stop_price : (p1.j?.message || JSON.stringify(p1.j)).slice(0, 140)}`)
  if (p1.status !== 200) {
    // probe 2: CANCEL the held SL leg — watch the TP sibling
    const c1 = await alp(`/v2/orders/${sl.id}`, { method: 'DELETE' })
    console.log(`CANCEL held SL -> ${c1.status} ${c1.status >= 400 ? (c1.j?.message || '').slice(0, 140) : 'accepted'}`)
    await new Promise(r => setTimeout(r, 2000))
    const tpAfter = tp ? await alp(`/v2/orders/${tp.id}`) : null
    const slAfter = await alp(`/v2/orders/${sl.id}`)
    console.log(`after cancel: SL status=${slAfter.j?.status} | TP sibling status=${tpAfter.j?.status} (new=survived, canceled=cascade)`)
  }
}

// ---------- cleanup: kill everything this probe created ----------
console.log('\n=== cleanup ===')
const open = await alp('/v2/orders?status=open&limit=500')
let n = 0
for (const o of open.j || []) {
  if (o.symbol === 'F') { await alp(`/v2/orders/${o.id}`, { method: 'DELETE' }); n++ }
}
console.log(`canceled ${n} open F order(s)`)
await new Promise(r => setTimeout(r, 1500))
const pos = await alp('/v2/positions/F')
if (pos.status === 200 && pos.j?.qty) {
  const cl = await alp(`/v2/positions/F`, { method: 'DELETE' })
  console.log(`closed F position (${pos.j.qty} @ ${pos.j.avg_entry_price}):`, cl.status)
} else {
  console.log('no F position left')
}
const poss = await alp('/v2/positions')
console.log('final positions:', poss.j.map(p => p.symbol).join(', '))
process.exit(0)
