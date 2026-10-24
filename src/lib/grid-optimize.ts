// Task 10-g — grid auto-optimize: sweep range widths × level counts around
// the CURRENT price over the requested backtest window and pick the config
// with the best risk-adjusted result.
//
// Pure module (no DB / network): the route fetches the bars once with the
// shared backtest machinery and feeds them here. The sweep re-runs
// simulateGridBacktest (the EXACT engine-parity sim the backtest API uses),
// so the optimizer's numbers match what "Run backtest" reports for the same
// config.
//
// Scoring: score = totalPnl − 0.5 × maxDrawdown (risk-adjusted, same currency
// units as P/L). A candidate is ELIGIBLE only when it produced activity
// (≥ MIN_FILLS fills) — an idle grid with a flat curve would otherwise win by
// having zero drawdown. If nothing is eligible the best of the configs that
// traded at all wins; when nothing traded at all the caller is told honestly.
import type { Bar } from '@/lib/market-types'
import {
  validateGridConfig,
  type GridDirection,
  type GridSpacing,
} from '@/lib/grid-engine'
import { simulateGridBacktest, type GridBacktestConfig } from '@/lib/grid-backtest'

/** Range widths swept as % of the center price (the range is centered on the
 * current close: lower = c×(1−w/200), upper = c×(1+w/200)). */
export const OPT_WIDTHS_PCT: readonly number[] = [3, 5, 8, 12, 20]

/** Level counts swept per width. */
export const OPT_COUNTS: readonly number[] = [4, 6, 8, 12, 16, 24]

/** A candidate needs at least this many simulated fills to be eligible. */
export const MIN_FILLS = 3

/** Drawdown penalty weight in the score. */
export const DD_WEIGHT = 0.5

const round2 = (n: number) => Math.round(n * 100) / 100

export interface GridOptCandidate {
  lowerPrice: number
  upperPrice: number
  gridCount: number
  totalPnl: number
  realizedPnl: number
  openPnl: number
  maxDrawdown: number
  fillsCount: number
  openLots: number
  winRate: number
  /** risk-adjusted score: totalPnl − DD_WEIGHT × maxDrawdown */
  score: number
}

export interface GridOptimizeResult {
  /** center price the sweep was anchored on (the last bar's close) */
  center: number
  tried: number
  /** null when NO swept config produced a single fill (honest no-activity) */
  best: GridOptCandidate | null
  /** top candidates by score (best first, ≤ 5) */
  runners: GridOptCandidate[]
}

/**
 * Sweep width × count around `center` and rank the results. `bars` must be
 * chronological closed bars (fetchBacktestBars output). Guards are NOT part
 * of the sweep (maxSL/maxTP null) — sizing and guards stay the user's call in
 * the dialog; only the range + level count are optimized.
 */
export function optimizeGridConfig(input: {
  center: number
  isCrypto: boolean
  direction: GridDirection
  spacing: GridSpacing
  qtyPerGrid: number
  bars: Bar[]
}): GridOptimizeResult {
  const { center, isCrypto, direction, spacing, qtyPerGrid, bars } = input
  const candidates: GridOptCandidate[] = []
  let tried = 0

  for (const w of OPT_WIDTHS_PCT) {
    for (const count of OPT_COUNTS) {
      const lower = round2(center * (1 - w / 200))
      const upper = round2(center * (1 + w / 200))
      // construction-valid, but run the shared validator anyway so a future
      // tweak of the sweep constants can never smuggle an invalid config in
      const invalid = validateGridConfig({
        lowerPrice: lower,
        upperPrice: upper,
        gridCount: count,
        spacing,
        qtyPerGrid,
        maxSL: null,
        maxTP: null,
        slBasis: 'price',
        tpBasis: 'price',
        isCrypto,
        direction,
      })
      if (invalid) continue
      tried++
      const cfg: GridBacktestConfig = {
        lowerPrice: lower,
        upperPrice: upper,
        gridCount: count,
        spacing,
        qtyPerGrid,
        maxSL: null,
        maxTP: null,
        slBasis: 'price',
        tpBasis: 'price',
        closeOnStop: true,
        isCrypto,
        direction,
      }
      const sim = simulateGridBacktest(cfg, bars)
      candidates.push({
        lowerPrice: lower,
        upperPrice: upper,
        gridCount: count,
        totalPnl: sim.stats.totalPnl,
        realizedPnl: sim.stats.realizedPnl,
        openPnl: sim.stats.openPnl,
        maxDrawdown: sim.stats.maxDrawdown,
        fillsCount: sim.stats.fillsCount,
        openLots: sim.stats.openLots,
        winRate: sim.stats.winRate,
        score: sim.stats.totalPnl - DD_WEIGHT * sim.stats.maxDrawdown,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const eligible = candidates.filter((c) => c.fillsCount >= MIN_FILLS)
  const traded = candidates.filter((c) => c.fillsCount > 0)
  const ranked = eligible.length > 0 ? eligible : traded
  return {
    center: round2(center),
    tried,
    best: ranked.length > 0 ? ranked[0] : null,
    runners: ranked.slice(0, 5),
  }
}
