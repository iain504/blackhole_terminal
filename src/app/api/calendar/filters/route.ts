import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'

// Task 31 — Economic Calendar filter preferences (per-account, permanent).
// GET  /api/calendar/filters -> { imp: string[] | null, countryExclusions: string[] | null }
//      (null = the user never saved a choice yet — client keeps its defaults)
// PUT  /api/calendar/filters { imp: string[], countryExclusions: string[] }
//      -> upserts the row; the client always sends BOTH fields (full state,
//      last-write-wins) so no merge logic is needed server-side.
//
// `imp` holds the ENABLED importance levels; `countryExclusions` holds the
// EXCLUDED country/currency codes — countries NOT in the list always show,
// so newly-appearing currencies are visible without touching the saved
// choice (the user's exclusions are what's remembered).

const IMP_LEVELS = ['high', 'medium', 'low'] as const
const EXCL_MAX = 64
const EXCL_LEN_MAX = 12 // currency codes are ≤5 chars; '—' placeholder is 1

/** Parse a stored JSON string-array column; anything malformed → null. */
function parseStringArray(raw: string | null | undefined): string[] | null {
  if (typeof raw !== 'string') return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    return v.filter((x): x is string => typeof x === 'string')
  } catch {
    return null
  }
}

function sanitizeImp(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string' && (IMP_LEVELS as readonly string[]).includes(x) && !out.includes(x)) {
      out.push(x)
    }
  }
  return out
}

function sanitizeExclusions(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const t = x.trim()
    if (!t || t.length > EXCL_LEN_MAX || out.includes(t)) continue
    out.push(t)
    if (out.length >= EXCL_MAX) break
  }
  return out
}

export async function GET() {
  try {
    const user = await requireUser()
    const row = await db.calendarFilterPref.findUnique({ where: { userId: user.id } })
    if (!row) return NextResponse.json({ imp: null, countryExclusions: null })
    return NextResponse.json({
      imp: parseStringArray(row.imp) ?? [],
      countryExclusions: parseStringArray(row.countryExclusions) ?? [],
    })
  } catch (e) {
    return handleError(e)
  }
}

interface PutBody {
  imp?: unknown
  countryExclusions?: unknown
}

export async function PUT(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJson<PutBody>(req)
    const imp = sanitizeImp(body.imp)
    const countryExclusions = sanitizeExclusions(body.countryExclusions)
    if (imp == null || countryExclusions == null) {
      return NextResponse.json(
        { error: 'imp and countryExclusions arrays are required' },
        { status: 400 },
      )
    }
    await db.calendarFilterPref.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        imp: JSON.stringify(imp),
        countryExclusions: JSON.stringify(countryExclusions),
      },
      update: {
        imp: JSON.stringify(imp),
        countryExclusions: JSON.stringify(countryExclusions),
      },
    })
    return NextResponse.json({ ok: true, imp, countryExclusions })
  } catch (e) {
    return handleError(e)
  }
}
