import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJsonSafe, deviceHeartbeatSchema, deviceRenameSchema, zodBadRequest } from '@/lib/validation'
import { handleError } from '@/lib/api-helpers'

// v2.9.3 — device awareness. One row per (account, browser): identity comes
// from a client-persistent UUID (localStorage; browsers never expose MAC
// addresses) + a friendly UA-derived name. The heartbeat (POST) also carries
// the LIVE terminal state — which tab is open and which are open — so the FSD
// "Devices" card shows who is on what, right now.
//
//   GET    /api/devices            — list the account's devices (recent first)
//   POST   /api/devices            — heartbeat: register + report live tab state
//   PATCH  /api/devices            — rename a device (own account only)
//   DELETE /api/devices?deviceId=  — forget a device row

const ONLINE_WINDOW_MS = 90_000

export async function GET() {
  try {
    const user = await requireUser()
    const devices = await db.device.findMany({
      where: { userId: user.id },
      orderBy: { lastSeenAt: 'desc' },
      take: 24,
    })
    return NextResponse.json({
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        kind: d.kind,
        currentTab: d.currentTab,
        openTabs: Array.isArray(d.openTabs) ? (d.openTabs as string[]) : [],
        lastSeenAt: d.lastSeenAt.toISOString(),
        online: Date.now() - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
      })),
    })
  } catch (e) {
    return handleError(e)
  }
}

// Heartbeat. The name is only applied on FIRST registration — afterwards the
// row's name is owned by PATCH (rename) so a rename can't be clobbered by the
// next heartbeat (the renamed device keeps the name in its localStorage
// override anyway, so its own heartbeats agree).
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const parsed = deviceHeartbeatSchema.safeParse(await readJsonSafe(req))
    if (!parsed.success) return zodBadRequest(parsed.error)
    const b = parsed.data
    const row = await db.device.upsert({
      where: { userId_deviceId: { userId: user.id, deviceId: b.deviceId } },
      create: {
        userId: user.id,
        deviceId: b.deviceId,
        name: b.name,
        kind: b.kind,
        ua: b.ua ?? null,
        currentTab: b.currentTab ?? null,
        openTabs: b.openTabs ?? [],
      },
      update: {
        kind: b.kind,
        ua: b.ua ?? null,
        currentTab: b.currentTab ?? null,
        openTabs: b.openTabs ?? [],
        lastSeenAt: new Date(),
      },
    })
    return NextResponse.json({ ok: true, id: row.id, createdAt: row.createdAt.toISOString() })
  } catch (e) {
    return handleError(e)
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser()
    const parsed = deviceRenameSchema.safeParse(await readJsonSafe(req))
    if (!parsed.success) return zodBadRequest(parsed.error)
    const { deviceId, name } = parsed.data
    const existing = await db.device.findUnique({
      where: { userId_deviceId: { userId: user.id, deviceId } },
    })
    if (!existing) return NextResponse.json({ error: 'device not found' }, { status: 404 })
    const row = await db.device.update({
      where: { userId_deviceId: { userId: user.id, deviceId } },
      data: { name },
    })
    return NextResponse.json({ ok: true, name: row.name })
  } catch (e) {
    return handleError(e)
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser()
    const deviceId = new URL(req.url).searchParams.get('deviceId')
    if (!deviceId) return NextResponse.json({ error: 'deviceId required' }, { status: 400 })
    const existing = await db.device.findUnique({
      where: { userId_deviceId: { userId: user.id, deviceId } },
    })
    if (!existing) return NextResponse.json({ error: 'device not found' }, { status: 404 })
    await db.device.delete({ where: { userId_deviceId: { userId: user.id, deviceId } } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleError(e)
  }
}
