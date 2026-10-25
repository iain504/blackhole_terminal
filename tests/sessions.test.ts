// Task 11-a — US-equity session classification (src/lib/sessions.ts).
// sessionOf() classifies a bar by its OPEN time in America/New_York; the
// constants live here as the single source of truth (Task 11-f centralized
// the engine/backtest copies onto the same values).
import { describe, test, expect } from 'bun:test'
import { sessionOf, etMinutesOfDay, etDateKey, RTH_START_MIN, RTH_END_MIN } from '../src/lib/sessions'

/** unix seconds for a UTC wall time (month is 1-based). */
const utc = (y: number, mo: number, d: number, h: number, mi: number) =>
  Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000)

// January = EST (UTC-5) · July = EDT (UTC-4). RTH = 09:30–16:00 ET.
describe('sessionOf', () => {
  test('09:30 ET boundary is REGULAR (inclusive start) — winter', () => {
    expect(sessionOf(utc(2026, 1, 15, 14, 30))).toBe('regular') // 09:30 EST
  })
  test('15:59 ET is REGULAR', () => {
    expect(sessionOf(utc(2026, 1, 15, 20, 59))).toBe('regular')
  })
  test('16:00 ET boundary is EXTENDED (exclusive end)', () => {
    expect(sessionOf(utc(2026, 1, 15, 21, 0))).toBe('extended')
  })
  test('pre-market 08:30 ET is EXTENDED', () => {
    expect(sessionOf(utc(2026, 1, 15, 13, 30))).toBe('extended')
  })
  test('DST summer: 09:30 EDT is REGULAR', () => {
    expect(sessionOf(utc(2026, 7, 15, 13, 30))).toBe('regular')
  })
  test('DST summer: 16:00 EDT is EXTENDED', () => {
    expect(sessionOf(utc(2026, 7, 15, 20, 0))).toBe('extended')
  })
  test('overnight session is EXTENDED', () => {
    expect(sessionOf(utc(2026, 1, 15, 5, 0))).toBe('extended') // 00:00 ET
  })
})

describe('etMinutesOfDay', () => {
  test('09:30 EST → 570 minutes', () => {
    expect(etMinutesOfDay(utc(2026, 1, 15, 14, 30))).toBe(570)
  })
  test('16:00 EDT → 960 minutes', () => {
    expect(etMinutesOfDay(utc(2026, 7, 15, 20, 0))).toBe(960)
  })
})

describe('etDateKey — ET calendar-day rollover', () => {
  test('a late-ET-evening UTC instant belongs to the same ET day', () => {
    expect(etDateKey(utc(2026, 7, 15, 13, 30))).toBe('2026-07-15') // 09:30 EDT
  })
  test('03:30 UTC is the PREVIOUS evening in ET', () => {
    expect(etDateKey(utc(2026, 1, 15, 3, 30))).toBe('2026-01-14') // 22:30 EST
  })
})

describe('centralized RTH constants (Task 11-f)', () => {
  test('09:30 → 570, 16:00 → 960', () => {
    expect(RTH_START_MIN).toBe(570)
    expect(RTH_END_MIN).toBe(960)
  })
})
