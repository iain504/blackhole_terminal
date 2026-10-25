// Task 11-a — rate limiter against the REAL SQLite store (RateLimitBucket
// table). This is the integration test the deep review asked for: it proves
// fixed-window semantics end-to-end, including the window expiry and manual
// reset paths the auth flows depend on. Rows use unique per-run keys and are
// cleaned up afterwards, so the production table is never polluted.
import { describe, test, expect, afterAll } from 'bun:test'
import { rateLimit, resetRateLimit } from '../src/lib/rate-limit'

const base = `test:rl:${Date.now()}`
const usedKeys: string[] = []

function key(suffix: string): string {
  const k = `${base}:${suffix}`
  usedKeys.push(k)
  return k
}

describe('rateLimit — DB-backed fixed window', () => {
  afterAll(async () => {
    for (const k of usedKeys) await resetRateLimit(k)
  })

  test('allows up to max calls, then blocks with retryAfterSec', async () => {
    const k = key('cap')
    expect((await rateLimit(k, 2, 1500)).ok).toBe(true)
    expect((await rateLimit(k, 2, 1500)).ok).toBe(true)
    const third = await rateLimit(k, 2, 1500)
    expect(third.ok).toBe(false)
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(1)
    expect(third.retryAfterSec).toBeLessThanOrEqual(2)
  })

  test('a blocked caller stays blocked inside the same window', async () => {
    const k = key('sticky')
    await rateLimit(k, 1, 60_000)
    const blocked = await rateLimit(k, 1, 60_000)
    expect(blocked.ok).toBe(false)
    const still = await rateLimit(k, 1, 60_000)
    expect(still.ok).toBe(false)
  })

  test('window expiry lifts the block', async () => {
    const k = key('expire')
    await rateLimit(k, 1, 300)
    expect((await rateLimit(k, 1, 300)).ok).toBe(false)
    await Bun.sleep(450)
    expect((await rateLimit(k, 1, 300)).ok).toBe(true)
  })

  test('resetRateLimit clears the bucket immediately (auth success path)', async () => {
    const k = key('reset')
    await rateLimit(k, 1, 60_000)
    expect((await rateLimit(k, 1, 60_000)).ok).toBe(false)
    await resetRateLimit(k)
    expect((await rateLimit(k, 1, 60_000)).ok).toBe(true)
  })

  test('independent keys never share a window', async () => {
    const a = key('iso-a')
    const b = key('iso-b')
    await rateLimit(a, 1, 60_000)
    expect((await rateLimit(a, 1, 60_000)).ok).toBe(false)
    expect((await rateLimit(b, 1, 60_000)).ok).toBe(true)
  })
})
