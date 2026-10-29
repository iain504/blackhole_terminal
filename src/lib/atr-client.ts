// Client-side helper for ATR-mode TP/SL previews (v1.96.0).
// Thin fetch wrapper over GET /api/market/atr + the same side math the
// engines apply server-side, so a ticket/drawer shows the EXACT trigger
// price a multiplier resolves to BEFORE submitting (the submitted payload
// stays the resolved absolute price — the engines' order layer never sees ATR).

export interface AtrInfo {
  atr: number | null
  refPrice: number | null
  tf: string
  period: number
  demo?: boolean
  error?: string
  message?: string
}

/** Fetch the current Wilder ATR(14) for a symbol+timeframe (server-cached 60s). */
export async function fetchAtr(symbol: string, tf: string, period = 14): Promise<AtrInfo> {
  try {
    const q = new URLSearchParams({ symbol, tf, period: String(period) })
    const r = await fetch(`/api/market/atr?${q.toString()}`, { cache: 'no-store' })
    if (!r.ok) {
      const j = await r.json().catch(() => null)
      return { atr: null, refPrice: null, tf, period, error: j?.error || `HTTP ${r.status}` }
    }
    return (await r.json()) as AtrInfo
  } catch {
    return { atr: null, refPrice: null, tf, period, error: 'network' }
  }
}

/**
 * Resolve an ATR exit price from a basis price (the same price the % math
 * anchors on: limit price for limit orders, live price for market orders).
 *   BUY  → TP above basis, SL below basis
 *   SELL → mirrored
 * Returns null when the inputs don't produce a positive price.
 */
export function atrExitPrice(
  side: 'buy' | 'sell',
  basis: number,
  mult: number,
  atr: number,
  kind: 'tp' | 'sl',
): number | null {
  if (!(basis > 0) || !(mult > 0) || !(atr > 0)) return null
  const dist = mult * atr
  const profitSide = kind === 'tp' ? side === 'buy' : side === 'sell'
  const px = profitSide ? basis + dist : basis - dist
  return px > 0 ? px : null
}

/** "1.5×ATR(1h)" label used by chips/diffs across the UI. */
export function fmtAtrExit(value: number | null | undefined, tf?: string | null): string {
  const v = Math.abs(Number(value ?? 0))
  return `${v.toFixed(v >= 10 ? 1 : 2)}×ATR(${tf || '1h'})`
}

/** ATR timeframe choices for the leg timeframe selects (chart timeframes). */
export const ATR_TF_OPTIONS: { value: string; label: string }[] = [
  { value: '5m', label: '5m bars' },
  { value: '15m', label: '15m bars' },
  { value: '1h', label: '1H bars' },
  { value: '4h', label: '4H bars' },
  { value: '1D', label: '1D bars' },
  { value: '1W', label: '1W bars' },
]
