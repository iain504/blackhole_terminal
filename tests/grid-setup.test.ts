// Task 11-a — portable grid setup serialization (src/lib/grid-setup.ts):
// single-setup (Task 10-f) and all-grids bundle (Task 10-l) wire formats.
// These are the exact code paths behind the Grid tab's Export / Import
// buttons — the review's "meaningful tests" ask, covering the serialization
// contract end-to-end: row → file → parse → setup, plus every validation
// rule the create dialog and the server share.
import { describe, test, expect } from 'bun:test'
import {
  GRID_SETUP_KIND,
  GRID_BUNDLE_KIND,
  GRID_BUNDLE_MAX,
  gridSetupFromRow,
  parseGridSetup,
  buildGridSetupBundle,
  parseGridSetupBundle,
  gridSetupFilename,
  gridBundleFilename,
  type GridSetupRowLike,
} from '../src/lib/grid-setup'

const row = (over: Partial<GridSetupRowLike> = {}): GridSetupRowLike => ({
  symbol: 'BTC/USD',
  lowerPrice: 78000,
  upperPrice: 82000,
  gridCount: 6,
  spacing: 'arithmetic',
  qtyPerGrid: 0.001,
  maxSL: null,
  maxTP: null,
  closeOnStop: true,
  ...over,
})

const okSetup = JSON.stringify({
  kind: GRID_SETUP_KIND,
  version: 1,
  symbol: 'BTC/USD',
  lowerPrice: 78000,
  upperPrice: 82000,
  gridCount: 6,
  spacing: 'arithmetic',
  qtyPerGrid: 0.001,
  maxSL: null,
  maxTP: null,
  closeOnStop: true,
})

describe('gridSetupFromRow → parseGridSetup round-trip', () => {
  test('preserves every config field', () => {
    const file = gridSetupFromRow(
      row({ maxSL: 76000, slBasis: 'price', maxTP: 85000, tpBasis: 'price', direction: 'buy' }),
    )
    const parsed = parseGridSetup(JSON.stringify(file))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.setup.symbol).toBe('BTC/USD')
    expect(parsed.setup.lowerPrice).toBe(78000)
    expect(parsed.setup.upperPrice).toBe(82000)
    expect(parsed.setup.gridCount).toBe(6)
    expect(parsed.setup.qtyPerGrid).toBe(0.001)
    expect(parsed.setup.maxSL).toBe(76000)
    expect(parsed.setup.maxTP).toBe(85000)
    expect(parsed.setup.direction).toBe('buy')
    expect(parsed.setup.closeOnStop).toBe(true)
  })
  test('pre-10-g rows (no direction) read as "both"', () => {
    const parsed = parseGridSetup(JSON.stringify(gridSetupFromRow(row())))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.setup.direction).toBe('both')
  })
  test('unusual spacing strings fall back to arithmetic', () => {
    const parsed = parseGridSetup(JSON.stringify(gridSetupFromRow(row({ spacing: 'weird' }))))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.setup.spacing).toBe('arithmetic')
  })
  test('prices are rounded to 2dp on export', () => {
    const file = gridSetupFromRow(row({ lowerPrice: 78000.123456, upperPrice: 82000.987654 }))
    expect(file.lowerPrice).toBe(78000.12)
    expect(file.upperPrice).toBe(82000.99)
  })
  test('legacy rows without basis fields default to "price"', () => {
    const r = row() as Record<string, unknown>
    delete r.slBasis
    delete r.tpBasis
    const file = gridSetupFromRow(r as unknown as GridSetupRowLike)
    expect(file.slBasis).toBe('price')
    expect(file.tpBasis).toBe('price')
  })
})

describe('parseGridSetup — validation rules', () => {
  test('accepts a well-formed setup (tolerating a missing kind)', () => {
    const noKind = JSON.stringify({ ...JSON.parse(okSetup), kind: undefined })
    expect(parseGridSetup(okSetup).ok).toBe(true)
    const cleaned = JSON.parse(okSetup)
    delete cleaned.kind
    expect(parseGridSetup(JSON.stringify(cleaned)).ok).toBe(true)
    expect(noKind).toBeDefined()
  })
  test('rejects non-JSON and wrong kinds loudly', () => {
    expect(parseGridSetup('{nope').ok).toBe(false)
    expect(parseGridSetup('null').ok).toBe(false)
    expect(parseGridSetup('"just a string"').ok).toBe(false)
    const wrong = parseGridSetup(JSON.stringify({ ...JSON.parse(okSetup), kind: 'something-else' }))
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toContain('BLACKHOLE')
  })
  test('rejects inverted / non-positive ranges', () => {
    expect(parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 100, gridCount: 2, qtyPerGrid: 1 })).ok).toBe(false)
    expect(parseGridSetup(JSON.stringify({ lowerPrice: 120, upperPrice: 100, gridCount: 2, qtyPerGrid: 1 })).ok).toBe(false)
    expect(parseGridSetup(JSON.stringify({ lowerPrice: 0, upperPrice: 100, gridCount: 2, qtyPerGrid: 1 })).ok).toBe(false)
  })
  test('gridCount must be an integer 2–100', () => {
    for (const bad of [1, 101, 6.5]) {
      expect(parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: bad, qtyPerGrid: 1 })).ok).toBe(false)
    }
  })
  test('qtyPerGrid must be positive', () => {
    expect(parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 0 })).ok).toBe(false)
  })
  test('percent SL must stay within 0–90', () => {
    const bad = parseGridSetup(
      JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 1, maxSL: 95, slBasis: 'percent' }),
    )
    expect(bad.ok).toBe(false)
  })
  test('price SL must sit strictly below lower (long grids)', () => {
    expect(
      parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 1, maxSL: 100, slBasis: 'price' })).ok,
    ).toBe(false)
    expect(
      parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 1, maxSL: 99, slBasis: 'price' })).ok,
    ).toBe(true)
  })
  test('price TP must sit strictly above upper (long grids)', () => {
    expect(
      parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 1, maxTP: 110, tpBasis: 'price' })).ok,
    ).toBe(false)
    expect(
      parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 1, maxTP: 111, tpBasis: 'price' })).ok,
    ).toBe(true)
  })
  test('sell-only mirrors the guard ordering', () => {
    const base = { lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 1, direction: 'sell' }
    expect(parseGridSetup(JSON.stringify({ ...base, maxSL: 105, slBasis: 'price' })).ok).toBe(false) // must be ABOVE upper
    expect(parseGridSetup(JSON.stringify({ ...base, maxSL: 115, slBasis: 'price' })).ok).toBe(true)
    expect(parseGridSetup(JSON.stringify({ ...base, maxTP: 100, tpBasis: 'price' })).ok).toBe(false) // must be BELOW lower
    expect(parseGridSetup(JSON.stringify({ ...base, maxTP: 95, tpBasis: 'price' })).ok).toBe(true)
  })
  test('direction must be both / buy / sell', () => {
    expect(
      parseGridSetup(JSON.stringify({ lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 1, direction: 'up' })).ok,
    ).toBe(false)
  })
})

describe('bundle (Task 10-l) — export all / import all', () => {
  test('build → parse round-trips every setup in order', () => {
    const rows = [row({ symbol: 'BTC/USD' }), row({ symbol: 'AAPL', lowerPrice: 100, upperPrice: 110, gridCount: 4, qtyPerGrid: 10 }), row({ symbol: 'ETH/USD', lowerPrice: 3000, upperPrice: 3200, gridCount: 8, qtyPerGrid: 0.05 })]
    const bundle = buildGridSetupBundle(rows)
    expect(bundle.kind).toBe(GRID_BUNDLE_KIND)
    expect(bundle.count).toBe(3)
    expect(bundle.setups.map((s) => s.symbol)).toEqual(['BTC/USD', 'AAPL', 'ETH/USD'])
    const parsed = parseGridSetupBundle(JSON.stringify(bundle))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.items.length).toBe(3)
    expect(parsed.items.every((i) => i.ok)).toBe(true)
  })
  test('accepts a single Task-10-f setup file (wrapped into one item)', () => {
    const parsed = parseGridSetupBundle(okSetup)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.items.length).toBe(1)
  })
  test('accepts a raw JSON array of setups', () => {
    const parsed = parseGridSetupBundle(JSON.stringify([JSON.parse(okSetup), JSON.parse(okSetup)]))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.items.length).toBe(2)
  })
  test('one bad item never poisons the rest', () => {
    const good = JSON.parse(okSetup)
    const bad = { ...good, gridCount: 999 }
    const parsed = parseGridSetupBundle(JSON.stringify([good, bad, good]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.items[0].ok).toBe(true)
    expect(parsed.items[1].ok).toBe(false)
    if (!parsed.items[1].ok) expect(parsed.items[1].error).toContain('#2')
    expect(parsed.items[2].ok).toBe(true)
  })
  test('rejects wrong kinds, empties and over-cap bundles', () => {
    expect(parseGridSetupBundle(JSON.stringify({ kind: 'nope' })).ok).toBe(false)
    expect(parseGridSetupBundle(JSON.stringify([])).ok).toBe(false)
    const tooMany = Array.from({ length: GRID_BUNDLE_MAX + 1 }, () => JSON.parse(okSetup))
    expect(parseGridSetupBundle(JSON.stringify(tooMany)).ok).toBe(false)
  })
  test('filenames are filesystem-safe and dated', () => {
    expect(gridSetupFilename('BTC/USD')).toMatch(/^grid-setup-BTC-USD-\d{4}-\d{2}-\d{2}\.json$/)
    expect(gridBundleFilename()).toMatch(/^grid-setups-bundle-\d{4}-\d{2}-\d{2}\.json$/)
  })
})
