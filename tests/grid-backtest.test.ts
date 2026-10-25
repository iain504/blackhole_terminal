// Task 11-a — grid engine math, replayed: simulateGridBacktest() is the pure
// simulator behind POST /api/grid/backtest, and its fill/pnl/drawdown logic
// is the heart of the grid feature. Synthetic sawtooth bars give a
// deterministic replay: dip below the range (buys), rally above (sells),
// then crash through an SL guard.
import { describe, test, expect } from 'bun:test'
import { simulateGridBacktest, type GridBacktestConfig } from '../src/lib/grid-backtest'
import type { Bar } from '../src/lib/market-types'

// Range 100→110, 6 levels → 100, 102, 104, 106, 108, 110. qty 1 per level.
const cfg: GridBacktestConfig = {
  lowerPrice: 100,
  upperPrice: 110,
  gridCount: 6,
  spacing: 'arithmetic',
  qtyPerGrid: 1,
  maxSL: null,
  maxTP: null,
  slBasis: 'price',
  tpBasis: 'price',
  closeOnStop: true,
  isCrypto: true,
  direction: 'both',
}

/** Deterministic one-minute bars: (t, low, high, close). */
function bars(points: [number, number, number, number][]): Bar[] {
  return points.map(([t, low, high, close], i) => ({
    time: t,
    open: i === 0 ? close : points[i - 1][3],
    high,
    low,
    close,
    volume: 1000,
  }))
}

const SAWTOOTH: [number, number, number, number][] = [
  // warm-up inside the range, dip under the floor (buys at 104/102/100),
  // rally over the ceiling (sells with profit), settle back inside.
  [1000, 104, 106, 105],
  [1060, 99, 105, 100], // sweeps the lower half
  [1120, 100, 111, 110], // sweeps the upper half
  [1180, 108, 110, 109],
]

const CRASH: [number, number, number, number][] = [
  [1000, 104, 106, 105],
  [1060, 99, 105, 100],
  [1120, 88, 100, 90], // through a 95 maxSL guard
  [1180, 88, 92, 91],
]

describe('simulateGridBacktest — classic both-direction grid', () => {
  const r = simulateGridBacktest(cfg, bars(SAWTOOTH))

  test('dips below the floor trigger buys', () => {
    expect(r.stats.buys).toBeGreaterThanOrEqual(3)
  })
  test('rallies above the floor trigger profitable sells', () => {
    expect(r.stats.sells).toBeGreaterThanOrEqual(1)
    expect(r.stats.realizedPnl).toBeGreaterThan(0)
  })
  test('books reconcile: fills = buys + sells', () => {
    expect(r.stats.fillsCount).toBe(r.stats.buys + r.stats.sells)
  })
  test('win rate is a 0–100 percentage of sell fills', () => {
    expect(r.stats.winRate).toBeGreaterThan(0)
    expect(r.stats.winRate).toBeLessThanOrEqual(100)
  })
  test('curve has one point per bar (no downsampling at this size)', () => {
    expect(r.curve.length).toBe(SAWTOOTH.length)
  })
  test('unstopped run reports no stop reason', () => {
    expect(r.stopped).toBe(false)
    expect(r.stopReason).toBeNull()
  })
  test('drawdown is a finite, non-negative number', () => {
    expect(r.stats.maxDrawdown).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(r.stats.maxDrawdown)).toBe(true)
  })
})

describe('simulateGridBacktest — maxSL guard closes and stops', () => {
  const r = simulateGridBacktest({ ...cfg, maxSL: 95 }, bars(CRASH))
  test('run stops', () => {
    expect(r.stopped).toBe(true)
    expect(r.stopReason).toBeTruthy()
  })
  test('the crash produced fills (buys, then the guard close)', () => {
    expect(r.stats.fillsCount).toBeGreaterThan(0)
  })
  test('realized PnL includes the crash losses (negative)', () => {
    expect(r.stats.realizedPnl).toBeLessThan(0)
  })
  test('a crash marks the equity curve down (non-zero drawdown)', () => {
    expect(r.stats.maxDrawdown).toBeGreaterThan(0)
  })
})

describe('simulateGridBacktest — sell-only grid mirrors entries', () => {
  const RISING: [number, number, number, number][] = [
    [1000, 104, 106, 105],
    [1060, 104, 111, 110],
    [1120, 109, 115, 114],
  ]
  const r = simulateGridBacktest({ ...cfg, direction: 'sell' }, bars(RISING))
  test('rising prices produce sells (inverted entries)', () => {
    expect(r.stats.sells).toBeGreaterThanOrEqual(1)
  })
  test('no buys in a sell-only grid', () => {
    expect(r.stats.buys).toBe(0)
  })
})

describe('simulateGridBacktest — geometric spacing sanity', () => {
  test('geometric grid over the same sawtooth stays internally consistent', () => {
    const r = simulateGridBacktest({ ...cfg, spacing: 'geometric' }, bars(SAWTOOTH))
    expect(r.stats.fillsCount).toBe(r.stats.buys + r.stats.sells)
    expect(r.curve.length).toBe(SAWTOOTH.length)
  })
})
