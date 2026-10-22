// Task 70b — LIVE REPRO of every trail-edit path in the current codebase.
// The user reports "update existing SL Trail percentage STILL does not work".
// Lib-level check against the REAL NVDA trailing stop (sell trail 2%):
//   1. 2% -> 2.6% via replaceExitOrderSmart (the path patchExitTrailPct hits)
//   2. no-op patch at 2.6% (must return note "Order already at this value", same id)
//   3. restore to exactly 2% (verify landed on Alpaca)
// Everything is restored — the order ends at trail 2% as the user left it.
const { replaceExitOrderSmart } = await import('../src/lib/trading.ts')
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')

const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const u = await db.user.findUnique({ where: { id: UID } })
const KEY = decrypt(u.settings.alpacaKeyIdEnc)
const SEC = decrypt(u.settings.alpacaSecretEnc)
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC }
const HOST = 'https://paper-api.alpaca.markets'

const alp = async (path, opts) => {
  const r = await fetch(`${HOST}${path}`, { headers: H, ...opts })
  const j = await r.json().catch(() => null)
  return { status: r.status, j }
}

// locate the CURRENT NVDA trailing stop (id churns on every replace)
const orders = await alp(`/v2/orders?status=all&limit=500&direction=desc&symbols=NVDA`)
const trail = (orders.j || []).find(o => o.type === 'trailing_stop' && ['new', 'accepted', 'pending_new', 'held'].includes(o.status))
if (!trail) { console.log('NO WORKING NVDA TRAILING STOP — abort'); process.exit(1) }
console.log(`START: NVDA trailing_stop id=${trail.id} trail=${trail.trail_percent}% stop=${trail.stop_price} status=${trail.status}`)
const origTrail = parseFloat(trail.trail_percent)
const origId = trail.id

const show = (label, r) => console.log(JSON.stringify({
  step: label, ok: !!r.data, status: r.status, method: r.method, note: r.note,
  error: r.error, trail: r.data?.trail_percent, id: r.data?.id, stop: r.data?.stop_price,
}))

// --- step 1: 2 -> 2.6 ---
let id = origId
const r1 = await replaceExitOrderSmart(UID, 'paper', id, { trail_percent: 2.6, crypto: false })
show('1: 2% -> 2.6%', r1)
if (r1.data?.id) id = r1.data.id

// --- verify on Alpaca ---
const v1 = await alp(`/v2/orders/${id}`)
console.log(`VERIFY1: id=${v1.j?.id} trail=${v1.j?.trail_percent} status=${v1.j?.status} (expect trail 2.6, ${v1.j?.id === origId ? 'SAME id ⚠️' : 'NEW id'})`)

// --- step 2: no-op patch at the SAME value (must short-circuit honestly) ---
const r2 = await replaceExitOrderSmart(UID, 'paper', id, { trail_percent: 2.6, crypto: false })
show('2: no-op 2.6% (expect note + no churn)', r2)
if (r2.data?.id) id = r2.data.id

// --- step 3: restore to the user's original % ---
const r3 = await replaceExitOrderSmart(UID, 'paper', id, { trail_percent: origTrail, crypto: false })
show(`3: restore ${origTrail}%`, r3)
if (r3.data?.id) id = r3.data.id
const v3 = await alp(`/v2/orders/${id}`)
console.log(`VERIFY3 (restored): id=${v3.j?.id} trail=${v3.j?.trail_percent} status=${v3.j?.status} stop=${v3.j?.stop_price} (expect trail ${origTrail})`)
console.log(origTrail === parseFloat(v3.j?.trail_percent) ? 'RESTORE OK — trail matches the user original' : 'RESTORE MISMATCH ⚠️')
process.exit(0)
