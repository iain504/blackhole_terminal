// Task 11-a — TOTP suite (the deep review called testing "Critical" with
// "essentially only one TOTP test"; this upgrades it to a real suite).
//
//   · RFC 6238 Appendix-B SHA-1 vectors drive totpCodeAt() directly — the
//     pure absolute-time core (no timers, no sleeps).
//   · verifyTotp's ±1 step drift window and digit sanitising.
//   · generateTotpSecret alphabet/length contract.
//
// RFC vectors use an 8-digit profile; our implementation emits 6 digits, so
// each vector is compared on its last 6 (same convention as the old probe —
// but now with a REAL test runner and failure messages).
import { describe, test, expect } from 'bun:test'
import { totpCodeAt, totpCode, verifyTotp, generateTotpSecret } from '../src/lib/totp'

// RFC 6238 Appendix B — secret = ASCII "12345678901234567890", SHA-1.
const secretAscii = '12345678901234567890'

// Minimal RFC 4648 base32 encoder (the implementation under test keeps its
// decoder private; encoding here keeps the test dependency-free).
function b32(bytes: Buffer): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31]
  return out
}

const secretB32 = b32(Buffer.from(secretAscii, 'ascii'))

// [unix time, expected 8-digit OTP from RFC 6238 appendix B (SHA-1)]
const vectors: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'], // exercises the 64-bit counter hi-word path
]

describe('totpCodeAt — RFC 6238 vectors (SHA-1, last 6 digits)', () => {
  for (const [t, expected8] of vectors) {
    test(`t=${t}`, () => {
      expect(totpCodeAt(secretB32, 30, t)).toBe(expected8.slice(-6))
    })
  }
})

describe('totpCode — current-window wrapper', () => {
  test('offset=0 equals totpCodeAt(now)', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(totpCode(secretB32, 30, 0)).toBe(totpCodeAt(secretB32, 30, now))
  })
  test('offset is measured in whole steps', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(totpCode(secretB32, 30, 1)).toBe(totpCodeAt(secretB32, 30, now + 30))
    expect(totpCode(secretB32, 30, -1)).toBe(totpCodeAt(secretB32, 30, now - 30))
  })
  test('always emits 6 characters', () => {
    expect(totpCode(secretB32)).toMatch(/^\d{6}$/)
  })
})

describe('verifyTotp — drift window and sanitising', () => {
  const now = Math.floor(Date.now() / 1000)
  test('accepts the current window code', () => {
    expect(verifyTotp(secretB32, totpCodeAt(secretB32, 30, now))).toBe(true)
  })
  test('accepts one window of clock drift (both directions)', () => {
    expect(verifyTotp(secretB32, totpCodeAt(secretB32, 30, now - 30))).toBe(true)
    expect(verifyTotp(secretB32, totpCodeAt(secretB32, 30, now + 30))).toBe(true)
  })
  test('rejects two windows of drift', () => {
    expect(verifyTotp(secretB32, totpCodeAt(secretB32, 30, now - 90))).toBe(false)
  })
  test('rejects malformed input', () => {
    expect(verifyTotp(secretB32, '')).toBe(false)
    expect(verifyTotp(secretB32, '12345')).toBe(false) // too short
    expect(verifyTotp(secretB32, '1234567')).toBe(false) // too long
    expect(verifyTotp(secretB32, 'abcdef')).toBe(false) // no digits at all
  })
})

describe('generateTotpSecret — RFC 4648 shape', () => {
  test('default 20 bytes → 32 base32 chars, valid alphabet', () => {
    const s = generateTotpSecret()
    expect(s).toMatch(/^[A-Z2-7]{32}$/)
  })
  test('length param maps bytes → ceil(bytes*8/5) chars', () => {
    expect(generateTotpSecret(10)).toMatch(/^[A-Z2-7]{16}$/)
  })
  test('secrets are unique', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret())
  })
})
