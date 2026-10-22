const UID = 'cmvdg6y3m0000pwvpwf9hssbe'
const T = await import('../src/lib/trading.ts')
const A = await import('../src/lib/alpaca.ts')
const mode = await T.resolveTradeMode(UID)
const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC, 'content-type': 'application/json' }
const api = (p) => fetch('https://paper-api.alpaca.markets' + p, { headers: H }).then(r => r.json())

const { quotes } = await A.getQuotes(['F'], UID)
const ref = quotes.find(q => q.symbol === 'F')?.price
console.log('F ref =', ref)

// MANUAL round trip: placeOrderWithExits WITHOUT sourceRef == the trade-ticket path
const buy = await T.placeOrderWithExits(UID, mode, { symbol: 'F', side: 'buy', qty: 1, type: 'market' })
console.log('manual buy:', buy.results[0]?.status, buy.results[0]?.client_order_id?.slice(0, 12), buy.errors)
await new Promise(r => setTimeout(r, 1500))
const sell = await T.placeOrderWithExits(UID, mode, { symbol: 'F', side: 'sell', qty: 1, type: 'market' })
console.log('manual sell:', sell.results[0]?.status, sell.errors)
await new Promise(r => setTimeout(r, 1500))
const pos = await api('/v2/positions').catch(() => [])
console.log('F position after round trip:', (Array.isArray(pos) ? pos : []).find(p => p.symbol === 'F')?.qty ?? 'flat')
process.exit(0)
