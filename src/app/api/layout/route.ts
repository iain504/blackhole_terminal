import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJsonSafe, layoutPutSchema, zodBadRequest } from '@/lib/validation'
import { handleError } from '@/lib/api-helpers'

// GET /api/layout — stored layout blob
export async function GET() {
  try {
    const user = await requireUser()
    const layout = await db.layout.findUnique({ where: { userId: user.id } })
    return NextResponse.json({ data: layout?.data ?? null })
  } catch (e) {
    return handleError(e)
  }
}

interface PutBody {
  data: unknown
  baseUpdatedAt?: string
}

// PUT /api/layout — save layout blob (called by 5s autosave).
// Optimistic concurrency (Task 4-d): when the body carries `baseUpdatedAt`
// (ISO string of the client's base revision) and the stored row is MORE than
// 2s newer (clock-skew allowance), the save is rejected with
//   409 { error: 'layout_conflict', server: { updatedAt, data } }
// so the client can reload the newer blob instead of clobbering it.
// WITHOUT baseUpdatedAt the route behaves exactly as before
// (last-writer-wins, backward compatible with open tabs / sendBeacon).
export async function PUT(req: Request) {
  try {
    const user = await requireUser()
    const raw = await readJsonSafe(req)
    const parsed = layoutPutSchema.safeParse(raw)
    if (!parsed.success) return zodBadRequest(parsed.error)
    const body = parsed.data as PutBody
    if (body.data == null) return NextResponse.json({ error: 'data required' }, { status: 400 })
    if (body.baseUpdatedAt !== undefined) {
      const baseMs = Date.parse(body.baseUpdatedAt)
      if (Number.isNaN(baseMs)) {
        return NextResponse.json(
          { error: 'Invalid baseUpdatedAt (expected ISO date string)' },
          { status: 400 },
        )
      }
      const current = await db.layout.findUnique({ where: { userId: user.id } })
      if (current && current.updatedAt.getTime() > baseMs + 2_000) {
        return NextResponse.json(
          {
            error: 'layout_conflict',
            server: { updatedAt: current.updatedAt.toISOString(), data: current.data },
          },
          { status: 409 },
        )
      }
    }
    const saved = await db.layout.upsert({
      where: { userId: user.id },
      update: { data: body.data as object },
      create: { userId: user.id, data: body.data as object },
    })
    // updatedAt is additive — old clients ignore it
    return NextResponse.json({ ok: true, updatedAt: saved.updatedAt.toISOString() })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/layout — same save, but for navigator.sendBeacon: the beforeunload
// flush fires as a POST (sendBeacon can't send PUT), so without this handler
// the final layout flush on tab close / reload silently 404s and the last
// few seconds of layout changes (symbol switches, chart-type toggles) are lost.
export async function POST(req: Request) {
  return PUT(req)
}
