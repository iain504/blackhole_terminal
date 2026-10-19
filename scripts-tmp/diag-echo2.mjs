// Full order JSONs for the ECHO bracket family + stray order.
const KEY = 'PK***ROTATED***'
const SEC = '***ALPACA-SECRET-REMOVED***'
const BASE = 'https://paper-api.alpaca.markets'
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC, 'content-type': 'application/json' }

async function api(path) {
  const r = await fetch(BASE + path, { headers: H })
  const txt = await r.text()
  try { return { status: r.status, body: JSON.parse(txt) } } catch { return { status: r.status, body: txt } }
}

const IDS = {
  '9f400efd': 'parent (filled)',
  '1f51e099': 'TP leg 91.01',
  b00e7139: 'SL leg 82.52',
  a355f9dc: 'stray 13:35:12',
  '4ee146bf': 'manual TP 89',
}

// resolve full ids from the lists
const closed = await api('/v2/orders?status=closed&limit=100&direction=desc')
const open = await api('/v2/orders?status=open&limit=500&nested=true')
const all = [...(closed.body || []), ...(open.body || [])]
const legs = []
for (const o of all) for (const l of o.legs || []) legs.push(l)

const pick = (prefix) => all.find((o) => String(o.id).startsWith(prefix)) || legs.find((o) => String(o.id).startsWith(prefix))

for (const [prefix, label] of Object.entries(IDS)) {
  const o = pick(prefix)
  if (!o) { console.log(`\n=== ${label} (${prefix}) === NOT FOUND`); continue }
  console.log(`\n=== ${label} (${prefix}) ===`)
  console.log(JSON.stringify(o, null, 1))
}

// also show ALL recent ECHO-related activities (not just fills) if any
const acts = await api('/v2/account/activities?direction=desc&page_size=50')
console.log('\n=== ALL ACTIVITIES (recent 50) ===')
for (const a of acts.body || []) {
  if (JSON.stringify(a).includes('ECHO')) console.log(JSON.stringify(a))
}
console.log('\nDONE')
