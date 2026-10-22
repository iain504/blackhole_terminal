const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const T = await import('../src/lib/trading.ts')
const A = await import('../src/lib/alpaca.ts')
const mode = await T.resolveTradeMode(UID)
const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC, 'content-type': 'application/json' }
const api = (p) => fetch('https://paper-api.alpaca.markets' + p, { headers: H }).then(r => r.json())

// queued GTC limit OTO with SL-only (simulates a weekend/pre-market algo entry)
const { quotes: fq } = await A.getQuotes(['F'], UID)
const fref = fq.find(q => q.symbol === 'F')?.price
const r1 = await T.placeOrderWithExits(UID, mode, { symbol: 'F', side: 'buy', qty: 1, type: 'limit', limit_price: Math.round(fref * 0.94 * 100) / 100, time_in_force: 'gtc', stop_loss: Math.round(fref * 0.92 * 100) / 100 })
const o1 = r1.results[0]
console.log('queued OTO:', JSON.stringify({ n: r1.results.length, status: o1?.status, cls: o1?.order_class, errors: r1.errors }))
const legs0 = await api('/v2/orders/' + o1.id + '?nested=true')
console.log('  queued legs:', JSON.stringify((legs0.legs || []).map(l => ({ t: l.type, st: l.status, stop: l.stop_price, role: l.group_role }))))

// drag the SL on the QUEUED one-sided parent (replacePendingEntrySmart rebuild)
const newSl = Math.round(fref * 0.9 * 100) / 100
const rep = await T.replacePendingEntrySmart(UID, mode, o1.id, { sl: newSl })
console.log('SL drag replace:', JSON.stringify({ status: rep.status, method: rep.method, note: rep.note, error: rep.error }))
if (rep.data?.id) {
  const legs1 = await api('/v2/orders/' + rep.data.id + '?nested=true')
  console.log('  replacement:', JSON.stringify({ cls: legs1.order_class, status: legs1.status, legs: (legs1.legs || []).map(l => ({ t: l.type, st: l.status, stop: l.stop_price })) }))
}

// cleanup
const c = await fetch('https://paper-api.alpaca.markets/v2/orders/' + (rep.data?.id || o1.id), { method: 'DELETE', headers: H })
console.log('cleanup cancel ->', c.status)
process.exit(0)
