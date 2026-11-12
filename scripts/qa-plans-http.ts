// v2.12.37 QA — the React > Respond > Review plan ledger:
// register a throwaway account over HTTP and exercise /api/ai-trade/plans:
//  1. POST plans (valid + garbage rows) → sanitize + createMany + supersede
//  2. GET ?active=1 → hydration shape (WAITING rows + executedRecent)
//  3. PATCH transitions (EXECUTED / INVALIDATED, double-transition noop, bogus 400)
//  4. GET ?resolve=1&history=1 → lifecycle stats
//  5. unauthenticated → 401 (unchanged)
// The review math itself is pure (validatePlanSide / planReviewOutcome) and
// probe-checked below directly.
import { db } from '../src/lib/db'
import { generateTotpSecret, totpCode } from '../src/lib/totp'
import { validatePlanSide, planReviewOutcome } from '../src/lib/ai-trade-gates'

const BASE = 'http://localhost:3000'
const USER = `qa37_${Date.now().toString(36)}`
const PASS = 'qa37-pass-1234'

async function j(res: Response) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text.slice(0, 200) }
}

// ---- pure math probes first (no HTTP needed) ----
const g1 = validatePlanSide('buy', 100, 102, 110, 98)
console.log('validatePlanSide buy ok:', g1.ok, 'rr≈', g1.rr?.toFixed(2), '(want true ~2.0)')
const g2 = validatePlanSide('buy', 100, 99, 110, 95) // trigger below price → reject
console.log('validatePlanSide buy trigger<price rejected:', !g2.ok, g2.reason)
const g3 = validatePlanSide('sell', 100, 98, 90, 103)
console.log('validatePlanSide sell ok:', g3.ok, 'rr≈', g3.rr?.toFixed(2))
const g4 = validatePlanSide('sell', 100, 106, 100, 112) // trigger above price → reject
console.log('validatePlanSide sell trigger>price rejected:', !g4.ok, g4.reason)
const g5 = validatePlanSide('buy', 100, 106.1, 115, 100) // >5% band → reject
console.log('validatePlanSide buy band rejected:', !g5.ok, g5.reason)
const r1 = planReviewOutcome('buy', 102, 98, 104)
console.log('review buy 104 → missed-run:', r1.outcome === 'missed-run', 'pnl≈', r1.pnlPct?.toFixed(1))
const r2 = planReviewOutcome('buy', 102, 98, 95)
console.log('review buy 95 → good-wait:', r2.outcome === 'good-wait', 'pnl≈', r2.pnlPct?.toFixed(1))
const r3 = planReviewOutcome('sell', 98, 103, 104)
console.log('review sell 104 → good-wait:', r3.outcome === 'good-wait')
const r4 = planReviewOutcome('sell', 98, 103, 92)
console.log('review sell 92 → missed-run:', r4.outcome === 'missed-run')
const r5 = planReviewOutcome('buy', 102, 98, 100)
console.log('review buy 100 → neutral:', r5.outcome === 'neutral')

// ---- HTTP lifecycle ----
const secret = generateTotpSecret()
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS, totpSecret: secret, totpCode: totpCode(secret) }),
})
console.log('register:', reg.status)

const login = await fetch(`${BASE}/api/auth/register`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})
const { ticket } = (await j(login)) as { ticket?: string }
const verify = await fetch(`${BASE}/api/auth/login/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ticket, code: totpCode(secret) }),
})
const cookie = (verify.headers.get('set-cookie') || '').split(';')[0]
console.log('login+verify:', verify.status, 'cookie?', !!cookie)

const unauth = await fetch(`${BASE}/api/ai-trade/plans?active=1`)
console.log('plans unauth (want 401):', unauth.status)

const H = { 'content-type': 'application/json', cookie }

const mk = (symbol: string, side: 'buy' | 'sell', trigger: number, tp: number, sl: number, rr: number) => ({
  symbol, side, bias: side === 'buy' ? 'long' : 'short', confidence: 70,
  trigger, tp, sl, rr, refPrice: 100, reason: `qa ${symbol}`, regime: 'NEUTRAL', earnings: null, mode: 'paper',
})

const post1 = await fetch(`${BASE}/api/ai-trade/plans`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ plans: [mk('AAPL', 'buy', 102, 110, 98, 2.0), mk('TSLA', 'sell', 98, 90, 103, 1.6)] }),
})
console.log('POST plans:', post1.status, JSON.stringify(await j(post1)))

let act = await fetch(`${BASE}/api/ai-trade/plans?active=1`, { headers: { cookie } })
const actJ = (await j(act)) as { plans: { id: string; symbol: string; side: string; status: string }[]; executedRecent: number }
console.log('GET active:', act.status, 'rows=', actJ.plans?.length, '(want 2) executedRecent=', actJ.executedRecent, '(want 0)')
const aapl = actJ.plans.find((p) => p.symbol === 'AAPL')
const tsla = actJ.plans.find((p) => p.symbol === 'TSLA')

// supersede: a fresh AAPL buy plan replaces the WAITING one
const post2 = await fetch(`${BASE}/api/ai-trade/plans`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ plans: [mk('AAPL', 'buy', 103, 112, 99, 2.2)] }),
})
console.log('POST supersede:', post2.status, JSON.stringify(await j(post2)))
act = await fetch(`${BASE}/api/ai-trade/plans?active=1`, { headers: { cookie } })
const actJ2 = (await j(act)) as { plans: { symbol: string }[] }
console.log('after supersede AAPL rows =', actJ2.plans.filter((p) => p.symbol === 'AAPL').length, '(want 1)')

// transitions
const p1 = await fetch(`${BASE}/api/ai-trade/plans`, { method: 'PATCH', headers: H, body: JSON.stringify({ id: aapl?.id, status: 'EXECUTED', note: 'qa fired' }) })
console.log('PATCH EXECUTED:', p1.status, JSON.stringify(await j(p1)))
const p2 = await fetch(`${BASE}/api/ai-trade/plans`, { method: 'PATCH', headers: H, body: JSON.stringify({ id: tsla?.id, status: 'INVALIDATED', note: 'qa reversed' }) })
console.log('PATCH INVALIDATED:', p2.status, JSON.stringify(await j(p2)))
const p3 = await fetch(`${BASE}/api/ai-trade/plans`, { method: 'PATCH', headers: H, body: JSON.stringify({ id: aapl?.id, status: 'EXPIRED', note: 'double must noop' }) })
console.log('PATCH double (expect noop):', p3.status, JSON.stringify(await j(p3)))
const p4 = await fetch(`${BASE}/api/ai-trade/plans`, { method: 'PATCH', headers: H, body: JSON.stringify({ id: tsla?.id, status: 'BOGUS' }) })
console.log('PATCH bogus (want 400):', p4.status)

// garbage rows dropped
const p5 = await fetch(`${BASE}/api/ai-trade/plans`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ plans: [{ symbol: 'X', side: 'up', confidence: 50, trigger: 1, tp: 2, sl: 0.5, rr: 1, refPrice: 1 }, { symbol: 'Y', side: 'buy', confidence: 50, trigger: 0, tp: 0, sl: 0, rr: 0, refPrice: 0 }] }),
})
console.log('POST garbage (expect stored:0):', p5.status, JSON.stringify(await j(p5)))

// history stats
const hist = await fetch(`${BASE}/api/ai-trade/plans?resolve=1&history=1`, { headers: { cookie } })
const histJ = (await j(hist)) as { stats: Record<string, number> }
console.log('GET history stats:', hist.status, JSON.stringify(histJ.stats))

// cleanup
const u = await db.user.findUnique({ where: { username: USER } })
if (u) {
  await db.aiTradePlan.deleteMany({ where: { userId: u.id } })
  await db.user.delete({ where: { id: u.id } })
}
console.log('cleanup: qa user + plans deleted', USER)
