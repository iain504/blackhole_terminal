// Task 70b probe 2 — decisive held-leg checks on a SECOND disposable bracket:
//  1. after PATCHing the held SL leg, is the NEW order still a leg of the
//     filled parent (OCO family intact) and still held?
//  2. CANCEL the held leg — does the working TP sibling survive or cascade?
// Full cleanup at the end (account back to exactly ECHO, META, MSTR, NVDA).
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
const px = 12
const POST = (body) => alp('/v2/orders', { method: 'POST', body: JSON.stringify(body) })

console.log('=== bracket 2: buy 1xF, TP 18 / SL 6 ===')
const br = await POST({ symbol: 'F', qty: '1', side: 'buy', type: 'market', time_in_force: 'day', order_class: 'bracket', take_profit: { limit_price: '18' }, stop_loss: { stop_price: '6' } })
let legs = []
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000))
  const o = await alp(`/v2/orders/${br.j.id}`)
  if (o.j?.status === 'filled' && o.j?.legs?.length) { legs = o.j.legs; break }
}
const tp = legs.find(l => l.type === 'limit')
const sl = legs.find(l => l.type === 'stop' || l.type === 'stop_limit')
console.log('parent filled:', (await alp(`/v2/orders/${br.j.id}`)).j?.status, '| TP', tp?.id, tp?.status, '| SL', sl?.id, sl?.status)

// --- 1) PATCH held leg, then check family membership ---
console.log('\n--- 1) PATCH held SL 6 -> 5, then GET parent legs ---')
const p1 = await alp(`/v2/orders/${sl.id}`, { method: 'PATCH', body: JSON.stringify({ stop_price: '5' }) })
console.log(`PATCH -> ${p1.status} id=${p1.j?.id} status=${p1.j?.status} stop=${p1.j?.stop_price}`)
const parent2 = await alp(`/v2/orders/${br.j.id}`)
const legIds = (parent2.j?.legs || []).map(l => `${l.type}:${l.status}`)
console.log('parent legs now:', JSON.stringify(legIds), '| patched id in legs:', (parent2.j?.legs || []).some(l => l.id === p1.j?.id))

// --- 2) CANCEL the held leg — watch the TP sibling ---
console.log('\n--- 2) CANCEL the (patched) held SL leg ---')
const c1 = await alp(`/v2/orders/${p1.j?.id}`, { method: 'DELETE' })
console.log(`CANCEL held SL -> ${c1.status}`)
await new Promise(r => setTimeout(r, 2500))
const slAfter = await alp(`/v2/orders/${p1.j?.id}`)
const tpAfter = await alp(`/v2/orders/${tp.id}`)
console.log(`SL status after cancel: ${slAfter.j?.status} | TP sibling status: ${tpAfter.j?.status} (new => survived / canceled => cascade)`)

// --- cleanup ---
console.log('\n=== cleanup ===')
const open = await alp('/v2/orders?status=open&limit=500')
for (const o of open.j || []) {
  if (o.symbol === 'F') { await alp(`/v2/orders/${o.id}`, { method: 'DELETE' }) }
}
// cancel any held F legs too (status=all sweep, they are invisible to status=open)
const all = await alp(`/v2/orders?status=all&limit=500&direction=desc&symbols=F`)
for (const o of all.j || []) {
  if (['new', 'accepted', 'pending_new', 'held'].includes(o.status)) {
    const c = await alp(`/v2/orders/${o.id}`, { method: 'DELETE' })
    console.log(`cancel leftover ${o.type} ${o.status}: ${c.status}`)
  }
}
await new Promise(r => setTimeout(r, 1500))
const pos = await alp('/v2/positions/F')
if (pos.status === 200 && pos.j?.qty) {
  console.log('closing F position:', (await alp('/v2/positions/F', { method: 'DELETE' })).status)
} else {
  console.log('no F position left')
}
const poss = await alp('/v2/positions')
console.log('final positions:', poss.j.map(p => p.symbol).join(', '))
process.exit(0)
