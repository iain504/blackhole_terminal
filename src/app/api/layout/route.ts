import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'

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
}

// PUT /api/layout — save layout blob (called by 5s autosave)
export async function PUT(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJson<PutBody>(req)
    if (body.data == null) return NextResponse.json({ error: 'data required' }, { status: 400 })
    await db.layout.upsert({
      where: { userId: user.id },
      update: { data: body.data as object },
      create: { userId: user.id, data: body.data as object },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
