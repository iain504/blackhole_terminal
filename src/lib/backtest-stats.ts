// Statistical trust layer for the Algo backtest (v1.99.0) — the answer to
// "I cannot trust the backtest result: few trades, few edge".
//
// The engine already had walk-forward folds, a pure hold-out and a Monte
// Carlo sequence-risk bootstrap — but NOTHING looked at the per-trade P&L
// distribution and told the user, in plain language, whether the measured
// edge is distinguishable from luck. This lib does exactly that:
//
//   significanceStats(trades, costBps) → n, mean net bps/trade, σ, t-stat,
//     two-sided p (Student-t via the incomplete beta — no deps), a DAY-BLOCK
//     bootstrap 95% CI of the mean (resampling whole trading days, because
//     intraday trades cluster: an iid bootstrap would understate variance),
//     and how many trades the observed edge/σ ratio would need for t ≈ 2.
//
//   trustVerdict(sig, basis, evaluated?) → { level, title, detail } — the
//     plain-language verdict rendered in the Backtest panel:
//       significant   p < 0.05 AND the day-block CI clears zero
//       suggestive    0.05 ≤ p < 0.10 (or in-sample significance capped —
//                     the best-of-N winner's curse inflates optimizer rows)
//       weak          positive mean but statistically indistinguishable
//                     from zero — "could be luck"
//       not-proven    mean ≤ 0 after the configured costs
//       insufficient  too few trades (n < 5) to test at all
//     basis: 'plain' (user-run config, full window) · 'in-sample' (optimizer
//     best row — selection-biased, capped at suggestive) · 'oos' (walk-forward
//     pooled OOS / pure hold-out — the honest numbers).
//
// Pure functions, zero imports — safe on the server AND the client.

export interface TradeLike {
  pnlPct: number // % return on position notional (BacktestTrade.pnlPct)
  entryTime: number // unix seconds — day-block grouping key
}

export interface SignificanceStats {
  n: number
  meanBps: number // net expectancy per trade, bps of notional (AFTER configured costs)
  sdBps: number
  t: number
  p: number // two-sided
  ciLo: number // day-block bootstrap 95% CI of the mean bps
  ciHi: number
  tradesNeeded: number // n for t ≈ 2 at the observed edge/σ ratio (NaN when mean ≤ 0)
  costBps: number // round-trip friction of the config that produced the trades
}

export type TrustLevel = 'significant' | 'suggestive' | 'weak' | 'not-proven' | 'insufficient'
export type TrustBasis = 'plain' | 'in-sample' | 'oos'

export interface TrustVerdict {
  level: TrustLevel
  title: string
  detail: string
}

// ---- Student-t two-sided p via the regularized incomplete beta (NR-style) ----
function gammln(xx: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let x = xx
  let y = xx
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200
  const EPS = 3e-12
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

function ibeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
}

/** Two-sided p for Student-t with df degrees of freedom. */
export function tTestP(t: number, df: number): number {
  if (!Number.isFinite(t) || df < 1) return NaN
  return ibeta(df / 2, 0.5, df / (df + t * t))
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
}
function sd(a: number[]): number {
  if (a.length < 2) return NaN
  const m = mean(a)
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1))
}

/**
 * Day-block bootstrap CI of the mean (seeded LCG — deterministic across runs,
 * so the wire cache and repeated renders agree). Resampling WHOLE TRADING
 * DAYS preserves intraday clustering and (for pooled OOS) cross-symbol
 * macro-day correlation that an iid resample would ignore.
 */
function bootCI(byDay: number[][], iters: number): [number, number] {
  const D = byDay.length
  if (D < 2) return [NaN, NaN]
  let s = 0x9e3779b9 >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const means: number[] = []
  for (let it = 0; it < iters; it++) {
    let sum = 0
    let cnt = 0
    for (let d = 0; d < D; d++) {
      const pick = byDay[Math.floor(rnd() * D)]
      for (const x of pick) {
        sum += x
        cnt++
      }
    }
    if (cnt > 0) means.push(sum / cnt)
  }
  if (!means.length) return [NaN, NaN]
  means.sort((a, b) => a - b)
  return [means[Math.floor(0.025 * means.length)], means[Math.ceil(0.975 * means.length) - 1]]
}

/** Round-trip friction in bps for a config-shaped cost set (2 fills). */
export function roundTripCostBps(costs: { slippageBps?: number; feeBps?: number; spreadBps?: number }): number {
  // spread is charged HALF per fill (market crosses half the book each side)
  return 2 * (costs.slippageBps ?? 0) + 2 * (costs.feeBps ?? 0) + (costs.spreadBps ?? 0)
}

/**
 * Per-trade significance of a net-of-costs trade list. `null` only when the
 * list is empty — callers should render 'insufficient' themselves then.
 */
export function significanceStats(trades: TradeLike[], costBps: number, bootIters = 2000): SignificanceStats | null {
  if (!trades.length) return null
  const bps = trades.map((t) => t.pnlPct * 100) // pnlPct is a % of notional → bps
  const n = bps.length
  const m = mean(bps)
  const s = sd(bps)
  const t = Number.isFinite(s) && s > 0 ? m / (s / Math.sqrt(n)) : NaN
  const byDay = new Map<number, number[]>()
  for (const tr of trades) {
    const d = Math.floor(tr.entryTime / 86400) // UTC day bucket — trades are RTH/session-scoped
    const arr = byDay.get(d) ?? []
    arr.push(tr.pnlPct * 100)
    byDay.set(d, arr)
  }
  const [ciLo, ciHi] = bootCI([...byDay.values()], bootIters)
  return {
    n,
    meanBps: m,
    sdBps: s,
    t,
    p: tTestP(t, n - 1),
    ciLo,
    ciHi,
    tradesNeeded: Number.isFinite(m) && m > 0 && Number.isFinite(s) && s > 0 ? Math.ceil(((1.96 * s) / m) ** 2) : NaN,
    costBps,
  }
}

const bps = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : '—')
const pFmt = (p: number) => (!Number.isFinite(p) ? '—' : p < 0.0001 ? '<0.0001' : p.toFixed(4))

/**
 * Plain-language verdict. `evaluated` (in-sample optimizer rows) feeds the
 * winner's-curse caveat — the best of N noisy combos is inflated by √(2·ln N).
 */
export function trustVerdict(sig: SignificanceStats | null, basis: TrustBasis, evaluated = 0): TrustVerdict {
  const oos = basis === 'oos'
  const prefix =
    basis === 'in-sample'
      ? 'In-sample best row — '
      : oos
        ? 'Out-of-sample (never tuned on) — '
        : ''
  // NaN arrives as null over the wire (jsonSafe) — treat any non-finite
  // core stat as untestable rather than silently falling through
  if (!sig || sig.n < 5 || !Number.isFinite(sig.t) || !Number.isFinite(sig.meanBps)) {
    return {
      level: 'insufficient',
      title: `${prefix}TOO FEW TRADES TO TEST`,
      detail:
        `${sig?.n ?? 0} trade${(sig?.n ?? 0) === 1 ? '' : 's'} cannot distinguish an edge from luck — statistics need roughly 20–50. Widen the window, lower the min-trades gate, or loosen the entry filters, then re-test.`,
    }
  }
  const m = sig.meanBps
  const winCurse =
    basis === 'in-sample' && evaluated > 1
      ? ` Picking the best of ${evaluated.toLocaleString('en-US')} evaluated combos inflates this number (winner's curse) — demand walk-forward out-of-sample confirmation before trusting it.`
      : ''
  const ciTxt = Number.isFinite(sig.ciLo) ? `95% CI [${bps(sig.ciLo)}, ${bps(sig.ciHi)}] bps` : 'CI needs ≥2 trading days'
  const nums = `mean ${bps(sig.meanBps)} bps/trade after ${sig.costBps > 0 ? `~${sig.costBps} bps round-trip costs` : 'ZERO friction'} · t=${sig.t.toFixed(2)} · p=${pFmt(sig.p)} · ${ciTxt}`
  const costNote =
    sig.costBps === 0
      ? ' This run was FRICTIONLESS — real fills pay ~2×(slippage+fee)+spread per round trip, so re-run with suggested costs before believing the number.'
      : ''

  if (m <= 0) {
    return {
      level: 'not-proven',
      title: `${prefix}NO EDGE AFTER COSTS`,
      detail: `${nums}. On this window this configuration lost money net of its own cost model — there is nothing here to trust yet.${costNote}`,
    }
  }
  if (sig.p < 0.05 && sig.ciLo > 0) {
    const lvl: TrustLevel = basis === 'in-sample' ? 'suggestive' : 'significant'
    return {
      level: lvl,
      title: `${prefix}${lvl === 'significant' ? 'STATISTICALLY SIGNIFICANT EDGE' : 'SIGNIFICANT IN-SAMPLE — BUT SELECTION-INFLATED'}`,
      detail: `${nums}. Only ~1-in-20 chance this edge is pure luck on this window.${winCurse}${costNote} Re-verify forward as new bars arrive — a past edge is not a future one.`,
    }
  }
  if (sig.p < 0.1) {
    return {
      level: 'suggestive',
      title: `${prefix}PROMISING — NOT YET PROVEN`,
      detail: `${nums}. Close, but short of p<0.05.${Number.isFinite(sig.tradesNeeded) ? ` ≈${sig.tradesNeeded} trades total would settle it — collect them forward (paper) instead of re-tuning the same window.` : ''}${winCurse}${costNote}`,
    }
  }
  return {
    level: 'weak',
    title: `${prefix}WITHIN NOISE — COULD BE LUCK`,
    detail: `${nums}. The CI includes zero: this window cannot distinguish the edge from no edge.${Number.isFinite(sig.tradesNeeded) ? ` Need ≈${sig.tradesNeeded} trades (has ${sig.n}) — pool more symbols/time or collect forward.` : ''}${winCurse}${costNote}`,
  }
}

export const TRUST_LEVEL_STYLE: Record<TrustLevel, { dot: string; text: string; border: string; label: string }> = {
  significant: { dot: 'bg-emerald-400', text: 'text-emerald-400', border: 'border-emerald-500/40', label: 'significant' },
  suggestive: { dot: 'bg-amber-400', text: 'text-amber-400', border: 'border-amber-500/40', label: 'suggestive' },
  weak: { dot: 'bg-zinc-400', text: 'text-zinc-300', border: 'border-zinc-500/40', label: 'within noise' },
  'not-proven': { dot: 'bg-rose-400', text: 'text-rose-400', border: 'border-rose-500/40', label: 'not proven' },
  insufficient: { dot: 'bg-zinc-500', text: 'text-zinc-400', border: 'border-zinc-600/40', label: 'untestable' },
}
