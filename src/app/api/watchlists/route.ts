import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJsonSafe, watchlistCreateSchema, zodBadRequest } from '@/lib/validation'
import { handleError } from '@/lib/api-helpers'

export interface WatchlistDto {
  id: string
  name: string
  color: string
  sortOrder: number
  items: string[]
}

function toDto(w: { id: string; name: string; color: string; sortOrder: number; items: unknown }): WatchlistDto {
  const items = Array.isArray(w.items) ? (w.items as string[]) : []
  return { id: w.id, name: w.name, color: w.color, sortOrder: w.sortOrder, items }
}

// GET /api/watchlists — all lists for user
export async function GET() {
  try {
    const user = await requireUser()
    const lists = await db.watchlist.findMany({
      where: { userId: user.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json({ lists: lists.map(toDto) })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/watchlists — create list {name, color}.
// Body parse-then-validated (zod): name trimmed 1..60, color hex — 400 'Invalid body'.
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const raw = await readJsonSafe(req)
    const parsed = watchlistCreateSchema.safeParse(raw)
    if (!parsed.success) return zodBadRequest(parsed.error)
    // zod already trimmed the name; keep the existing 40-char storage cap
    const name = parsed.data.name.slice(0, 40)
    if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 })
    const count = await db.watchlist.count({ where: { userId: user.id } })
    const list = await db.watchlist.create({
      data: { userId: user.id, name, color: parsed.data.color || '#22c55e', sortOrder: count, items: [] },
    })
    return NextResponse.json({ list: toDto(list) })
  } catch (e) {
    return handleError(e)
  }
}
