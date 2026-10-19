// Real-time price stream client (socket.io → mini-services/stream-service).
//
// One shared connection for the whole app; subscriptions are refcounted per
// symbol so 8 chart panes + watchlist + quote panel all multiplex over a
// single websocket. Ticks arrive as `tick` events carrying an array of
// { s, p, t, o?, h?, l?, v?, demo? } (demo:true = simulated upstream).
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
  demo?: boolean
}

type TickHandler = (t: StreamTick) => void

let socket: Socket | null = null
const handlers = new Map<string, Set<TickHandler>>()
const desired = new Set<string>()

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
    if (desired.size > 0) socket!.emit('sub', { symbols: [...desired] })
  })
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
    id: () => socket?.id ?? null,
    desired: () => [...desired],
    handlers: () => [...handlers.keys()],
  }
}
