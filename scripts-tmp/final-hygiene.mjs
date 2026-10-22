const H = { 'APCA-API-KEY-ID': process.env.KID, 'APCA-API-SECRET-KEY': process.env.KSEC }
const api = (p) => fetch('https://paper-api.alpaca.markets' + p, { headers: H }).then(r => r.json())
const oo = await api('/v2/orders?status=open&limit=50')
const p = await api('/v2/positions')
console.log('open orders:', JSON.stringify((Array.isArray(oo)?oo:[]).map(o => `${o.symbol}/${o.type}`)))
console.log('positions:', JSON.stringify((Array.isArray(p)?p:[]).map(x => `${x.symbol} ${x.qty}`)))
process.exit(0)
