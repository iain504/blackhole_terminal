// v2.12.36 QA — cross-day history fix: register a throwaway account over
// HTTP and exercise the MODIFIED /api/trading/history route:
//  1. no-keys path → 200 { configured:false, trades:[], canceled:[] }
//  2. module loads with the new consumedPhantomSymbols import (a syntax or
//     contract break would 500 here)
//  3. unauthenticated → 401 (unchanged)
// The FIFO/unanchored/widen logic itself is probe-verified in
// probe-crossday-history.ts (the sandbox has no broker keys — the widen path
// degrades to page-1 exactly as shipped in v2.12.28).
import { db } from '../src/lib/db'
import { generateTotpSecret, totpCode } from '../src/lib/totp'

const BASE = 'http://localhost:3000'
const USER = `qa36_${Date.now().toString(36)}`
const PASS = 'qa36-pass-1234'

async function j(res: Response) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text.slice(0, 200) }
}

const secret = generateTotpSecret()
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS, totpSecret: secret, totpCode: totpCode(secret) }),
})
console.log('register:', reg.status, await j(reg))

const login = await fetch(`${BASE}/api/auth/register`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})
const { ticket } = (await j(login)) as { ticket?: string }
console.log('login:', login.status, 'ticket?', !!ticket)

const verify = await fetch(`${BASE}/api/auth/login/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ticket, code: totpCode(secret) }),
})
const cookie = (verify.headers.get('set-cookie') || '').split(';')[0]
console.log('verify:', verify.status, 'cookie?', !!cookie)

const unauth = await fetch(`${BASE}/api/trading/history?mode=paper`)
console.log('history unauth:', unauth.status, '(want 401)')

const hist = await fetch(`${BASE}/api/trading/history?mode=paper`, { headers: { cookie } })
console.log('history no-keys:', hist.status, JSON.stringify(await j(hist)))

const pos = await fetch(`${BASE}/api/trading/positions?mode=paper`, { headers: { cookie } })
console.log('positions no-keys:', pos.status, JSON.stringify(await j(pos)).slice(0, 160))

// cleanup
const u = await db.user.findUnique({ where: { username: USER } })
if (u) await db.user.delete({ where: { id: u.id } })
console.log('cleanup: user deleted', USER)
