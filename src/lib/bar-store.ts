// Task 3-d — SQLite persistence for CRYPTO bars only.
//
// Crypto bars are immutable once closed (no split/correction semantics like
// equities), so they can be cached locally forever and refreshed only at the
// tail. Stock bars deliberately stay OUT of this store: Alpaca stock responses
// are split-adjusted and the adjustment basis can change retroactively.
//
// Throughput notes (measured on this box, see worklog Task 3-d):
//   • batching via multi-row INSERT OR REPLACE statements; chunk size 140 rows
//     × 7 columns = 980 bind params — safely under every SQLite
//     SQLITE_MAX_VARIABLE_NUMBER limit (999 pre-3.32, 32766 after).
//   • ~70k bars land in ~1.2s (~60k rows/s); a full BTC 15m 730d window
//     persists in about a second, vs ~30s+ to re-fetch it from Alpaca.
//
// All failures are non-fatal by design: callers wrap or ignore — a broken/
// missing cache must never take down the market-data path.
import { db } from '@/lib/db'
import type { Bar } from '@/lib/market-types'

export interface BarCoverage {
  covered: boolean
  minTime: number | null
  maxTime: number | null
  count: number
}

// rows per INSERT statement (140 × 7 cols = 980 params < 999 always safe)
const CHUNK_ROWS = 140

/**
 * Upsert bars (batched multi-row INSERT OR REPLACE on the (symbol, tf, time)
 * PK). Returns the number of rows written. Throws on DB failure — callers
 * that must not fail wrap this in try/catch.
 */
export async function saveBars(symbol: string, tf: string, bars: Bar[]): Promise<number> {
  const clean = bars.filter(
    (b) => Number.isFinite(b.time) && b.time > 0 &&
      Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) &&
      Number.isFinite(b.close) && Number.isFinite(b.volume),
  )
  let written = 0
  for (let i = 0; i < clean.length; i += CHUNK_ROWS) {
    const chunk = clean.slice(i, i + CHUNK_ROWS)
    const values: unknown[] = []
    const placeholders: string[] = []
    for (const b of chunk) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?)')
      values.push(symbol, tf, b.time, b.open, b.high, b.low, b.close, b.volume)
    }
    const sql = `INSERT OR REPLACE INTO "Bar" ("symbol","tf","time","open","high","low","close","volume") VALUES ${placeholders.join(',')}`
    await db.$executeRawUnsafe(sql, ...values)
    written += chunk.length
  }
  return written
}

/** Load cached bars for [fromSec..toSec] (inclusive), sorted by time. */
export async function loadBars(symbol: string, tf: string, fromSec: number, toSec: number): Promise<Bar[]> {
  const rows = await db.$queryRawUnsafe<Array<{
    time: number; open: number; high: number; low: number; close: number; volume: number
  }>>(
    'SELECT "time","open","high","low","close","volume" FROM "Bar" WHERE "symbol" = ? AND "tf" = ? AND "time" >= ? AND "time" <= ? ORDER BY "time" ASC',
    symbol, tf, Math.floor(fromSec), Math.floor(toSec),
  )
  return rows.map((r) => ({
    time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }))
}

/**
 * Coverage check for [fromSec..toSec] based on the EXPECTED bar cadence.
 * Small gaps (low-liquidity periods) are tolerated: a window counts as
 * covered when the stored span reaches within 2 bars of both edges:
 *   covered = maxTime >= toSec - 2*tfSec && minTime <= fromSec + 2*tfSec
 */
export async function hasCoverage(
  symbol: string,
  tf: string,
  fromSec: number,
  toSec: number,
  tfSec: number,
): Promise<BarCoverage> {
  const rows = await db.$queryRawUnsafe<Array<{ mn: number | null; mx: number | null; n: number }>>(
    'SELECT MIN("time") AS mn, MAX("time") AS mx, COUNT(*) AS n FROM "Bar" WHERE "symbol" = ? AND "tf" = ? AND "time" >= ? AND "time" <= ?',
    symbol, tf, Math.floor(fromSec), Math.floor(toSec),
  )
  const row = rows[0]
  const minTime = row?.mn != null ? Number(row.mn) : null
  const maxTime = row?.mx != null ? Number(row.mx) : null
  const count = Number(row?.n ?? 0)
  const covered =
    minTime != null && maxTime != null && count > 0 &&
    maxTime >= toSec - 2 * tfSec &&
    minTime <= fromSec + 2 * tfSec
  return { covered, minTime, maxTime, count }
}

/** Test helper / admin: drop a cached series. */
export async function deleteBars(symbol: string, tf?: string): Promise<number> {
  if (tf != null) {
    return db.$executeRawUnsafe('DELETE FROM "Bar" WHERE "symbol" = ? AND "tf" = ?', symbol, tf)
  }
  return db.$executeRawUnsafe('DELETE FROM "Bar" WHERE "symbol" = ?', symbol)
}
