'use client'

// v2.9.3 — "Devices" card (FSD tab, desktop + mobile). Device awareness for
// the terminal: every signed-in browser heartbeats /api/devices with its
// identity (persistent UUID + friendly name) and its LIVE tab state, so this
// card shows which machine has what open right now. Rename (persists via the
// server PATCH + a localStorage override so the device agrees) and forget
// (removes the row; the device re-registers on its next heartbeat if it is
// still active). Browsers cannot see MAC addresses — the persistent UUID +
// UA-derived name is the honest identity.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Monitor,
  MonitorSmartphone,
  Pencil,
  Smartphone,
  Tablet,
  UserCheck,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getDeviceId, setDeviceNameOverride } from '@/lib/device'

interface DeviceRow {
  deviceId: string
  name: string
  kind: string
  currentTab: string | null
  openTabs: string[]
  lastSeenAt: string
  online: boolean
}

function relTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'mobile') return <Smartphone className="h-4 w-4 shrink-0 text-zinc-400" />
  if (kind === 'tablet') return <Tablet className="h-4 w-4 shrink-0 text-zinc-400" />
  return <Monitor className="h-4 w-4 shrink-0 text-zinc-400" />
}

export function DevicesCard() {
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmForget, setConfirmForget] = useState<string | null>(null)
  const myDeviceId = useRef<string>('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/devices', { cache: 'no-store' })
      if (!res.ok) return
      const j = (await res.json()) as { devices?: DeviceRow[] }
      if (Array.isArray(j.devices)) setDevices(j.devices)
    } catch {
      /* offline — keep last list */
    }
  }, [])

  useEffect(() => {
    myDeviceId.current = getDeviceId()
    void load()
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, 30_000)
    return () => clearInterval(timer)
  }, [load])

  const saveName = async (deviceId: string) => {
    const name = draft.trim()
    if (!name) return
    setBusy(true)
    try {
      const res = await fetch('/api/devices', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, name }),
      })
      if (res.ok) {
        if (deviceId === myDeviceId.current) setDeviceNameOverride(name)
        setEditing(null)
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  const forget = async (deviceId: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/devices?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
      if (res.ok) {
        setConfirmForget(null)
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  const online = (devices ?? []).filter((d) => d.online).length
  const total = devices?.length ?? 0

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => {
          setOpen((v) => !v)
          if (!open) void load() // fresh data on every expand
        }}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <MonitorSmartphone className="h-4 w-4 text-zinc-400" /> Devices
        </span>
        <span className="text-[11px] font-normal text-zinc-500">
          {total === 0 ? 'show known devices' : `${total} device${total === 1 ? '' : 's'} · ${online} online`}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {(devices ?? []).map((d) => {
            const mine = d.deviceId === myDeviceId.current
            return (
              <div
                key={d.deviceId}
                className={`rounded-md border px-2.5 py-2 ${
                  mine ? 'border-cyan-500/30 bg-cyan-500/5' : 'border-zinc-800 bg-zinc-800/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <KindIcon kind={d.kind} />
                  {editing === d.deviceId ? (
                    <>
                      <Input
                        autoFocus
                        value={draft}
                        maxLength={40}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveName(d.deviceId)
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        className="h-7 flex-1 border-zinc-700 bg-zinc-900 text-xs text-zinc-100"
                        aria-label="Device name"
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-emerald-400 hover:text-emerald-300"
                        disabled={busy}
                        onClick={() => void saveName(d.deviceId)}
                        aria-label="Save device name"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-zinc-500 hover:text-zinc-300"
                        onClick={() => setEditing(null)}
                        aria-label="Cancel rename"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200" title={d.name}>
                        {d.name}
                      </span>
                      {mine && (
                        <span className="flex shrink-0 items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-cyan-300">
                          <UserCheck className="h-2.5 w-2.5" aria-hidden /> This device
                        </span>
                      )}
                      <span
                        className={`flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          d.online ? 'bg-emerald-500/10 text-emerald-300' : 'bg-zinc-800 text-zinc-500'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${d.online ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600'}`}
                          aria-hidden
                        />
                        {d.online ? 'online' : relTime(d.lastSeenAt)}
                      </span>
                    </>
                  )}
                </div>

                {editing !== d.deviceId && (
                  <div className="mt-1.5 flex items-center justify-between gap-2 pl-6">
                    <div className="min-w-0 text-[11px] leading-tight">
                      {d.currentTab ? (
                        <span className="truncate text-zinc-300">
                          Viewing <span className="font-medium text-zinc-100">{d.currentTab}</span>
                          {d.openTabs.length > 1 && (
                            <span
                              className="ml-1 text-zinc-500"
                              title={d.openTabs.join(' · ')}
                            >
                              (+{d.openTabs.length - 1} more tab{d.openTabs.length > 2 ? 's' : ''})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-zinc-600">no tab reported yet</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-zinc-500 hover:text-zinc-200"
                        disabled={busy}
                        aria-label={`Rename ${d.name}`}
                        onClick={() => {
                          setEditing(d.deviceId)
                          setDraft(d.name)
                          setConfirmForget(null)
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      {!mine && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`h-6 px-1.5 text-[10px] ${
                            confirmForget === d.deviceId
                              ? 'text-rose-400 hover:text-rose-300'
                              : 'text-zinc-600 hover:text-zinc-300'
                          }`}
                          disabled={busy}
                          onClick={() => {
                            if (confirmForget === d.deviceId) void forget(d.deviceId)
                            else {
                              setConfirmForget(d.deviceId)
                              setTimeout(() => setConfirmForget((c) => (c === d.deviceId ? null : c)), 3000)
                            }
                          }}
                          aria-label={`Forget ${d.name}`}
                        >
                          {confirmForget === d.deviceId ? 'Confirm?' : 'Forget'}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {devices && devices.length === 0 && (
            <p className="px-1 py-2 text-[11px] text-zinc-500">
              No devices registered yet — this browser registers itself within seconds.
            </p>
          )}
          {devices === null && (
            <p className="px-1 py-2 text-[11px] text-zinc-600">Loading devices…</p>
          )}

          <p className="px-1 pt-1 text-[10px] leading-relaxed text-zinc-600">
            A device is its browser (persistent ID + name — web pages cannot read MAC addresses). The list
            updates every 30s; a device is "online" while its terminal is open. Forgetting a live device only
            removes its row — it re-registers on the next heartbeat.
          </p>
        </div>
      )}
    </section>
  )
}
