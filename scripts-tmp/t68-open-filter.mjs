// Does status=open include held bracket legs? And what does nested=true look like?
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const H = { 'APCA-API-KEY-ID': decrypt(u.settings.alpacaKeyIdEnc), 'APCA-API-SECRET-KEY': decrypt(u.settings.alpacaSecretEnc) }
const HOST = 'https://paper-api.alpaca.markets'

const open = await fetch(`${HOST}/v2/orders?status=open&limit=100`, { headers: H }).then(r => r.json())
console.log('--- status=open flat:', open.length, 'orders')
for (const o of open) {
  if (o.symbol === 'TSLA' || (o.legs||[]).some(l => l.symbol === 'TSLA')) {
    console.log(JSON.stringify({ id: o.id.slice(-8), type: o.type, side: o.side, status: o.status, cls: o.order_class, stop: o.stop_price, limit: o.limit_price, legs: (o.legs||[]).map(l => ({ id: l.id.slice(-8), type: l.type, status: l.status, side: l.side, stop: l.stop_price })) }))
  }
}
const held = open.filter(o => o.status === 'held')
console.log('--- held count in open:', held.length, held.map(o => `${o.symbol}/${o.type}/${o.id.slice(-8)}`))

const nested = await fetch(`${HOST}/v2/orders?status=open&limit=100&nested=true`, { headers: H }).then(r => r.json())
console.log('--- nested=true top-level count:', nested.length)
for (const o of nested) {
  if ((o.legs||[]).length || o.symbol === 'TSLA') {
    console.log(JSON.stringify({ id: o.id.slice(-8), sym: o.symbol, type: o.type, status: o.status, cls: o.order_class, legs: (o.legs||[]).map(l => ({ id: l.id.slice(-8), type: l.type, status: l.status, side: l.side, stop: l.stop_price, limit: l.limit_price })) }))
  }
}
process.exit(0)
