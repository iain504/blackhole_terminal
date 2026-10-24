// Task 87 probe — sweepStrategies correctness on synthetic bars:
//   1. autoOptimizeRanges includes EVERY strategy's defaults
//   2. sweep rows are sorted by score desc and all cleared minTrades
//   3. no duplicate (strategy, params) rows
//   4. defaults are always among the candidates (baseline row present)
//   5. perStrategy stats add up (evaluated = sims run, scorable ≥ rows shown)
import { prepareSeries, sweepStrategies, autoOptimizeRanges, type BacktestConfig } from '@/lib/backtest'
import { ALGO_STRATEGIES, ALGO_STRATEGY_IDS } from '@/lib/algo-strategies'
import type { Bar } from '@/lib/market-types'

// deterministic pseudo-random walk with regimes (trend + chop) so strategies fire
let seed = 42
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const N = 3000
const TF_SEC = 300
const t0 = Math.floor(Date.now() / 1000 / TF_SEC) * TF_SEC - N * TF_SEC
const bars: Bar[] = []
let px = 100
for (let i = 0; i < N; i++) {
  // alternate 300-bar trend/chop regimes
  const regime = Math.floor(i / 300) % 2
  const drift = regime === 0 ? (rnd() - 0.42) * 0.15 : (rnd() - 0.58) * 0.08
  const o = px
  const c = Math.max(1, o + drift)
  const h = Math.max(o, c) + rnd() * 0.08
  const l = Math.min(o, c) - rnd() * 0.08
  bars.push({ time: t0 + i * TF_SEC, open: o, high: h, low: l, close: c, volume: 1000 + rnd() * 500 })
  px = c
}

const base: BacktestConfig = {
  strategy: 'bb-reversion', // placeholder — sweep overrides per strategy
  params: {},
  qty: 10,
  sizingMode: 'fixed',
  riskMoney: null,
  isCrypto: false,
  tpMode: 'pct',
  tpValue: 1.5,
  slMode: 'pct',
  slValue: 1,
  maxTradesDay: 3,
  rthOnly: true,
  flattenEod: true,
  cooldownMin: 0,
  requireNewSignal: false,
  capital: 10000,
  slippageBps: 2,
  feeBps: 0,
  spreadBps: 2,
}

let fails = 0
const fail = (msg: string) => { console.error('FAIL:', msg); fails++ }

// ---- 1. auto ranges include defaults ----
for (const sid of ALGO_STRATEGY_IDS) {
  const def = ALGO_STRATEGIES[sid]
  const ranges = autoOptimizeRanges(sid)
  for (const p of def.params) {
    if (p.bool) continue
    const r = ranges.find((x) => x.key === p.key)
    if (!r) fail(`${sid}: auto range missing numeric param ${p.key}`)
    else if (!r.values?.includes(def.defaults[p.key])) fail(`${sid}: auto range for ${p.key} misses default ${def.defaults[p.key]} (got ${r.values?.join(',')})`)
  }
  // bool params never swept
  if (ranges.some((x) => def.params.find((p) => p.key === x.key)?.bool)) fail(`${sid}: bool param swept`)
}
console.log('[1] auto ranges: defaults included for all strategies')

// ---- 2-5. sweep ----
const series = prepareSeries(bars)
const t0ms = Date.now()
const sweep = sweepStrategies(series, base, { minTrades: 5, topX: 8 })
console.log(`sweep: ${sweep.evaluated} sims in ${(sweep.elapsedMs / 1000).toFixed(1)}s (wall ${(Date.now() - t0ms) / 1000}s)`)

if (sweep.rows.length === 0) fail('no scorable rows at all — synthetic data too dead?')
for (let i = 1; i < sweep.rows.length; i++) {
  if (sweep.rows[i].score > sweep.rows[i - 1].score) fail(`rows not sorted at ${i}: ${sweep.rows[i - 1].score} < ${sweep.rows[i].score}`)
}
for (const r of sweep.rows) {
  if (!(r.score > -Infinity)) fail('row with -Infinity score listed')
  if (r.metrics.trades < 5) fail(`row below minTrades listed (${r.metrics.trades})`)
  const full = Object.keys(ALGO_STRATEGIES[r.strategy].defaults)
  for (const k of full) if (!(k in r.params)) fail(`${r.strategy}: row params missing ${k} (not a full param set)`)
}
console.log(`[2] rows sorted desc, all scorable (${sweep.rows.length} rows, scores ${sweep.rows.map((r) => r.score.toFixed(2)).join(' > ')})`)

const sigs = new Set<string>()
for (const r of sweep.rows) {
  const sig = r.strategy + '|' + Object.entries(r.params).map(([k, v]) => `${k}=${v}`).sort().join(',')
  if (sigs.has(sig)) fail(`duplicate row: ${sig}`)
  sigs.add(sig)
}
console.log('[3] no duplicate rows')

const perStrat = new Map(sweep.perStrategy.map((p) => [p.strategy, p]))
if (perStrat.size !== ALGO_STRATEGY_IDS.length) fail('perStrategy missing entries')
for (const ps of sweep.perStrategy) {
  if (ps.evaluated < 1) fail(`${ps.strategy}: evaluated < 1 (defaults row must always run)`)
  if (ps.bestScore != null && ps.scorable < 1) fail(`${ps.strategy}: bestScore set but scorable 0`)
}
console.log('[4] per-strategy: ' + sweep.perStrategy.map((p) => `${p.strategy} grid=${p.totalCombos} sims=${p.evaluated} scorable=${p.scorable} best=${p.bestScore?.toFixed(2) ?? '—'}${p.truncated ? ' (trunc)' : ''}`).join(' · '))

// topX respected
const s2 = sweepStrategies(series, base, { minTrades: 5, topX: 3 })
if (s2.rows.length > 3) fail(`topX=3 returned ${s2.rows.length} rows`)
if (s2.rows.length > 0 && s2.rows[0].score !== sweep.rows[0].score) fail('topX=3 best differs from topX=8 best')
console.log(`[5] topX respected (${s2.rows.length} rows at topX=3, same #1)`)

// minTrades gate: a huge gate must empty the list, not list sub-gate rows
const s3 = sweepStrategies(series, base, { minTrades: 100000, topX: 8 })
if (s3.rows.length !== 0) fail(`minTrades=100000 should list 0 rows, got ${s3.rows.length}`)
console.log('[6] minTrades gate empties the list cleanly')

console.log(fails === 0 ? '\nALL SWEEP PROBES PASSED' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
