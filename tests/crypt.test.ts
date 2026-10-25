// Task 11-a — at-rest crypto (src/lib/crypt.ts): AES-256-GCM round-trip,
// tamper detection, unique IVs and the masking helper. The master secret
// resolves env-first (APP_ENCRYPTION_SECRET in .env), so the suite never
// touches the AppSecret table.
import { describe, test, expect, beforeAll } from 'bun:test'
import { encrypt, decrypt, maskKey } from '../src/lib/crypt'
import { resolveAppSecret } from '../src/lib/app-secret'

// The master secret resolves lazily at app boot (instrumentation.ts); the
// test harness must bootstrap it the same way before the first encrypt().
beforeAll(async () => {
  await resolveAppSecret()
})

describe('encrypt/decrypt — AES-256-GCM', () => {
  test('round-trips a typical broker key payload', () => {
    const secret = 'PKYABVGT36MRG7Q6L2HDCBU4SG-example'
    expect(decrypt(encrypt(secret))).toBe(secret)
  })
  test('round-trips unicode and newlines', () => {
    const secret = 'pässwörd\nwith\nlines\tand emoji 🔑'
    expect(decrypt(encrypt(secret))).toBe(secret)
  })
  test('empty-string plaintext still round-trips', () => {
    expect(decrypt(encrypt(''))).toBe('')
  })
  test('uses a fresh IV per call — identical plaintext, different ciphertext', () => {
    expect(encrypt('same-input')).not.toBe(encrypt('same-input'))
  })
  test('tampering the ciphertext fails the GCM tag → null (fail closed)', () => {
    const payload = encrypt('attack-at-dawn')
    const [iv, tag, data] = payload.split('.')
    const flipped = data.slice(0, -1) + (data.endsWith('0') ? '1' : '0')
    expect(decrypt(`${iv}.${tag}.${flipped}`)).toBeNull()
  })
  test('tampering the TAG also fails', () => {
    const payload = encrypt('attack-at-dusk')
    const [iv, tag, data] = payload.split('.')
    const flippedTag = tag.slice(0, -1) + (tag.endsWith('0') ? '1' : '0')
    expect(decrypt(`${iv}.${flippedTag}.${data}`)).toBeNull()
  })
  test('malformed payloads → null, never throws', () => {
    expect(decrypt('not-a-payload')).toBeNull()
    expect(decrypt('a.b')).toBeNull()
    expect(decrypt('zz.yy.xx')).toBeNull()
    expect(decrypt('')).toBeNull()
  })
})

describe('maskKey', () => {
  test('long keys keep head and tail', () => {
    expect(maskKey('ABCDEFGHIJ')).toBe('ABCD••••GHIJ')
  })
  test('short values mask fully', () => {
    expect(maskKey('abc')).toBe('••••')
  })
  test('empty value stays empty', () => {
    expect(maskKey('')).toBe('')
  })
})
