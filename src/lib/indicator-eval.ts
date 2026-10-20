// Shared indicator-condition evaluation for the poll engines (indicator
// alarms + strategy bot). Pure logic — no DB, no fetches.
//
// Crossing semantics (TradingView-style): the LAST bar of the series is the
// forming bar, so `last` tracks live while `prev` is the last CLOSED bar.
// Callers keep `lastSide` memory per rule; the first check only RECORDS the
// side, and only a genuine crossing afterwards fires.
import { rsi as rsiCalc, macd as macdCalc } from '@/lib/indicators'
import { Bar, TIMEFRAMES, Timeframe } from '@/lib/market-types'

export interface IndicatorParams {
  period?: number
  fast?: number
  slow?: number
  signal?: number
}

export interface IndEval {
  side: 'above' | 'below'
  value: number
  message: string
}

export type IndKind = 'rsi' | 'macd'

const tfLabel = (tf: string) => TIMEFRAMES[tf as Timeframe]?.label ?? tf

/** Valid MACD condition set (rsi uses direction above/below instead). */
export const MACD_CONDITIONS = ['bull_cross', 'bear_cross', 'cross_above', 'cross_below'] as const

/**
 * Evaluate one indicator condition against the bar series (chronological).
 * Returns the current side + a human message, or null when there is not
 * enough data. `condition` is MACD-only; `direction` applies to RSI and to
 * MACD cross_above/cross_below.
 */
export function evalIndicatorSignal(
  kind: IndKind,
  condition: string | null,
  direction: 'above' | 'below',
  level: number,
  timeframe: string,
  params: IndicatorParams | null,
  bars: Bar[],
): IndEval | null {
  const closes = bars.map((b) => b.close)
  if (kind === 'rsi') {
    const period = Number(params?.period) || 14
    const series = rsiCalc(closes, period)
    const last = series[series.length - 1]
    const prev = series[series.length - 2]
    if (last == null || prev == null) return null
    const side: 'above' | 'below' = last > level ? 'above' : 'below'
    return {
      side,
      value: last,
      message: `RSI(${period}) crossed ${direction === 'above' ? 'above' : 'below'} ${level} — now ${last.toFixed(1)} · ${tfLabel(timeframe)}`,
    }
  }
  // ---- macd ----
  const fast = Number(params?.fast) || 12
  const slow = Number(params?.slow) || 26
  const signal = Number(params?.signal) || 9
  const m = macdCalc(closes, fast, slow, signal)
  const lastM = m.macd[m.macd.length - 1]
  const prevM = m.macd[m.macd.length - 2]
  const label = `MACD(${fast},${slow},${signal})`
  if (condition === 'bull_cross' || condition === 'bear_cross') {
    const lastS = m.signal[m.signal.length - 1]
    const prevS = m.signal[m.signal.length - 2]
    if (lastM == null || prevM == null || lastS == null || prevS == null) return null
    const side: 'above' | 'below' = lastM > lastS ? 'above' : 'below'
    return {
      side,
      value: lastM,
      message: `${label} ${condition === 'bull_cross' ? 'bullish' : 'bearish'} crossover — macd ${lastM.toFixed(4)} ${side === 'above' ? '>' : '<'} signal ${lastS.toFixed(4)} · ${tfLabel(timeframe)}`,
    }
  }
  // cross_above / cross_below a fixed level (default zero line)
  if (lastM == null || prevM == null) return null
  const side: 'above' | 'below' = lastM > level ? 'above' : 'below'
  return {
    side,
    value: lastM,
    message: `${label} crossed ${direction === 'above' ? 'above' : 'below'} ${level} — now ${lastM.toFixed(4)} · ${tfLabel(timeframe)}`,
  }
}

/** True when `side` is a genuine crossing of `direction` given the memory. */
export function isCross(direction: 'above' | 'below', side: 'above' | 'below', lastSide: string | null): boolean {
  return direction === 'above' ? side === 'above' && lastSide !== 'above' : side === 'below' && lastSide !== 'below'
}
