// Task 67 — find the PATCH body Alpaca accepts for changing a trailing_stop's %
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const H = { 'APCA-API-KEY-ID': decrypt(u.settings.alpacaKeyIdEnc), 'APCA-API-SECRET-KEY': decrypt(u.settings.alpacaSecretEnc), 'content-type': 'application/json' }
const HOST = 'https://paper-api.alpaca.markets'
const ID = '3daf6405-88dc-4f0f-8cfe-26233f087ab9' // NVDA trailing_stop, trail 2%, stop 216.6486

const tryPatch = async (label, body) => {
  const r = await fetch(`${HOST}/v2/orders/${ID}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  console.log(`${label} -> ${r.status}`, r.ok
    ? JSON.stringify({ trail: j.trail_percent, stop: j.stop_price, id: j.id })
    : JSON.stringify(j?.message ?? j)?.slice(0, 140))
  return { status: r.status, j }
}

// A: trail only (number)
await tryPatch('A trail_percent number', { trail_percent: 2.5 })
// B: trail + current stop_price
await tryPatch('B trail+stop', { trail_percent: 2.5, stop_price: '216.6486' })
// C: full shape: qty/side/type/tif/duration + trail
await tryPatch('C trail+type+tif', { trail_percent: 2.5, type: 'trailing_stop', time_in_force: 'gtc' })
// D: trail only, string, different value formatting
await tryPatch('D trail string 2.50', { trail_percent: '2.50' })
