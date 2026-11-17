// v2.12.49 QA — AI TRADE REVIEW (智慧複盤) pipeline guards.
//  1. PURE-HELPER probe (the real lib functions):
//     · classifySession — ET pre/regular/post/overnight/weekend boundaries,
//       crypto-24h, and the DST-neutral fixed-offset equivalents
//     · computeExcursions — long/short mirroring, partial window, ATR units,
//       degenerate inputs null, bars outside the window ignored
//     · atrAtEntry — point-in-time (bars strictly before entry), warm-up null
//     · volumeRatioAtEntry — pulse vs prior-20 mean, insufficient bars null
//     · slippageBps — buy/sell direction sign, market/null limits null
//     · excursionTimeframe — 15m for ≤2d windows, 1h beyond
//     · buildAuditBatches — 5-10 clamp, remainder batch, exact counts
//     · parseAuditOutput — hallucinated trade_id DROPPED, quadrant whitelist,
//       score clamp 1-10, tag whitelist, capped text, fenced-JSON extraction,
//       total garbage → null
//     · ruleDedupeKey — stable across formatting noise
//     · rankCandidates — confidence × frequency × recency
//     · matchActiveRules — session tag matching + cap 7 + empty-tags pass
//  2. HTTP probe — throwaway account: unauth 401 on both routes, no-keys
//     audit POST → honest configured:false error, GET shapes, rules POST
//     unknown-action 400; modified route compiles.
import { db } from '../src/lib/db'
import { generateTotpSecret, totpCode } from '../src/lib/totp'
import {
  classifySession, isExtendedLike, computeExcursions, atrAtEntry,
  volumeRatioAtEntry, slippageBps, excursionTimeframe, buildAuditBatches,
  parseAuditOutput, ruleDedupeKey, rankCandidates, matchActiveRules,
  QUADRANTS, TAG_WHITELIST,
} from '../src/lib/trade-review'
import type { Bar } from '../src/lib/market-types'

let pass = 0
let fail = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const near = (a: number | null, b: number, eps = 1e-6) => a != null && Math.abs(a - b) < eps

// ── 1a. session classification (fixed unix times; ET offsets include DST) ──
// 2026-07-15 (EDT, UTC-4): 13:00 UTC = 09:00 ET (pre); 14:00 UTC = 10:00 ET (regular)
check('session pre (09:00 ET summer)', classifySession('2026-07-15T13:00:00Z'), 'pre')
check('session regular (10:00 ET summer)', classifySession('2026-07-15T14:00:00Z'), 'regular')
check('session regular boundary 09:30', classifySession('2026-07-15T13:30:00Z'), 'regular')
check('session post (16:30 ET summer)', classifySession('2026-07-15T20:30:00Z'), 'post')
check('session overnight (03:00 ET summer)', classifySession('2026-07-15T07:00:00Z'), 'overnight')
// 2026-07-18 is a Saturday
check('session weekend', classifySession('2026-07-18T15:00:00Z'), 'weekend')
// winter (EST, UTC-5): 14:30 UTC = 09:30 ET
check('session regular boundary winter', classifySession('2026-01-15T14:30:00Z'), 'regular')
check('session pre boundary winter 04:00 ET', classifySession('2026-01-15T09:00:00Z'), 'pre')
check('crypto always 24h', classifySession('2026-07-18T15:00:00Z', 'crypto'), 'crypto-24h')
check('extended-like: pre/post/overnight/weekend true', [isExtendedLike('pre'), isExtendedLike('post'), isExtendedLike('overnight'), isExtendedLike('weekend')].every(Boolean), true)
check('extended-like: regular false', isExtendedLike('regular'), false)

// ── 1b. excursions ─────────────────────────────────────────────────────────
const mkBar = (time: number, o: number, h: number, l: number, c: number, v = 1000): Bar => ({ time, open: o, high: h, low: l, close: c, volume: v })
const base = Date.parse('2026-07-15T14:00:00Z') / 1000 // 10:00 ET
const bars: Bar[] = [
  mkBar(base - 900, 100, 101, 99, 100, 500),
  mkBar(base, 100, 103, 98.5, 102, 1500), // entry bar (entry @ 100): low 98.5 high 103
  mkBar(base + 900, 102, 104, 101.5, 103, 1200), // favorable peak 104
  mkBar(base + 1800, 103, 103.5, 97, 97.5, 1300), // adverse trough 97
  mkBar(base + 2700, 97.5, 98, 96.5, 97, 900), // below exit bar — outside window
  mkBar(base + 3600, 97, 99, 96.8, 98.5, 800),
]
const excLong = computeExcursions(bars, base, base + 2400, 'long', 100, 2)
check('long MAE = entry - minLow(97) = 3', near(excLong?.mae ?? null, 3), true)
check('long MFE = maxHigh(104) - entry = 4', near(excLong?.mfe ?? null, 4), true)
check('long MAE% = 3%', near(excLong?.maePct ?? null, 3, 1e-4), true)
check('long MFE ATR = 4/2 = 2', near(excLong?.mfeAtr ?? null, 2), true)
check('window bars only (3 of 6)', excLong?.barsUsed, 3)
const excShort = computeExcursions(bars, base, base + 2400, 'short', 100, 2)
check('short MAE = maxHigh - entry = 4', near(excShort?.mae ?? null, 4), true)
check('short MFE = entry - minLow = 3', near(excShort?.mfe ?? null, 3), true)
check('no bars → null', computeExcursions([], base, base + 100, 'long', 100, 2), null)
check('bad entry price → null', computeExcursions(bars, base, base + 100, 'long', Number.NaN, 2), null)
check('no ATR → maeAtr/mfeAtr null', JSON.stringify([computeExcursions(bars, base, base + 2400, 'long', 100, null)?.maeAtr, computeExcursions(bars, base, base + 2400, 'long', 100, null)?.mfeAtr]), '[null,null]')

// ── 1c. ATR at entry (point-in-time) ───────────────────────────────────────
const daily: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const t = base - (40 - i) * 86400
  return mkBar(t, 100, 102, 99, 101, 10_000) // TR = 3 every day → ATR14 = 3
})
check('ATR at entry = 3 (constant TR)', near(atrAtEntry(daily, base) ?? null, 3, 1e-6), true)
check('ATR warm-up (<15 bars) null', atrAtEntry(daily.slice(-10), base), null)
check('ATR ignores future daily bars', near(atrAtEntry([...daily, mkBar(base + 86400, 100, 120, 80, 101, 10_000)] , base + 86400 + 3600) ?? null, 3, 1e-6), true)

// ── 1d. volume ratio ───────────────────────────────────────────────────────
// entry bar volume 1500 vs a 20-bar prior mean of 1000 (built with 20 prior
// bars so the ≥5-prior-bars requirement is genuinely exercised)
const volBars: Bar[] = [
  ...Array.from({ length: 20 }, (_, i) => mkBar(base - (21 - i) * 900, 100, 101, 99, 100, 1000)),
  mkBar(base, 100, 103, 98.5, 102, 1500),
  mkBar(base + 900, 102, 104, 101.5, 103, 1200),
]
check('volume ratio = entry 1500 / prior-20 avg 1000 = 1.5', near(volumeRatioAtEntry(volBars, base) ?? null, 1.5, 1e-6), true)
check('insufficient prior bars → null', volumeRatioAtEntry(bars, base), null)

// ── 1e. slippage ───────────────────────────────────────────────────────────
check('buy fill above limit = +25bps', near(slippageBps(100.25, '100', 'buy') ?? null, 25, 1e-6), true)
check('sell fill below limit = +25bps (worse)', near(slippageBps(99.75, '100', 'sell') ?? null, 25, 1e-6), true)
check('buy fill below limit = -25bps (better)', near(slippageBps(99.75, '100', 'buy') ?? null, -25, 1e-6), true)
check('market order (null limit) → null', slippageBps(100.25, null, 'buy'), null)
check('garbage limit → null', slippageBps(100.25, 'abc', 'buy'), null)

// ── 1f. timeframe + batching ───────────────────────────────────────────────
check('15m for intraday window', excursionTimeframe(3 * 3600_000), '15m')
check('1h for multi-day window', excursionTimeframe(4 * 86_400_000), '1h')
const seq = Array.from({ length: 14 }, (_, i) => i)
check('batches of 6: [6,6,2]', buildAuditBatches(seq, 6).map((b) => b.length).join(','), '6,6,2')
check('batch size clamped to 5 (spec band)', buildAuditBatches(seq, 2).map((b) => b.length).join(','), '5,5,4')
check('batch size clamped to 10', buildAuditBatches(seq, 99).map((b) => b.length).join(','), '10,4')

// ── 1g. parseAuditOutput — the hallucination/overfit guards ────────────────
const validIds = new Set(['e1:x1:1', 'e2:x2:1'])
const goodJson = JSON.stringify({
  trade_audits: [
    { trade_id: 'e1:x1:1', symbol: 'AAPL', quadrant: 'GOOD_PROCESS_WIN', execution_score: 8.4, mae_mfe_diagnosis: 'ok', session_impact: 'none', root_cause: 'clean entry' },
    { trade_id: 'HALLUCINATED_ID', symbol: 'FAKE', quadrant: 'BAD_PROCESS_LOSS', execution_score: 1, mae_mfe_diagnosis: 'x', session_impact: 'x', root_cause: 'x' },
    { trade_id: 'e2:x2:1', symbol: 'MSFT', quadrant: 'INVENTED_QUADRANT', execution_score: 5, mae_mfe_diagnosis: 'x', session_impact: 'x', root_cause: 'x' },
    { trade_id: 'e2:x2:1', symbol: 'MSFT', quadrant: 'BAD_PROCESS_WIN', execution_score: 99, mae_mfe_diagnosis: 'y', session_impact: 'y', root_cause: 'y' },
  ],
  batch_patterns: [{ pattern_description: 'chasing pre-market spikes', frequency_in_batch: 3, estimated_pnl_impact: '-$45' }, { pattern_description: '', frequency_in_batch: 2 }],
  candidate_rules_for_live_prompt: [
    { rule_id: 'r1', condition: 'spread > 0.4% ATR in pre-market', action: 'halve size', confidence: 'high', tags: ['session:extended', 'vol:made-up', 'session:extended'] },
    { rule_id: 'r2', condition: '', action: 'nothing', confidence: 'HIGH', tags: [] },
  ],
})
const parsed = parseAuditOutput(`\`\`\`json\n${goodJson}\n\`\`\``, validIds)
check('valid audit kept', parsed?.audits.length, 2)
check('hallucinated id dropped', parsed?.audits.some((a) => a.symbol === 'FAKE'), false)
check('invented quadrant dropped', parsed?.audits.some((a) => a.quadrant === 'INVENTED_QUADRANT'), false)
check('score clamped to 10', parsed?.audits[1]?.execution_score, 10)
check('confidence normalized upper', parsed?.rules[0]?.confidence, 'HIGH')
check('tags whitelisted + deduped', JSON.stringify(parsed?.rules[0]?.tags), JSON.stringify(['session:extended']))
check('empty-condition rule dropped', parsed?.rules.length, 1)
check('empty pattern dropped', parsed?.patterns.length, 1)
check('fenced JSON extracted', parsed !== null, true)
check('pure garbage → null', parseAuditOutput('the market is hard to predict, sorry', validIds), null)
check('empty object → null', parseAuditOutput('{}', validIds), null)

// ── 1h. rule lifecycle helpers ─────────────────────────────────────────────
check('dedupe key ignores punctuation/case', ruleDedupeKey('Spread > 0.4% ATR!', 'HALVE size.'), ruleDedupeKey('spread   > 0.4% ATR', 'halve size'))
const rankInput = [
  { confidence: 'LOW', frequency: 9, lastSeenAt: new Date('2026-01-03') },
  { confidence: 'HIGH', frequency: 1, lastSeenAt: new Date('2026-01-01') },
  { confidence: 'HIGH', frequency: 3, lastSeenAt: new Date('2026-01-02') },
  { confidence: 'MEDIUM', frequency: 5, lastSeenAt: new Date('2026-01-04') },
]
check('rank: confidence first, then frequency', JSON.stringify(rankCandidates(rankInput).map((r) => r.frequency)), '[3,1,5,9]')
const rulesAll = [
  { condition: 'a', action: 'x', confidence: 'HIGH', tags: ['session:extended'] },
  { condition: 'b', action: 'y', confidence: 'HIGH', tags: ['session:any'] },
  { condition: 'c', action: 'z', confidence: 'HIGH', tags: ['session:regular'] },
  { condition: 'd', action: 'w', confidence: 'HIGH', tags: [] },
]
check('match: extended session keeps extended/any/empty', matchActiveRules(rulesAll, 'post').length, 3)
check('match: regular session keeps regular/any/empty', matchActiveRules(rulesAll, 'regular').map((r) => r.condition).join(''), 'bcd')
check('match cap 7', matchActiveRules(Array.from({ length: 12 }, (_, i) => ({ condition: `c${i}`, action: 'x', confidence: 'HIGH', tags: ['session:any'] })), 'regular').length, 7)

// whitelist sanity (the prompts reference these exact vocabularies)
check('4 quadrants defined', QUADRANTS.length, 4)
check('9 tags whitelisted', TAG_WHITELIST.length, 9)

// ── 2. HTTP probe ───────────────────────────────────────────────────────────
const BASE = 'http://localhost:3000'
const USER = `qa49_${Date.now().toString(36)}`
const PASS = 'qa49-pass-1234'
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
const verify = await fetch(`${BASE}/api/auth/login/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ticket, code: totpCode(secret) }),
})
const cookie = (verify.headers.get('set-cookie') || '').split(';')[0]
check('verify cookie', !!cookie, true)

const unAuthAudit = await fetch(`${BASE}/api/trade-review/audit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
check('audit POST unauth → 401', unAuthAudit.status, 401)
const unAuthRules = await fetch(`${BASE}/api/trade-review/rules`)
check('rules GET unauth → 401', unAuthRules.status, 401)

const histGet = await fetch(`${BASE}/api/trade-review/audit?mode=paper`, { headers: { cookie } })
const histGetJ = (await j(histGet)) as { batches?: unknown[]; running?: boolean }
check('audit GET no-keys → 200', histGet.status, 200)
check('audit GET batches []', Array.isArray(histGetJ.batches) && histGetJ.batches.length === 0, true)
check('audit GET running false', histGetJ.running, false)

const rulesGet = await fetch(`${BASE}/api/trade-review/rules`, { headers: { cookie } })
const rulesGetJ = (await j(rulesGet)) as { rules?: unknown[] }
check('rules GET → 200 empty', rulesGet.status === 200 && Array.isArray(rulesGetJ.rules) && rulesGetJ.rules.length === 0, true)

const rulesBad = await fetch(`${BASE}/api/trade-review/rules`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ action: 'explode' }), })
check('rules POST unknown action → 400', rulesBad.status, 400)

const auditNoKeys = await fetch(`${BASE}/api/trade-review/audit`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ mode: 'paper', limit: 12 }) })
const auditNoKeysJ = (await j(auditNoKeys)) as { configured?: boolean; error?: string }
check('audit POST no-keys → 200 honest', auditNoKeys.status, 200)
check('audit POST no-keys configured:false', auditNoKeysJ.configured, false)
check('audit POST no-keys has error text', typeof auditNoKeysJ.error === 'string' && auditNoKeysJ.error.length > 0, true)

// cleanup
const u = await db.user.findUnique({ where: { username: USER } })
if (u) await db.user.delete({ where: { id: u.id } })
console.log(`cleanup: user ${USER} deleted`)
console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
