// Task 70 follow-up — how did TSLA/SPCX/COIN close? (natural exit vs agent market close)
const { db } = await import('../src/lib/db.ts')
const { decrypt } = await import('../src/lib/crypt.ts')
const u = await db.user.findUnique({ where: { id: 'cmvdg6y3m0000pwvpwf9hssbe' } })
const H = { 'APCA-API-KEY-ID': decrypt(u.settings.alpacaKeyIdEnc), 'APCA-API-SECRET-KEY': decrypt(u.settings.alpacaSecretEnc) }
const HOST = 'https://paper-api.alpaca.markets'

const closed = await fetch(`${HOST}/v2/orders?status=closed&limit=100&direction=desc`, { headers: H }).then(r => r.json())
for (const sym of ['TSLA', 'SPCX', 'COIN']) {
  console.log(`\n=== ${sym} ===`)
  for (const o of closed.filter(o => o.symbol === sym).slice(0, 6)) {
    console.log(JSON.stringify({
      type: o.type, side: o.side, status: o.status, qty: o.qty, filled_avg: o.filled_avg_price,
      limit: o.limit_price, stop: o.stop_price, cls: o.order_class,
      coid: (o.client_order_id || '').slice(0, 36), filled_at: o.filled_at, created_at: o.created_at,
    }))
  }
}
process.exit(0)
