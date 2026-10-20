import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'

interface PatchBody {
  name?: string
  color?: string
  sortOrder?: number
  items?: string[]
}

// PATCH /api/watchlists/[id] — rename / recolor / reorder / replace items
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const body = await readJson<PatchBody>(req)
    const list = await db.watchlist.findFirst({ where: { id, userId: user.id } })
    if (!list) return NextResponse.json({ error: 'Watchlist not found' }, { status: 404 })
    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 40)
    if (typeof body.color === 'string') data.color = body.color
    if (typeof body.sortOrder === 'number') data.sortOrder = body.sortOrder
    if (Array.isArray(body.items)) {
      // entries starting with '#' are GROUP SEPARATORS, not symbols — keep
      // their case so group names render as the user typed them (real symbols
      // are uppercased)
      const items = [
        ...new Set(
          body.items
            .map((s) => {
              const t = String(s).trim()
              if (!t) return ''
              return t.startsWith('#') ? `#${t.slice(1).trim().slice(0, 30)}` : t.toUpperCase()
            })
            .filter(Boolean),
        ),
      ].slice(0, 50)
      data.items = items
    }
    const updated = await db.watchlist.update({ where: { id }, data })
    const items = Array.isArray(updated.items) ? (updated.items as string[]) : []
    return NextResponse.json({ list: { id: updated.id, name: updated.name, color: updated.color, sortOrder: updated.sortOrder, items } })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/watchlists/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser()
    const { id } = await params
    const list = await db.watchlist.findFirst({ where: { id, userId: user.id } })
    if (!list) return NextResponse.json({ error: 'Watchlist not found' }, { status: 404 })
    await db.watchlist.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
