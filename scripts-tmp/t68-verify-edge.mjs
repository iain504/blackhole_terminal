// Edge-case probe of the new route logic against the LIVE endpoint shapes:
// 1) sweep must NOT resurrect canceled/closed orders (MCD pending family legs
//    must stay in pending, not exits)
// 2) exits must contain exactly the expected legs
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const H = { 'APCA-API-KEY-ID': decrypt(u.settings.alpacaKeyIdEnc), 'APCA-API-SECRET-KEY': decrypt(u.settings.alpacaSecretEnc) }
const HOST = 'https://paper-api.alpaca.markets'
const all = await fetch(`${HOST}/v2/orders?status=all&limit=500&direction=desc&symbols=TSLA,SPCX,MSTR,MCD,COIN,META,NVDA,ECHO`, { headers: H }).then(r => r.json())
const working = all.filter(o => ['new','accepted','pending_new','accepted_for_bidding','pending_replace','held','done_for_day'].includes(o.status))
console.log('sweep rows (working only):', working.length)
for (const o of working.slice(0, 14)) {
  console.log(` ${o.symbol} ${o.type}/${o.side} st=${o.status} cls=${o.order_class || '-'} stop=${o.stop_price || '-'} lim=${o.limit_price || '-'}`)
}
const heldTop = working.filter(o => o.status === 'held')
console.log('held top-level rows:', heldTop.map(o => `${o.symbol}/${o.type}@${o.stop_price || o.limit_price}`).join(', '))
await db.$disconnect()
process.exit(0)
