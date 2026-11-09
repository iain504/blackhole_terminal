// v2.12.24 — cross-device sync + single-runner election for the two client-run
// AI engines (AI 自動交易 scanner + AI 護倉 steward).
//
// The engines live at module scope in the BROWSER (setTimeout chains) and
// their enabled flag + config used to be localStorage-only, which meant:
//   - computer 2 never saw what computer 1 switched on (the reported bug),
//   - two computers could BOTH run the same scanner (duplicate orders),
//   - a closed laptop silently killed the engine while another computer
//     still showed it as running.
//
// Design (mirrors the v2.9.3 device-awareness heartbeat):
//   - enabled + config live in the DB per (user, kind) — AiOpsState.
//   - every signed-in tab POSTs /api/settings/ai-ops/heartbeat every 20s
//     (plus once immediately on login). The server atomically elects ONE
//     runner (guarded updateMany: mine, free, or stale slot wins).
//   - isRunner:true  → the adapter starts its engine locally.
//     isRunner:false → the engine stays stopped; the UI shows
//     「其他裝置運行中」 with the runner's device name.
//   - toggles PUT the new state (claim:true hands the slot to the toggling
//     device); config edits PUT debounced, WITHOUT claiming the slot —
//     editing an interval on device 2 must not yank execution off device 1.
//   - pagehide beacon releases the slot for an instant takeover.
//   - a missing DB row (existing installs) migrates the local state up once.
//
// Stores plug in via registerAiOpsAdapter so this lib never imports a store
// (no import cycles): the adapter maps server verdicts onto local start/stop
// + honest log lines.
import { getDeviceId, effectiveDeviceName } from '@/lib/device'

export type AiOpsKind = 'auto-trade' | 'steward'

export interface AiOpsRunnerInfo {
  name: string
  isMe: boolean
}

export interface AiOpsAdapter {
  kind: AiOpsKind
  /** engine running locally right now? (config.enabled) */
  isEnabled: () => boolean
  /** resume-style local start (no immediate heavy scan, no server PUT) */
  startLocal: () => void
  /** local stop; the reason picks the honest log line */
  stopLocal: (reason: 'synced-off' | 'yield') => void
  /** merge a server config object into the store (sanitized, no PUT back) */
  adoptConfig: (cfg: unknown) => void
  /** push runner info into the store for the panel pill */
  setRunnerInfo: (info: AiOpsRunnerInfo | null) => void
  /** flip the account-level enabled flag WITHOUT touching the local engine
   *  (v2.12.24 semantics: config.enabled is the synced toggle; whether the
   *  engine actually runs here is decided by runnerInfo + startLocal) */
  setEnabledFlag: (on: boolean) => void
  /** current config minus `enabled`, for server storage */
  configForServer: () => Record<string, unknown>
}

const adapters = new Map<AiOpsKind, AiOpsAdapter>()
export function registerAiOpsAdapter(a: AiOpsAdapter): void {
  adapters.set(a.kind, a)
}

const TAB_KEY = 'bh.aiOpsTabNonce'
const TICK_MS = 20_000
/** Don't adopt server config right after a local PUT — the echo would clobber
 *  fresh local edits (the PUT itself already carries them to the server). */
const ADOPT_GUARD_MS = 6000
/** Debounce for config-edit PUTs (Select/slider interactions fire in bursts). */
const CONFIG_PUT_DEBOUNCE_MS = 800

let started = false
let timer: ReturnType<typeof setInterval> | null = null
let lastLocalPutAt = 0
const inflight = new Set<AiOpsKind>()
const mySlots = new Set<AiOpsKind>() // kinds where the server says I'm the runner
const configPutTimers = new Map<AiOpsKind, ReturnType<typeof setTimeout>>()

/** Runner identity: persistent deviceId + a per-tab nonce (sessionStorage).
 *  The nonce keeps two tabs of the SAME browser from both electing
 *  themselves (the device id alone is shared across tabs). */
function runnerId(): string {
  if (typeof window === 'undefined') return ''
  try {
    let nonce = window.sessionStorage.getItem(TAB_KEY)
    if (!nonce) {
      nonce =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      window.sessionStorage.setItem(TAB_KEY, nonce)
    }
    const dev = getDeviceId()
    return dev ? `${dev}:${nonce}` : nonce
  } catch {
    return ''
  }
}

/** Immediate push of the local state (enabled + config) to the server.
 *  claim:true also elects THIS device as the runner — used when the user
 *  turns an engine ON (they're looking at it) and during migration. A plain
 *  push (config edit / disable) never steals the slot. */
export async function pushAiOpsState(kind: AiOpsKind, opts?: { claim?: boolean }): Promise<void> {
  const ad = adapters.get(kind)
  if (!ad || typeof window === 'undefined') return
  lastLocalPutAt = Date.now()
  const enabled = ad.isEnabled()
  try {
    await fetch('/api/settings/ai-ops', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind,
        enabled,
        config: configForServer(ad),
        ...(enabled && opts?.claim ? { claim: true, runnerId: runnerId(), deviceName: effectiveDeviceName() } : {}),
      }),
    })
  } catch {
    /* offline — the heartbeat reconciles when the network returns */
  }
}

/** Debounced push after config edits (Select/slider interactions burst). */
export function queueAiOpsConfigPut(kind: AiOpsKind): void {
  if (typeof window === 'undefined') return
  const t = configPutTimers.get(kind)
  if (t) clearTimeout(t)
  configPutTimers.set(
    kind,
    setTimeout(() => {
      configPutTimers.delete(kind)
      void pushAiOpsState(kind)
    }, CONFIG_PUT_DEBOUNCE_MS),
  )
}

/** Strip `enabled` from the store config — the server column owns that flag
 *  (mirrors the PUT route's sanitizeConfig; belt and braces). */
function configForServer(ad: AiOpsAdapter): Record<string, unknown> {
  let base: Record<string, unknown> = {}
  try {
    const cfg = ad.configForServer()
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) base = { ...cfg }
  } catch {
    /* fall through with an empty config — the server keeps the last one */
  }
  delete base.enabled
  return base
}

interface HeartbeatResponse {
  exists?: boolean
  enabled?: boolean
  isRunner?: boolean
  runnerName?: string
  config?: unknown
}

async function tick(kind: AiOpsKind): Promise<void> {
  const ad = adapters.get(kind)
  if (!ad || inflight.has(kind)) return
  const rid = runnerId()
  if (!rid) return
  inflight.add(kind)
  try {
    const res = await fetch('/api/settings/ai-ops/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, runnerId: rid, deviceName: effectiveDeviceName() }),
    })
    if (!res.ok) return
    const j = (await res.json().catch(() => null)) as HeartbeatResponse | null
    if (!j) return

    if (!j.exists) {
      // Fresh install / never synced: migrate the local (localStorage) state
      // up so the other computers see it. Claim only if the engine is on.
      void pushAiOpsState(kind, { claim: ad.isEnabled() })
      return
    }

    const serverCfg = j.config
    if (serverCfg != null && Date.now() - lastLocalPutAt > ADOPT_GUARD_MS) ad.adoptConfig(serverCfg)

    if (!j.enabled) {
      mySlots.delete(kind)
      ad.setRunnerInfo(null)
      ad.setEnabledFlag(false)
      ad.stopLocal('synced-off') // no-op when the engine isn't running here
      return
    }

    // v2.12.24 semantics: config.enabled mirrors the ACCOUNT toggle on every
    // device; only the elected runner actually arms the engine.
    if (j.isRunner) {
      mySlots.add(kind)
      ad.setRunnerInfo({ name: effectiveDeviceName(), isMe: true })
      ad.setEnabledFlag(true)
      ad.startLocal() // adapter guards against double-start
    } else {
      mySlots.delete(kind)
      ad.setRunnerInfo({ name: j.runnerName || '其他裝置', isMe: false })
      ad.setEnabledFlag(true)
      ad.stopLocal('yield') // stopLocal no-ops when the engine isn't running here
    }
  } catch {
    /* offline — keep the current local state; no guessing */
  } finally {
    inflight.delete(kind)
  }
}

function onPageHide(): void {
  if (mySlots.size === 0 || typeof navigator === 'undefined') return
  const rid = runnerId()
  if (!rid) return
  for (const kind of mySlots) {
    try {
      navigator.sendBeacon(
        '/api/settings/ai-ops/release',
        new Blob([JSON.stringify({ kind, runnerId: rid })], { type: 'application/json' }),
      )
    } catch {
      /* older browsers — the 75s staleness window still frees the slot */
    }
  }
}

/** Start (idempotent) the sync loop — called from TerminalRoot once the user
 *  session is known. First beat is immediate so a fresh browser adopts the
 *  account state within ~1s of landing. */
export function startAiOpsSync(): void {
  if (started || typeof window === 'undefined' || adapters.size === 0) return
  started = true
  const beat = () => {
    for (const kind of adapters.keys()) void tick(kind)
  }
  beat()
  timer = setInterval(beat, TICK_MS)
  window.addEventListener('pagehide', onPageHide)
}

/** Stop the loop (logout). Engines keep their own local state — the terminal
 *  tears those down through the normal session flow. */
export function stopAiOpsSync(): void {
  if (!started) return
  started = false
  if (timer) { clearInterval(timer); timer = null }
  window.removeEventListener('pagehide', onPageHide)
  mySlots.clear()
}
