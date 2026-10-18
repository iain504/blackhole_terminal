import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'

// Economic-calendar event alarms (Task 28 #3).
// GET  /api/calendar/alarms  -> { keys: string[] }  (enabled event keys)
// POST /api/calendar/alarms  { key, on }            -> toggle one alarm

/** Max length of a derived event key ("<ISO time>|<CCY>|<title>"). */
const KEY_MAX = 300

export async function GET() {
  try {
    const user = await requireUser()
    const rows = await db.calendarAlarm.findMany({
      where: { userId: user.id },
      select: { eventKey: true },
    })
    return NextResponse.json({ keys: rows.map((r) => r.eventKey) })
  } catch (e) {
    return handleError(e)
  }
}

interface ToggleBody {
  key?: string
  on?: boolean
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = await readJson<ToggleBody>(req)
    const key = (body.key || '').trim()
    if (!key || key.length > KEY_MAX) {
      return NextResponse.json({ error: 'valid key required' }, { status: 400 })
    }
    if (body.on) {
      await db.calendarAlarm.upsert({
        where: { userId_eventKey: { userId: user.id, eventKey: key } },
        create: { userId: user.id, eventKey: key },
        update: {},
      })
    } else {
      await db.calendarAlarm.deleteMany({
        where: { userId: user.id, eventKey: key },
      })
    }
    return NextResponse.json({ ok: true, key, on: Boolean(body.on) })
  } catch (e) {
    return handleError(e)
  }
}
