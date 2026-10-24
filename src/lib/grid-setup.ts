// BLACKHOLE grid setup — portable export/import serialization (Task 10-f).
//
// A "setup" is the pure CONFIG of a grid trade (exactly what the create dialog
// submits to POST /api/grid) — NOT its runtime state: no id, lots, fills,
// P/L or timestamps travel with it. Wire format (v1):
//
// {
//   "kind": "blackhole-grid-setup",
//   "version": 1,
//   "symbol": "BTC/USD",
//   "lowerPrice": 78000,
//   "upperPrice": 82000,
//   "gridCount": 6,
//   "spacing": "arithmetic",
//   "qtyPerGrid": 0.001,
//   "maxSL": null,
//   "slBasis": "price",
//   "maxTP": null,
//   "tpBasis": "price",
//   "direction": "both",
//   "closeOnStop": true,
//   "exportedAt": "2026-10-24T12:00:00.000Z"
// }
//
// parseGridSetup mirrors the server-side create rules (same bounds / percent
// windows) so an imported setup that passes here also passes POST — but the
// server ALWAYS re-validates; this is for early, honest UI feedback only.

export const GRID_SETUP_KIND = 'blackhole-grid-setup'
export const GRID_SETUP_VERSION = 1

/** Portable grid configuration — the shape both the export file and the
 * dialog's import applier work with. */
export type GridSetupDirection = 'both' | 'buy' | 'sell'

export interface GridSetup {
  symbol: string
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: 'arithmetic' | 'geometric'
  qtyPerGrid: number
  maxSL: number | null
  slBasis: 'price' | 'percent'
  maxTP: number | null
  tpBasis: 'price' | 'percent'
  /** Task 10-g — one-sided grids; absent in pre-10-g files reads as 'both' */
  direction: GridSetupDirection
  closeOnStop: boolean
}

/** What actually lands in the exported .json file (setup + envelope). */
export interface GridSetupFile extends GridSetup {
  kind: string
  version: number
  exportedAt: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Minimum shape a grid row (GridTradeDto) must expose to be exported.
 * slBasis/tpBasis are optional strings — pre-10-a rows lack them (→ 'price').
 * direction optional — pre-10-g rows lack it (→ 'both'). */
export type GridSetupRowLike = Pick<
  GridSetup, 'lowerPrice' | 'upperPrice' | 'gridCount' | 'qtyPerGrid' | 'maxSL' | 'maxTP' | 'closeOnStop'
> & {
  symbol: string
  spacing: string
  slBasis?: string | null
  tpBasis?: string | null
  direction?: string | null
}

/** Serialize a grid row (API DTO) into the portable setup file. */
export function gridSetupFromRow(row: GridSetupRowLike): GridSetupFile {
  return {
    kind: GRID_SETUP_KIND,
    version: GRID_SETUP_VERSION,
    symbol: row.symbol,
    lowerPrice: round2(row.lowerPrice),
    upperPrice: round2(row.upperPrice),
    gridCount: row.gridCount,
    spacing: row.spacing === 'geometric' ? 'geometric' : 'arithmetic',
    qtyPerGrid: row.qtyPerGrid,
    maxSL: row.maxSL,
    slBasis: row.slBasis === 'percent' ? 'percent' : 'price',
    maxTP: row.maxTP,
    tpBasis: row.tpBasis === 'percent' ? 'percent' : 'price',
    direction: row.direction === 'buy' || row.direction === 'sell' ? row.direction : 'both',
    closeOnStop: !!row.closeOnStop,
    exportedAt: new Date().toISOString(),
  }
}

export type ParseGridSetupResult =
  | { ok: true; setup: GridSetup }
  | { ok: false; error: string }

/** Parse + validate a setup JSON string. Tolerates a missing `kind` (shape
 * based) but rejects a WRONG kind, so pasting any other JSON fails loudly. */
export function parseGridSetup(text: string): ParseGridSetupResult {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Not valid JSON' }
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Not a grid setup object' }
  }
  const o = obj as Record<string, unknown>
  if (o.kind != null && o.kind !== GRID_SETUP_KIND) {
    return { ok: false, error: `Not a BLACKHOLE grid setup (kind "${String(o.kind).slice(0, 40)}")` }
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const lower = num(o.lowerPrice)
  const upper = num(o.upperPrice)
  if (!(lower > 0) || !(upper > 0)) return { ok: false, error: 'lowerPrice / upperPrice missing or invalid' }
  const lowerR = round2(lower)
  const upperR = round2(upper)
  if (upperR <= lowerR) return { ok: false, error: 'upperPrice must be above lowerPrice' }
  const count = num(o.gridCount)
  if (!Number.isInteger(count) || count < 2 || count > 100) {
    return { ok: false, error: 'gridCount must be an integer 2–100' }
  }
  const qty = num(o.qtyPerGrid)
  if (!(qty > 0)) return { ok: false, error: 'qtyPerGrid must be a positive number' }
  // Task 10-g — one-sided grids; absent reads as 'both' (pre-10-g files)
  let direction: GridSetupDirection = 'both'
  if (o.direction != null) {
    if (o.direction === 'buy' || o.direction === 'sell' || o.direction === 'both') {
      direction = o.direction
    } else {
      return { ok: false, error: 'direction must be "both", "buy" or "sell"' }
    }
  }
  const basis = (v: unknown) => (v === 'percent' ? 'percent' : 'price') as 'price' | 'percent'
  const slBasis = basis(o.slBasis)
  const tpBasis = basis(o.tpBasis)
  const rawSL = o.maxSL == null ? null : num(o.maxSL)
  const rawTP = o.maxTP == null ? null : num(o.maxTP)
  if (o.maxSL != null && !(rawSL! > 0)) return { ok: false, error: 'maxSL must be a positive number or null' }
  if (o.maxTP != null && !(rawTP! > 0)) return { ok: false, error: 'maxTP must be a positive number or null' }
  if (slBasis === 'percent' && rawSL != null && rawSL > 90) {
    return { ok: false, error: 'maxSL percent must be within 0–90' }
  }
  if (tpBasis === 'percent' && rawTP != null && rawTP > 1000) {
    return { ok: false, error: 'maxTP percent must be within 0–1000' }
  }
  if (direction !== 'sell') {
    // long ordering (both / buy): SL strictly below lower, TP strictly above upper
    if (slBasis === 'price' && rawSL != null && rawSL >= lowerR) {
      return { ok: false, error: 'maxSL (price) must be below the lower price' }
    }
    if (tpBasis === 'price' && rawTP != null && rawTP <= upperR) {
      return { ok: false, error: 'maxTP (price) must be above the upper price' }
    }
  } else {
    // sell-only mirrors the ordering (SL above upper, TP below lower)
    if (slBasis === 'price' && rawSL != null && rawSL <= upperR) {
      return { ok: false, error: 'maxSL (price) must be above the upper price for sell-only grids' }
    }
    if (tpBasis === 'price' && rawTP != null && rawTP >= lowerR) {
      return { ok: false, error: 'maxTP (price) must be below the lower price for sell-only grids' }
    }
  }
  return {
    ok: true,
    setup: {
      symbol: typeof o.symbol === 'string' ? o.symbol : '',
      lowerPrice: lowerR,
      upperPrice: upperR,
      gridCount: count,
      spacing: o.spacing === 'geometric' ? 'geometric' : 'arithmetic',
      qtyPerGrid: qty,
      maxSL: rawSL != null ? round2(rawSL) : null,
      slBasis,
      maxTP: rawTP != null ? round2(rawTP) : null,
      tpBasis,
      direction,
      closeOnStop: o.closeOnStop !== false,
    },
  }
}

/** "BTC/USD" → "BTC-USD" — filesystem-safe filename chunk. */
const safeSym = (s: string) => s.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'grid'

export function gridSetupFilename(symbol: string): string {
  const d = new Date().toISOString().slice(0, 10)
  return `grid-setup-${safeSym(symbol)}-${d}.json`
}

/** Trigger a browser download of the setup JSON. */
export function downloadGridSetup(setup: GridSetupFile): void {
  const blob = new Blob([`${JSON.stringify(setup, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = gridSetupFilename(setup.symbol)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
