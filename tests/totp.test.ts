// TOTP implementation check against RFC 6238 test vectors (SHA-1, 8 digits in
// the RFC; our impl pads to 6 digits — compare the last 6 of each vector).
import { base32Encode, totpAt } from "../src/lib/auth";

const secretAscii = "12345678901234567890";
const secretB32 = base32Encode(Buffer.from(secretAscii, "ascii"));

// [unix time, expected 8-digit OTP from RFC 6238 appendix B]
const vectors: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
];

let pass = 0;
for (const [t, expected8] of vectors) {
  const got = totpAt(secretB32, t);
  const expected6 = expected8.slice(-6);
  const ok = got === expected6;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} t=${t} got=${got} expected=${expected6}`);
}
console.log(`${pass}/${vectors.length} passed`);
if (pass !== vectors.length) process.exit(1);
