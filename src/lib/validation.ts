// Shared zod (v4) schemas + parse-then-validate helpers for Task 4-d routes
// (settings / drawings / watchlists / layout). readJson<T> in api-helpers.ts
// stays untouched for legacy routes; validated routes do:
//   req.json() (malformed → 400) → schema.safeParse → 400/413 → route logic.
import { NextResponse } from 'next/server'
import { z } from 'zod'

/** Shared 400 body for zod failures: { error: 'Invalid body', details?: firstIssueMessage } */
export function zodBadRequest(error: z.ZodError): NextResponse {
  return NextResponse.json(
    { error: 'Invalid body', details: error.issues[0]?.message },
    { status: 400 },
  )
}

/** req.json() that returns null on malformed JSON instead of throwing. */
export async function readJsonSafe(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

// ---- shared field schemas ---------------------------------------------------

/** Task 4-d symbol regex extended with the client's real charset: the store's
 *  addSymbolToWatchlist guard accepts `.` `-` `/` `:` (BRK.B, BRK-B, BTC/USD,
 *  NYSE:SYM) — without `-`/`:` every drawing on such symbols would 400. */
export const SYMBOL_REGEX = /^[-A-Za-z0-9./$=:]{1,20}$/
export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{3,8}$/

export const symbolSchema = z.string().regex(SYMBOL_REGEX, 'Invalid symbol')
export const hexColorSchema = z
  .string()
  .regex(HEX_COLOR_REGEX, 'Invalid color (expected #rgb, #rrggbb or #rrggbbaa)')

/** Shape-safe scalar: string ≤10k chars, finite number, or boolean. */
export const boundedScalar = z.union([
  z.string().max(10_000, 'String value too long (max 10,000 chars)'),
  z.number().finite(),
  z.boolean(),
])

// ---- settings PUT: bounded JSON object --------------------------------------

/** 256KB cap on the JSON.stringify length of the settings body. */
export const SETTINGS_MAX_JSON_CHARS = 256 * 1024

const settingsKey = z.string().max(64, 'Setting key too long (max 64 chars)')
// arrays hold scalars only (max 500 items); object nesting is unrolled to
// depth 4 (V1 → V2 → V3 → V4) so z.lazy recursion can't run away
const settingsArray = z.array(boundedScalar).max(500, 'Array too long (max 500 items)')
const settingsV4 = z.union([boundedScalar, settingsArray])
const settingsV3 = z.union([boundedScalar, settingsArray, z.record(settingsKey, settingsV4)])
const settingsV2 = z.union([boundedScalar, settingsArray, z.record(settingsKey, settingsV3)])
const settingsV1 = z.union([boundedScalar, settingsArray, z.record(settingsKey, settingsV2)])

/** Recursively drops $-prefixed keys (operator-injection hygiene). */
function stripDollarKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDollarKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$')) continue
      out[k] = stripDollarKeys(v)
    }
    return out
  }
  return value
}

/**
 * PUT /api/settings body: object with string keys (≤64 chars) whose values are
 * bounded scalars / scalar arrays (≤500) / nested objects (max depth 4).
 * Unknown keys are inert (the route hand-picks known fields — strip
 * discipline, NOT passthrough); $-prefixed keys are stripped recursively.
 */
export const settingsBodySchema = z
  .record(settingsKey, settingsV1)
  .transform(stripDollarKeys)

export function settingsBodyTooLarge(raw: unknown): boolean {
  return JSON.stringify(raw ?? {}).length > SETTINGS_MAX_JSON_CHARS
}

// ---- drawings POST / PATCH ---------------------------------------------------

/** Must match src/store/terminal.ts `DrawingKind` (the only drawing client). */
export const DRAWING_KINDS = ['hline', 'vline', 'trend', 'fib', 'rect', 'text'] as const

export const drawingPointSchema = z.object({
  // lightweight-charts UTCTimestamp (unix seconds); null for hline/vline
  time: z.number().nullable().optional(),
  price: z.number().finite(),
  // scale the point belongs to (terminal.ts DrawingPane)
  pane: z.enum(['price', 'vol', 'rsi', 'macd']).optional(),
})

const drawingMetaValue = boundedScalar

export const drawingMetaSchema = z
  .record(z.string().max(64), drawingMetaValue)
  .refine((m) => Object.keys(m).length <= 20, 'meta has too many keys (max 20)')
  .nullable()
  .optional()

export const drawingCreateSchema = z.object({
  symbol: symbolSchema,
  kind: z.enum(DRAWING_KINDS),
  points: z
    .array(drawingPointSchema)
    .min(1, 'At least one point required')
    .max(500, 'Too many points (max 500)'),
  color: hexColorSchema.optional(),
  width: z.number().int().min(1).max(10).optional(),
  meta: drawingMetaSchema,
})

export const drawingPatchSchema = z.object({
  points: z
    .array(drawingPointSchema)
    .min(1, 'At least one point required')
    .max(500, 'Too many points (max 500)')
    .optional(),
  color: hexColorSchema.optional(),
  width: z.number().int().min(1).max(10).optional(),
  meta: drawingMetaSchema,
})

// ---- watchlists POST / PATCH -------------------------------------------------

export const watchlistNameSchema = z
  .string()
  .trim()
  .min(1, 'Name required')
  .max(60, 'Name too long (max 60 chars)')

export const watchlistCreateSchema = z.object({
  name: watchlistNameSchema,
  color: hexColorSchema.optional(),
})

export const watchlistPatchSchema = z.object({
  name: watchlistNameSchema.optional(),
  color: hexColorSchema.optional(),
  sortOrder: z.number().int().optional(),
  // REAL item shape (terminal.ts): plain strings — symbols or "#Group" separators
  items: z
    .array(z.string().max(32, 'Item too long (max 32 chars)'))
    .max(200, 'Too many items (max 200)')
    .optional(),
})

// ---- layout PUT --------------------------------------------------------------

export const layoutPutSchema = z.object({
  data: z.unknown(),
  // ISO timestamp of the client's base revision (optimistic concurrency)
  baseUpdatedAt: z.string().nullish().transform((v) => v ?? undefined),
})
