// Shared bar-series cache for poll engines (indicator alarms + strategy bot).
// Both engines are polled by every open tab every ~20-30s; a short TTL
// collapses concurrent polls for the same series into ONE upstream fetch.
import { getBars } from '@/lib/alpaca'
import { Bar, Timeframe } from '@/lib/market-types'

const barsCache = new Map<string, { bars: Bar[]; demo: boolean; at: number }>()
const BARS_TTL_MS = 20000

export async function barsFor(symbol: string, tf: Timeframe, userId: string) {
  const key = `${symbol}|${tf}`
  const hit = barsCache.get(key)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit
  const res = await getBars(symbol, tf, userId)
  const entry = { bars: res.bars, demo: Boolean(res.demo), at: Date.now() }
  barsCache.set(key, entry)
  return entry
}
