// Task 12 — algo strategy quality toolkit (upload/algo_improvement.txt):
//   • Wilder ADX + half-life (OU) + regime gates  (algo-regime.ts)
//   • regime veto parity inside the backtest engine (backtest.ts decide())
//   • vol-scaled slippage (ATR% × impact)
//   • walk-forward optimization harness (rolling folds + pure hold-out)
//   • optimizer neighbor sensitivity / plateau
//   • Monte Carlo bootstrap of the trade sequence
// All synthetic bars are deterministic — no RNG in the fixtures.
//
// Fixture notes (the gates FAIL OPEN when they cannot judge — NaN inputs —
// so veto tests must place the anomaly AFTER the gate's warmup window):
//   • FLAT_HEAD_RAMP — 260 flat bars then a 1%/bar exponential ramp. The flat
//     head never breaches a Bollinger band, so the first bb signal arrives
//     well after bar 200, where the 200-SMA trend gate is VALID and vetoes
//     the ramp shorts. With the gate off, the same series shorts once and
//     rides the trend to the end (no mean-reversion exit on a ramp).
//   • SPIKES — repeating 10-bar cycles: 6 flat bars, a +60 jump bar, a 2-bar
//     decay (1040, 1020). Jump bars breach the upper band with a huge margin
//     and carry RSI(2)≈100 → shorts fire; a 3% TP bracket books the round
//     trip on the decay (deterministic exits — no reliance on the band-mean
//     exit landing inside 0.25σ).
import { describe, test, expect } from 'bun:test'
import {
  adxSeries,
  halfLifeFromDev,
  halfLifeSeries,
  regimeVeto,
  monteCarloBootstrap,
  atrPctSeries,
} from '../src/lib/algo-regime'
import { prepareSeries, runBacktest, optimizeBacktest, walkForward, type BacktestConfig } from '../src/lib/backtest'
import { normalizeAlgoParams } from '../src/lib/algo-strategies'
import type { Bar } from '../src/lib/market-types'

/** Deterministic 1-minute equity bars from a close path. The high/low use a
 *  DIRECTION-AWARE envelope: each bar extends its own direction's extreme by
 *  a clear margin plus a small shared wobble. This matters for Wilder's DM:
 *  a symmetric max/min envelope makes counter-moves exactly touch the prior
 *  extreme (zero DM — the seed asymmetry then freezes forever and fakes
 *  ADX=100 on chop), while independent wobbles inject systematic +DM/−DM
 *  bias. Direction-aware envelopes keep +DM and −DM flowing on their own
 *  bars only — chop balances, trends dominate. */
function barsFrom(closes: number[], startT = 946684800): Bar[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]
    const w = ((i * 7) % 5) * 0.15
    const up = c >= o
    return {
      time: startT + i * 60,
      open: o,
      high: Math.max(o, c) + 0.8 + (up ? 0.6 + w : 0.3 * w),
      low: Math.min(o, c) - 0.8 - (!up ? 0.6 + w : 0.3 * w),
      close: c,
      volume: 1000,
    }
  })
}

/** Exponential ramp: `head` flat bars then +1% per bar — a strong trend. */
function flatHeadRamp(total = 420, head = 260, r = 1.01): number[] {
  const out: number[] = []
  let p = 1000
  for (let i = 0; i < total; i++) {
    out.push(p)
    if (i >= head) p *= r
  }
  return out
}

/** Repeating spike cycles — bb-shorts fire on the jump bar and the 3% TP
 *  books the round trip during the decay. */
function spikes(cycles = 60): number[] {
  const out: number[] = []
  for (let c = 0; c < cycles; c++) {
    for (let k = 0; k < 6; k++) out.push(1000)
    out.push(1060)
    out.push(1040)
    out.push(1020)
  }
  return out
}

/** AR(1) deviation series: e_t = φ·e_{t−1} (deterministic, noiseless). */
function ar1(phi: number, n = 400, e0 = 100): number[] {
  const out = [e0]
  for (let i = 1; i < n; i++) out.push(out[i - 1] * phi)
  return out
}

const bbParams = (over: Record<string, number> = {}): Record<string, number> => ({
  bbPeriod: 20, bbStd: 1, rsiPeriod: 2, rsiOversold: 30, rsiOverbought: 70, allowShort: 1,
  regimeTrend: 0, regimeAdx: 0, adxMax: 25, hlGate: 0, hlMax: 48,
  ...over,
})

const baseCfg = (params: Record<string, number>): BacktestConfig => ({
  strategy: 'bb-reversion',
  params,
  qty: 1,
  sizingMode: 'fixed',
  riskBasis: 'usd',
  riskMoney: null,
  isCrypto: false, // equity → shorts allowed, no long-only skipping
  tpMode: 'pct',
  tpValue: 3, // 3% TP bracket — deterministic spike round trips
  slMode: 'none',
  slValue: null,
  maxTradesDay: 200,
  rthOnly: false,
  flattenEod: false,
  cooldownMin: 0,
  requireNewSignal: false,
  capital: 10000,
})

// ---------------------------------------------------------------------------
// ADX
// ---------------------------------------------------------------------------
describe('adxSeries — Wilder trend strength', () => {
  test('a one-directional ramp drives ADX high', () => {
    const adx = adxSeries(barsFrom(flatHeadRamp(120, 0)), 14)
    const last = adx[adx.length - 1]
    expect(Number.isFinite(last)).toBe(true)
    expect(last).toBeGreaterThan(40)
  })

  test('perfect alternation (up/down chop) keeps ADX low', () => {
    const closes: number[] = []
    let p = 1000
    for (let i = 0; i < 120; i++) {
      closes.push(p)
      p += i % 2 === 0 ? 5 : -5
    }
    const adx = adxSeries(barsFrom(closes), 14)
    const last = adx[adx.length - 1]
    expect(Number.isFinite(last)).toBe(true)
    expect(last).toBeLessThan(25)
  })

  test('values stay in [0, 100] and NaN before the seed index', () => {
    const adx = adxSeries(barsFrom(flatHeadRamp(80, 0)), 14)
    expect(Number.isNaN(adx[10])).toBe(true) // seed at 2×14−1 = 27
    for (let i = 27; i < adx.length; i++) {
      expect(adx[i] >= 0 && adx[i] <= 100).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Half-life (OU)
// ---------------------------------------------------------------------------
describe('halfLifeFromDev — OU regression', () => {
  test('AR(1) φ=0.5 → half-life ≈ ln2/0.5 ≈ 1.39 bars', () => {
    const hl = halfLifeFromDev(ar1(0.5))
    const last = hl[hl.length - 1]
    expect(Number.isFinite(last)).toBe(true)
    expect(Math.abs(last - Math.LN2 / 0.5)).toBeLessThan(0.05)
  })

  test('AR(1) φ=0.9 → half-life ≈ 6.58 bars (slower reversion)', () => {
    const hl = halfLifeFromDev(ar1(0.9))
    const last = hl[hl.length - 1]
    expect(Math.abs(last - Math.LN2 / 0.1)).toBeLessThan(0.3)
  })

  test('an expanding deviation (trend) reports Infinity — no reversion', () => {
    const hl = halfLifeFromDev(ar1(1.15)) // φ > 1 → λ > 0
    expect(hl[hl.length - 1]).toBe(Number.POSITIVE_INFINITY)
  })

  test('too few points → NaN (fail-open)', () => {
    const hl = halfLifeFromDev(ar1(0.5, 40))
    expect(Number.isNaN(hl[hl.length - 1])).toBe(true)
  })

  test('halfLifeSeries: a decaying deviation reverts, a ramp does not', () => {
    // closes = flat level + decaying AR(1) deviation → the deviation from the
    // rolling SMA(50) decays back toward zero → finite positive half-life.
    // (Past ~bar 330 the deviation sinks below float64 resolution at price
    // 1000 — closes become EXACTLY flat, dev ≡ 0, and NaN (fail-open) is the
    // correct reading — so the assertion targets a live index.)
    const closes = ar1(0.9, 600).map((e) => 1000 + e)
    const hlRev = halfLifeSeries(closes)
    expect(Number.isFinite(hlRev[300])).toBe(true)
    expect(hlRev[300]).toBeGreaterThan(0)
    const hlRamp = halfLifeSeries(flatHeadRamp(600, 0))
    expect(hlRamp[hlRamp.length - 1]).toBe(Number.POSITIVE_INFINITY)
  })
})

// ---------------------------------------------------------------------------
// Regime veto
// ---------------------------------------------------------------------------
describe('regimeVeto — P0 trend / P0 ADX / P1 half-life gates', () => {
  const cfg = { regimeTrend: true, trendSoftPct: 0, regimeAdx: false, adxMax: 25, hlGate: false, hlMax: 48 }
  const sma = 200

  test('longs above the 200-SMA pass, below are vetoed', () => {
    expect(regimeVeto(cfg, 'buy', 210, sma, Number.NaN, Number.NaN)).toBeNull()
    expect(regimeVeto(cfg, 'buy', 190, sma, Number.NaN, Number.NaN)).toContain('below')
  })

  test('shorts mirror: below passes, above is vetoed', () => {
    expect(regimeVeto(cfg, 'sell', 190, sma, Number.NaN, Number.NaN)).toBeNull()
    expect(regimeVeto(cfg, 'sell', 210, sma, Number.NaN, Number.NaN)).toContain('above')
  })

  test('null SMA (insufficient history) fails OPEN', () => {
    expect(regimeVeto(cfg, 'sell', 9999, null, Number.NaN, Number.NaN)).toBeNull()
  })

  test('ADX ≥ max vetoes; NaN fails open', () => {
    const c = { ...cfg, regimeAdx: true }
    expect(regimeVeto(c, 'buy', 210, sma, 30, Number.NaN)).toContain('ADX')
    expect(regimeVeto(c, 'buy', 210, sma, 20, Number.NaN)).toBeNull()
    expect(regimeVeto(c, 'buy', 210, sma, Number.NaN, Number.NaN)).toBeNull()
  })

  test('half-life gate: Infinity and slow reversion veto, fast passes', () => {
    const c = { ...cfg, hlGate: true }
    expect(regimeVeto(c, 'buy', 210, sma, Number.NaN, Number.POSITIVE_INFINITY)).toContain('half-life')
    expect(regimeVeto(c, 'buy', 210, sma, Number.NaN, 100)).toContain('half-life')
    expect(regimeVeto(c, 'buy', 210, sma, Number.NaN, 10)).toBeNull()
    expect(regimeVeto(c, 'buy', 210, sma, Number.NaN, Number.NaN)).toBeNull() // fail-open
  })
})

// ---------------------------------------------------------------------------
// Backtest parity — the regime veto inside decide()
// ---------------------------------------------------------------------------
describe('runBacktest — regime gates veto entries (parity with evalStrategy)', () => {
  // 260 flat bars then a 1%/bar ramp: the flat head produces NO bb signal at
  // all, so the first signal arrives while the trend gate is already valid.
  const series = prepareSeries(barsFrom(flatHeadRamp()))

  test('ungated bb-reversion shorts the ramp (one signal, no reversion exit)', () => {
    const res = runBacktest(series, baseCfg(bbParams()))
    expect(res.metrics.shorts).toBe(1)
    expect(res.metrics.longs).toBe(0)
  })

  test('trend gate ON vetoes the short above the 200-SMA (P0, end-to-end)', () => {
    const res = runBacktest(series, baseCfg(bbParams({ regimeTrend: 1 })))
    expect(res.metrics.trades).toBe(0)
  })

  test('ADX chop gate ON vetoes the ramp too — ADX(14) is high there (P0, end-to-end)', () => {
    const res = runBacktest(series, baseCfg(bbParams({ regimeAdx: 1, adxMax: 25 })))
    expect(res.metrics.trades).toBe(0)
  })

  test('half-life gate ON leaves the degenerate first-breach bar fail-open (parity)', () => {
    // the ramp deviation emerges from EXACTLY zero, so the first breach bar's
    // OLS window is degenerate (all-zero x) → NaN → fail-open BY DESIGN (a
    // thin/degenerate history must never freeze a strategy). The entry never
    // exits on a ramp, so the run books exactly that one trade — identical to
    // what the live engine does on the same data.
    const res = runBacktest(series, baseCfg(bbParams({ hlGate: 1 })))
    expect(res.metrics.trades).toBe(1)
  })

  test('half-life gate ON does NOT over-veto genuine mean reversion (spikes)', () => {
    const spikesSeries = prepareSeries(barsFrom(spikes()))
    const off = runBacktest(spikesSeries, baseCfg(bbParams({ hlGate: 0 })))
    const on = runBacktest(spikesSeries, baseCfg(bbParams({ hlGate: 1 })))
    expect(off.metrics.trades).toBeGreaterThan(20)
    expect(on.metrics.trades).toBe(off.metrics.trades) // every entry survives the gate
  })

  test('a series shorter than 200 bars leaves the trend gate fail-open', () => {
    const short = prepareSeries(barsFrom(flatHeadRamp(150, 30)))
    const res = runBacktest(short, baseCfg(bbParams({ regimeTrend: 1 })))
    expect(res.metrics.shorts).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Vol-scaled slippage
// ---------------------------------------------------------------------------
describe('runBacktest — dynSlip (ATR-scaled impact)', () => {
  const spikeSeries = prepareSeries(barsFrom(spikes()))
  const p = bbParams()

  test('no slippage → dynSlip is a no-op', () => {
    const a = runBacktest(spikeSeries, { ...baseCfg(p), slippageBps: 0, dynSlip: true })
    const b = runBacktest(spikeSeries, { ...baseCfg(p), slippageBps: 0, dynSlip: false })
    expect(a.metrics.netPnl).toBe(b.metrics.netPnl)
  })

  test('with slippage > 0 the ATR-scaled model diverges from the constant one', () => {
    const a = runBacktest(spikeSeries, { ...baseCfg(p), slippageBps: 50, dynSlip: true })
    const b = runBacktest(spikeSeries, { ...baseCfg(p), slippageBps: 50, dynSlip: false })
    expect(Number.isFinite(a.metrics.netPnl)).toBe(true)
    expect(a.metrics.netPnl).not.toBe(b.metrics.netPnl)
  })

  test('spike shorts win — the fixture itself is a profitable MR round trip', () => {
    const r = runBacktest(spikeSeries, { ...baseCfg(p), slippageBps: 5, feeBps: 10 })
    expect(r.metrics.trades).toBeGreaterThan(20)
    expect(r.metrics.netPnl).toBeGreaterThan(0)
  })
})

describe('atrPctSeries', () => {
  test('baseline is the mean of the finite ATR% values', () => {
    const { atrPct, base } = atrPctSeries(barsFrom(spikes(20)))
    expect(base).toBeGreaterThan(0)
    let sum = 0
    let n = 0
    for (const v of atrPct) if (Number.isFinite(v)) { sum += v; n++ }
    expect(n).toBeGreaterThan(0)
    expect(Math.abs(sum / n - base)).toBeLessThan(1e-9)
  })
})

// ---------------------------------------------------------------------------
// Optimizer sensitivity / plateau
// ---------------------------------------------------------------------------
describe('optimizeBacktest — neighbor sensitivity (plateau probe)', () => {
  test('reports ±1-step neighbor scores and a plateau verdict', async () => {
    const series = prepareSeries(barsFrom(spikes()))
    const opt = await optimizeBacktest(
      series,
      baseCfg(bbParams()),
      [{ key: 'bbStd', min: 1, max: 4, step: 0.5 }],
      { minTrades: 1 },
    )
    expect(opt.best).not.toBeNull()
    expect(opt.best!.score).toBeGreaterThan(0) // spike shorts win
    expect(opt.sensitivity).toBeDefined()
    expect(opt.sensitivity!.length).toBe(1)
    expect(opt.sensitivity![0].key).toBe('bbStd')
    expect(opt.plateau).not.toBeNull()
    expect(opt.plateau!.ratio).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Walk-forward optimization
// ---------------------------------------------------------------------------
describe('walkForward — rolling folds + pure hold-out', () => {
  const series = prepareSeries(barsFrom(spikes(218))) // 2398 bars
  const ranges = [{ key: 'bbStd', min: 1, max: 4, step: 0.5 }]

  test('runs the requested folds and carves the hold-out off FIRST', async () => {
    const wf = await walkForward(series, baseCfg(bbParams()), { ranges, folds: 2, isFraction: 0.7, holdoutFraction: 0.2, minTrades: 1 })
    expect(wf.mode).toBe('rolling')
    // 2398 bars → hold-out 479, wf span 1919 → 2 spans (IS 70% / OOS 30%)
    expect(wf.folds.length).toBe(2)
    expect(wf.holdout).not.toBeNull()
    expect(wf.holdout!.to).toBe(series.bars[series.n - 1].time) // hold-out ends at the dataset tail
    expect(wf.folds[0].oosTo).toBeLessThanOrEqual(wf.holdout!.from) // folds never touch the hold-out
    expect(wf.evaluated).toBeGreaterThan(0)
    expect(wf.aggregate.foldsTotal).toBe(2)
  })

  test('anchored mode expands the IS window back to bar 0', async () => {
    const wf = await walkForward(series, baseCfg(bbParams()), { ranges, folds: 2, isFraction: 0.7, holdoutFraction: 0, anchored: true, minTrades: 1 })
    expect(wf.mode).toBe('anchored')
    expect(wf.folds.length).toBe(2)
    // anchored folds tune on everything from the very first bar
    expect(wf.folds[0].isFrom).toBe(series.bars[0].time)
    expect(wf.folds[1].isFrom).toBe(series.bars[0].time)
  })

  test('a tiny dataset degrades honestly (empty folds + reason)', async () => {
    const tiny = prepareSeries(barsFrom(spikes(10))) // 110 bars
    const wf = await walkForward(tiny, baseCfg(bbParams()), { ranges, folds: 3, isFraction: 0.7, holdoutFraction: 0, minTrades: 1 })
    expect(wf.folds.length).toBe(0)
    expect(wf.holdoutDisabled).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Monte Carlo bootstrap
// ---------------------------------------------------------------------------
describe('monteCarloBootstrap — sequence-risk stress', () => {
  test('all-positive trades → P(loss) 0 and p5 > 0', () => {
    const mc = monteCarloBootstrap(Array.from({ length: 40 }, (_, i) => 10 + i), 10000, 500)
    expect(mc).not.toBeNull()
    expect(mc!.probLoss).toBe(0)
    expect(mc!.netPctP5).toBeGreaterThan(0)
    expect(mc!.netPctP5).toBeLessThanOrEqual(mc!.netPctP50)
    expect(mc!.netPctP50).toBeLessThanOrEqual(mc!.netPctP95)
  })

  test('all-negative trades → P(loss) 1', () => {
    const mc = monteCarloBootstrap(Array.from({ length: 40 }, (_, i) => -(10 + i)), 10000, 500)
    expect(mc!.probLoss).toBe(1)
    expect(mc!.netPctP95).toBeLessThan(0)
  })

  test('deterministic for a fixed seed', () => {
    const pnls = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -25 : 12))
    const a = monteCarloBootstrap(pnls, 10000, 300, 42)
    const b = monteCarloBootstrap(pnls, 10000, 300, 42)
    expect(a!.netPctP50).toBe(b!.netPctP50)
    expect(a!.maxDDPctP95).toBe(b!.maxDDPctP95)
  })

  test('fewer than 10 trades → null (not enough to mean anything)', () => {
    expect(monteCarloBootstrap([5, 5, 5], 10000)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility — old stored runs pick the new gates up gracefully
// ---------------------------------------------------------------------------
describe('normalizeAlgoParams — Task 12 keys default cleanly', () => {
  test('legacy params object gains the regime gates with catalog defaults', () => {
    const p = normalizeAlgoParams('bb-reversion', { bbPeriod: 30 })
    expect(p.bbPeriod).toBe(30) // legacy value preserved
    expect(p.regimeTrend).toBe(1) // P0 trend gate ships ON for bb-reversion
    expect(p.regimeAdx).toBe(0)
    expect(p.adxMax).toBe(25)
    expect(p.hlGate).toBe(1) // P1 half-life gate ships ON for bb-reversion
    expect(p.hlMax).toBe(96) // review calibration: 48 vetoed genuine MR setups (4h on 5m)
  })

  test('orb15 gains the volume filter default OFF; values clamp to range', () => {
    const p = normalizeAlgoParams('orb15', { orbVolMult: 99 })
    expect(p.orbVolMult).toBe(5)
    const d = normalizeAlgoParams('orb15', {})
    expect(d.orbVolMult).toBe(0)
  })
})
