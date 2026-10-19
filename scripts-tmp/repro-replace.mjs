// Reproduce the re-place POST that failed with "bracket orders require stop_loss.stop_price"
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

// exactly what exitBodyFrom built for the OCO parent
const body = {
  symbol: 'SPCX', qty: '10', side: 'buy', type: 'limit',
  time_in_force: 'gtc', limit_price: '144.50',
}
const r = await fetch(BASE + '/v2/orders', { method: 'POST', headers: H, body: JSON.stringify(body) })
const txt = await r.text()
console.log('PLAIN LIMIT POST ->', r.status, txt.slice(0, 300))

// if it succeeded, cancel it right away (we only wanted the verdict)
try {
  const o = JSON.parse(txt)
  if (o && o.id) {
    const c = await fetch(`${BASE}/v2/orders/${o.id}`, { method: 'DELETE', headers: H })
    console.log('cleanup cancel ->', c.status)
  }
} catch {}
