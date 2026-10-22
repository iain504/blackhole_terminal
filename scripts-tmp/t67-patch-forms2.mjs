// Task 67 — round 2: find the PATCH body Alpaca accepts for trailing_stop %
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
    : JSON.stringify(j?.message ?? j)?.slice(0, 150))
}

await tryPatch('I trail+penny-stop', { trail_percent: 2.5, stop_price: '216.65' })
await tryPatch('J qty-only (patchable?)', { qty: 1 })
await tryPatch('K trail 2.5 w/ qty string', { trail_percent: 2.5, qty: '1' })
await tryPatch('L trail_percent 2.500000', { trail_percent: '2.500000' })
