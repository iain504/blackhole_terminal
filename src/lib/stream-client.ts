// Real-time price stream client (socket.io → mini-services/stream-service).
//
// One shared connection for the whole app; subscriptions are refcounted per
// symbol so 8 chart panes + watchlist + quote panel all multiplex over a
// single websocket. Ticks arrive as `tick` events carrying an array of
// { s, p, t, o?, h?, l?, v? } — REAL upstream ticks only (the simulated-tick
// "SIM" generator was permanently removed; symbols without a live upstream
// simply produce no ticks and REST polling stays the fallback).
//
// NOTE: the socket is created lazily on the FIRST subscribe (client-side
// only) and sends the session cookie (withCredentials) so the stream service
// can resolve the user's Alpaca keys server-side — keys never reach the
// browser.
import { io, Socket } from 'socket.io-client'

export interface StreamTick {
  s: string
  p: number
  t: number
  o?: number
  h?: number
  l?: number
  v?: number
}

type TickHandler = (t: StreamTick) => void

let socket: Socket | null = null
const handlers = new Map<string, Set<TickHandler>>()
const desired = new Set<string>()

// ---- connection-status emitter (Task 4-c) --------------------------------
// Tiny module-level pub/sub so UI (the terminal status chip) can react to
// socket transitions without a store or re-render cascade. Three states:
//   'idle'         — no socket was ever created (no subscription yet); REST
//                    polling is the fallback → chip shows "Polling"
//   'connected'    — socket.io is connected → chip shows "Live"
//   'reconnecting' — socket exists but is down; socket.io auto-reconnects
//                    with backoff (1s → 15s) → chip shows "Reconnecting…"
export type StreamStatus = 'idle' | 'connected' | 'reconnecting'

let streamStatus: StreamStatus = 'idle'
const statusListeners = new Set<(s: StreamStatus) => void>()

function setStreamStatus(next: StreamStatus): void {
  if (next === streamStatus) return
  streamStatus = next
  for (const l of statusListeners) {
    try { l(next) } catch { /* a bad listener must not break the tick path */ }
  }
}

/**
 * Subscribe to stream connection-status changes. Fires immediately with the
 * current status on subscribe (so callers initialize without waiting for the
 * next transition), then on every connect/disconnect. Returns unsubscribe.
 * Purely visual — persists nothing.
 */
export function onConnectChange(cb: (status: StreamStatus) => void): () => void {
  statusListeners.add(cb)
  cb(streamStatus)
  return () => {
    statusListeners.delete(cb)
  }
}

/** Current connection status ('idle' | 'connected' | 'reconnecting'). */
export function getStreamStatus(): StreamStatus {
  return streamStatus
}

function ensureSocket() {
  if (socket) return
  socket = io('/?XTransformPort=3030', {
    transports: ['websocket', 'polling'],
    withCredentials: true, // session cookie → per-user Alpaca keys server-side
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    timeout: 8000,
  })
  socket.on('connect', () => {
    setStreamStatus('connected')
    if (desired.size > 0) socket!.emit('sub', { symbols: [...desired] })
  })
  socket.on('disconnect', () => setStreamStatus('reconnecting'))
  // failed attempts between reconnect ticks keep the chip honest immediately
  socket.on('connect_error', () => setStreamStatus('reconnecting'))
  socket.on('tick', (batch: StreamTick[] | StreamTick) => {
    const arr = Array.isArray(batch) ? batch : [batch]
    for (const t of arr) {
      if (!t || typeof t.s !== 'string' || !Number.isFinite(t.p)) continue
      const hs = handlers.get(t.s)
      if (hs) for (const h of hs) h(t)
    }
  })
}

/**
 * Subscribe to streaming ticks for symbols. Returns an unsubscribe function.
 * Safe to call multiple times for the same symbol (refcounted).
 */
export function subscribeStream(symbols: string[], handler: TickHandler): () => void {
  if (symbols.length === 0) return () => {}
  ensureSocket()
  const fresh: string[] = []
  for (const s of symbols) {
    let set = handlers.get(s)
    if (!set) {
      set = new Set()
      handlers.set(s, set)
      desired.add(s)
      fresh.push(s)
    }
    set.add(handler)
  }
  if (fresh.length > 0 && socket?.connected) socket.emit('sub', { symbols: fresh })
  return () => {
    const dropped: string[] = []
    for (const s of symbols) {
      const set = handlers.get(s)
      if (!set) continue
      set.delete(handler)
      if (set.size === 0) {
        handlers.delete(s)
        desired.delete(s)
        dropped.push(s)
      }
    }
    if (dropped.length > 0 && socket?.connected) socket.emit('unsub', { symbols: dropped })
  }
}

/** True when the shared socket is connected (otherwise REST polling is the fallback). */
export function isStreamConnected(): boolean {
  return Boolean(socket?.connected)
}

// debug handle (harmless): lets DevTools / E2E inspect the stream state
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__ttStream = {
    connected: () => Boolean(socket?.connected),
    status: () => streamStatus,
    id: () => socket?.id ?? null,
    desired: () => [...desired],
    handlers: () => [...handlers.keys()],
  }
}
