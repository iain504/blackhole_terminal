// v2.9.3 — device awareness (client side).
//
// A browser can never see the device's MAC address (network hardware identity
// is not exposed to web pages), so a device is identified by:
//   1. a persistent UUID generated on first visit and kept in localStorage,
//   2. a friendly name derived from the User-Agent (browser · OS), which the
//      user can override per device (also localStorage).
// The identity + the LIVE tab state (current tab, open tabs) are reported to
// /api/devices by useDeviceHeartbeat so the FSD "Devices" card can show which
// machine has what open.
//
// SSR safety: nothing here touches window/navigator at module evaluation —
// only inside functions, and every function guards for SSR.
import { useEffect } from 'react'
import type { Tab, TabType } from '@/store/terminal'
import { useTerminal } from '@/store/terminal'

const DEVICE_ID_KEY = 'bh.deviceId'
const DEVICE_NAME_KEY = 'bh.deviceName'

export type DeviceKind = 'desktop' | 'tablet' | 'mobile'

export interface DeviceInfo {
  name: string
  kind: DeviceKind
  ua: string
}

/** Persistent per-browser UUID (created on first call, kept in localStorage). */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return ''
  try {
    let id = window.localStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      window.localStorage.setItem(DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    return ''
  }
}

/** User override for this device's friendly name (null when untouched). */
export function getDeviceNameOverride(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(DEVICE_NAME_KEY)
  } catch {
    return null
  }
}

/** Store (or clear with '') the local override for this device's name. */
export function setDeviceNameOverride(name: string): void {
  if (typeof window === 'undefined') return
  try {
    if (name.trim()) window.localStorage.setItem(DEVICE_NAME_KEY, name.trim())
    else window.localStorage.removeItem(DEVICE_NAME_KEY)
  } catch {
    /* private mode — server row still carries the rename */
  }
}

/** Parse UA into { browser · OS } + coarse device kind. */
export function describeDevice(): DeviceInfo {
  if (typeof navigator === 'undefined') return { name: 'Unknown device', kind: 'desktop', ua: '' }
  const ua = navigator.userAgent || ''
  const iPad =
    /iPad/.test(ua) || (navigator.platform === 'MacIntel' && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1)
  const kind: DeviceKind =
    /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua))
      ? 'mobile'
      : iPad || /Android(?!.*Mobile)/.test(ua) || /Tablet|PlayBook|Silk/.test(ua)
        ? 'tablet'
        : 'desktop'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser\//.test(ua)
      ? 'Samsung Internet'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser'
  const name = [browser, os].filter(Boolean).join(' · ') || 'Unknown device'
  return { name, kind, ua: ua.slice(0, 200) }
}

/** The device's effective name: user override wins, UA-derived is the fallback. */
export function effectiveDeviceName(): string {
  return getDeviceNameOverride() || describeDevice().name
}

/** Compact label for a tab, used by the awareness payload + the devices card. */
const TAB_SHORT: Record<TabType, string> = {
  chart: 'Chart',
  calendar: 'Calendar',
  heatmap: 'Heat map',
  positions: 'Positions',
  strategy: 'Strategy',
  report: 'Report',
  algo: 'Algo',
  grid: 'Grid',
  agent: 'FSD',
}

export function tabShortLabel(t: Pick<Tab, 'type' | 'symbol' | 'timeframe'>): string {
  if (t.type === 'chart') return `${t.symbol || 'Chart'}${t.timeframe ? ` · ${t.timeframe}` : ''}`
  return TAB_SHORT[t.type]
}

/**
 * Heartbeat loop — registers this browser under the signed-in account and
 * keeps /api/devices posted with the live tab state. Sends:
 *   - immediately on mount / on auth,
 *   - 1.5s after any tab change (open / close / switch / rename),
 *   - every 30s while the tab is visible (fresh lastSeenAt = presence),
 *   - via sendBeacon on page unload (final state, no fetch teardown race).
 * No-ops while logged out or when localStorage is unavailable (SSR/private).
 */
export function useDeviceHeartbeat(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    let debounce: ReturnType<typeof setTimeout> | undefined

    const payload = () => {
      const s = useTerminal.getState()
      const deviceId = getDeviceId()
      if (!deviceId || !s.user) return null
      const info = describeDevice()
      const openTabs = s.tabs.slice(0, 12).map(tabShortLabel)
      const active = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
      return {
        deviceId,
        name: effectiveDeviceName(),
        kind: info.kind,
        ua: info.ua,
        currentTab: active ? tabShortLabel(active) : null,
        openTabs,
      }
    }

    const send = () => {
      if (document.hidden) return
      const body = payload()
      if (!body) return
      void fetch('/api/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {})
    }

    const scheduleSend = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(send, 1500)
    }

    // tab state changes (open/close/switch — both fields swap identity)
    const unsub = useTerminal.subscribe((s, prev) => {
      if (s.tabs === prev.tabs && s.activeTabId === prev.activeTabId && !!s.user === !!prev.user) return
      if (s.user) scheduleSend()
    })

    send() // register immediately (also fires when auth lands — user flips)
    const timer = setInterval(send, 30_000)
    const onVisible = () => {
      if (!document.hidden) send()
    }
    document.addEventListener('visibilitychange', onVisible)
    const onUnload = () => {
      const body = payload()
      if (!body) return
      try {
        navigator.sendBeacon('/api/devices', new Blob([JSON.stringify(body)], { type: 'application/json' }))
      } catch {
        /* older browsers — the 30s cadence still covers us */
      }
    }
    window.addEventListener('pagehide', onUnload)

    return () => {
      unsub()
      clearInterval(timer)
      if (debounce) clearTimeout(debounce)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [])
}
