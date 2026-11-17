// v2.12.48 QA — history date range must govern CANCELED rows too.
// User report: Positions → Trade history with "Today" showed old manual
// canceled orders from BEFORE today (the range filtered trades only).
// Fix: /api/trading/history now passes canceled rows through the SAME
// passesRange gate (on updated_at || created_at = what the CLOSED column
// renders for them), wired for trades as well.
//  1. LOGIC probe — the REAL shared passesRange helper:
//     old cancel excluded under Today, today cancel/expiry included,
//     malformed time kept, from/to bounds inclusive, unbounded keeps all.
//  2. HTTP probe — throwaway account over HTTP:
//     unauth → 401; no-keys → 200 configured:false (with + without `from`),
//     i.e. the modified route compiles and serves both shapes.
import { db } from '../src/lib/db'
import { generateTotpSecret, totpCode } from '../src/lib/totp'
import { passesRange } from '../src/lib/trade-history'

let pass = 0
let fail = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — got ${String(got)}, want ${String(want)}`)
}

// ── 1. logic probe on the REAL helper ─────────────────────────────────────
const now = new Date()
const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
const from = todayMidnight
const to = todayMidnight + 86_400_000 - 1 // end of today

const oldCancel = new Date(todayMidnight - 3 * 86_400_000 + 15 * 3600_000).getTime() // 3 days ago 15:00
const todayCancel = todayMidnight + 2 * 3600_000 // today 02:00
check('old cancel (3d ago) excluded under Today', passesRange(oldCancel, from, NaN), false)
check('today cancel included under Today', passesRange(todayCancel, from, NaN), true)
check('today cancel + to-bound included', passesRange(todayCancel, from, to), true)
check('old cancel excluded under custom from..to', passesRange(oldCancel, from, to), false)
check('future cancel excluded by to-bound', passesRange(to + 1000, NaN, to), false)
check('boundary at==from included (inclusive)', passesRange(from, from, to), true)
check('boundary at==to included (inclusive)', passesRange(to, from, to), true)
check('malformed time (NaN) kept — blast-radius rule', passesRange(Number.NaN, from, to), true)
check('unbounded (All) keeps old cancel', passesRange(oldCancel, Number.NaN, Number.NaN), true)
check('unbounded (All) keeps today cancel', passesRange(todayCancel, Number.NaN, Number.NaN), true)

// ── 2. HTTP probe ─────────────────────────────────────────────────────────
const BASE = 'http://localhost:3000'
const USER = `qa48_${Date.now().toString(36)}`
const PASS = 'qa48-pass-1234'

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
check('register', reg.status, 200)

const login = await fetch(`${BASE}/api/auth/register`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})
const { ticket } = (await j(login)) as { ticket?: string }
check('login ticket', !!ticket, true)

const verify = await fetch(`${BASE}/api/auth/login/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ticket, code: totpCode(secret) }),
})
const cookie = (verify.headers.get('set-cookie') || '').split(';')[0]
check('verify cookie', !!cookie, true)

const unauth = await fetch(`${BASE}/api/trading/history?mode=paper&from=${new Date(todayMidnight).toISOString()}`)
check('history unauth → 401', unauth.status, 401)

const histAll = await fetch(`${BASE}/api/trading/history?mode=paper`, { headers: { cookie } })
const histAllJ = (await j(histAll)) as { status?: number; configured?: boolean; trades?: unknown[]; canceled?: unknown[] }
check('history no-keys → 200', histAll.status, 200)
check('history no-keys configured:false', histAllJ.configured, false)
check('history no-keys trades:[]', Array.isArray(histAllJ.trades) && histAllJ.trades.length === 0, true)
check('history no-keys canceled:[]', Array.isArray(histAllJ.canceled) && histAllJ.canceled.length === 0, true)

const histToday = await fetch(
  `${BASE}/api/trading/history?mode=paper&from=${new Date(todayMidnight).toISOString()}`,
  { headers: { cookie } },
)
check('history with from → 200 (route compiles with passesRange)', histToday.status, 200)

// cleanup
const u = await db.user.findUnique({ where: { username: USER } })
if (u) await db.user.delete({ where: { id: u.id } })
console.log(`cleanup: user ${USER} deleted`)

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
