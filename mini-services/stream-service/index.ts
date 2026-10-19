// stream-service — real-time price streaming for the trading terminal.
//
// Browser ──socket.io (path '/', port 3030, via Caddy ?XTransformPort=3030)──▶ this service
//   ├─ CRYPTO: one shared Binance websocket (free, keyless) → 24h miniTicker ≈ 1 tick/s/symbol
//   ├─ STOCKS: EXACTLY ONE Alpaca v2 iex websocket per account (Alpaca allows ONE concurrent
//   │          market-data connection per key — a 2nd gets error 406/403 "connection limit
//   │          exceeded"; the free plan also caps 30 subscribed symbols per websocket).
//   │          All browser tabs/panes/watchlists multiplex over that single connection.
//   │          Keys are resolved server-side from the user's session cookie via Next
//   │          /api/stream/keys — the browser NEVER sees keys.
//   └─ DEMO:   symbols without a live upstream (no keys / auth failed / slot busy /
//   │          over the 30-symbol cap / binance down) get simulated mean-reverting ticks
//   │          so the UI still streams (demo flag on the tick → SIM badge)
//   ▶ 'sub'   { symbols: string[] }    subscribe (refcounted)
//   ▶ 'unsub' { symbols: string[] }
//   ◀ 'tick'  { s, p, t, o?, h?, l?, v?, demo? }   throttled ≤ 5 msgs/s per symbol
import { createServer } from 'http'
import { Server, Socket } from 'socket.io'

const PORT = 3030
const NEXT_BASE = 'http://localhost:3000'
const BINANCE_WS = 'wss://stream.binance.com:9443/ws'
const ALPACA_WS = 'wss://stream.data.alpaca.markets/v2/iex'
const FLUSH_MS = 200 // per-symbol emit throttle → ≤5 msgs/s
const DEMO_TICK_MS = 1200
const KEY_CACHE_MS = 60_000
const QUOTE_TIMEOUT_MS = 4000
// Alpaca market data: ONE concurrent websocket per key (2nd → error 406/403)
// and the free/IEX plan caps 30 subscribed symbols per connection.
const ALPACA_SYMBOL_CAP = 30
const SLOT_COOLDOWN_MS = 2 * 60_000

const isCrypto = (s: string) => s.includes('/')

// ------------------------------- socket.io ---------------------------------
const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path — Caddy forwards by XTransformPort on '/'
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// ------------------------------ symbol registry ----------------------------
const refcounts = new Map<string, number>()
const socketSyms = new Map<Socket, Set<string>>()
function acquire(syms: string[]): string[] {
  const added: string[] = []
  for (const s of syms) {
    const cur = refcounts.get(s) ?? 0
    refcounts.set(s, cur + 1)
    if (cur === 0) added.push(s)
  }
  return added
}
function release(syms: string[]): string[] {
  const removed: string[] = []
  for (const s of syms) {
    const cur = (refcounts.get(s) ?? 0) - 1
    if (cur <= 0) {
      refcounts.delete(s)
      removed.push(s)
    } else refcounts.set(s, cur)
  }
  return removed
}
const desiredCrypto = () => [...refcounts.keys()].filter(isCrypto)
const desiredStocks = () => [...refcounts.keys()].filter((s) => !isCrypto(s))

// ------------------------------ tick fan-out -------------------------------
interface Tick {
  s: string
  p: number
  t: number
  o?: number
  h?: number
  l?: number
  v?: number
  demo?: boolean
}
const latest = new Map<string, Tick>()
setInterval(() => {
  if (latest.size === 0 || io.engine.clientsCount === 0) return
  const batch = [...latest.values()]
  latest.clear()
  io.emit('tick', batch) // array of ticks
}, FLUSH_MS)
function pushTick(t: Tick) {
  latest.set(t.s, t)
}

// ------------------------------ Alpaca upstreams ---------------------------
interface AlpacaKeys {
  keyId: string
  secret: string
}
interface AlpacaConn {
  keys: AlpacaKeys
  ws: WebSocket | null
  sockets: Set<Socket>
  wanted: Set<string> // app symbols
  subscribed: Set<string>
  authed: boolean
  failed: boolean
  failedReason: 'keys' | 'slot' | null
  capped: boolean // symbol cap reached — stop growing subscriptions
  backoff: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
}
const alpacaConns = new Map<string, AlpacaConn>() // keyId → conn

function alpacaConnect(conn: AlpacaConn) {
  if (conn.ws) return
  try {
    const ws = new WebSocket(ALPACA_WS)
    conn.ws = ws
    conn.authed = false
    let opened = false
    ws.onopen = () => {
      opened = true
      conn.backoff = 1000
      ws.send(JSON.stringify({ action: 'auth', keys: [conn.keys.keyId, conn.keys.secret] }))
    }
    ws.onmessage = (ev) => {
      let msgs: Record<string, unknown>[] = []
      try {
        const parsed = JSON.parse(String(ev.data))
        msgs = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        return
      }
      for (const m of msgs) {
        const type = String(m.T ?? '')
        if (type === 'success' && m.msg === 'authenticated') {
          conn.authed = true
          conn.failed = false
          conn.failedReason = null
          conn.capped = false
          slotCooldown.delete(conn.keys.keyId)
          conn.subscribed.clear()
          alpacaSync(conn)
        } else if (type === 't') {
          const sym = String(m.S ?? '')
          const price = Number(m.p)
          if (sym && Number.isFinite(price) && price > 0) {
            pushTick({ s: sym, p: price, t: Math.floor(Date.now() / 1000) })
          }
        } else if (type === 'error') {
          const code = Number(m.code ?? 0)
          console.error(`[alpaca] error ${code}: ${m.msg}`)
          if (code === 401 || code === 402) {
            // bad keys — don't hammer; demo ticks for 10 min
            conn.failed = true
            conn.failedReason = 'keys'
            failedKeys.set(conn.keys.keyId, Date.now())
            try { ws.close() } catch { /* noop */ }
          } else if (code === 403 || code === 406) {
            // Alpaca docs: "Each account is limited to 1 concurrent connection
            // for market data streams. If you try to open more than 1
            // connection at the same time, you may receive a 406 or 403."
            // Another client (or a stale process) holds the slot → do NOT
            // reconnect-spam. Cool down, keep sockets on simulated ticks and
            // retry quietly when the cooldown elapses.
            conn.failed = true
            conn.failedReason = 'slot'
            slotCooldown.set(conn.keys.keyId, Date.now())
            try { ws.close() } catch { /* noop */ }
          } else if (code === 407 || code === 409) {
            // subscription rate/symbol limit (free plan: 30 symbols/conn):
            // keep what already streams; uncovered symbols get demo ticks.
            conn.capped = true
          }
        }
      }
    }
    ws.onclose = () => {
      conn.ws = null
      conn.authed = false
      if (conn.sockets.size === 0) return // nobody needs it anymore
      if (conn.failed) return // don't hammer Alpaca with bad keys
      const wait = conn.backoff
      conn.backoff = Math.min(conn.backoff * 2, 30000)
      conn.reconnectTimer = setTimeout(() => alpacaConnect(conn), wait)
      void opened // silence unused in some bun versions
    }
    ws.onerror = () => {
      try { ws.close() } catch { /* noop */ }
    }
  } catch (e) {
    console.error('[alpaca] connect failed:', e instanceof Error ? e.message : e)
  }
}

function alpacaSync(conn: AlpacaConn) {
  const ws = conn.ws
  if (!ws || ws.readyState !== WebSocket.OPEN || !conn.authed) return
  conn.wanted = new Set()
  for (const sock of conn.sockets) {
    for (const s of socketSyms.get(sock) ?? []) if (!isCrypto(s)) conn.wanted.add(s)
  }
  // respect the per-connection symbol cap (free plan) — extra symbols stay
  // uncovered and the demo simulator keeps them moving instead of erroring
  const cap = conn.capped ? 0 : Math.max(0, ALPACA_SYMBOL_CAP - conn.subscribed.size)
  const add = [...conn.wanted].filter((s) => !conn.subscribed.has(s)).slice(0, cap)
  const rem = [...conn.subscribed].filter((s) => !conn.wanted.has(s))
  if (add.length) {
    ws.send(JSON.stringify({ action: 'listen', trades: add, quotes: add }))
    for (const s of add) conn.subscribed.add(s)
  }
  if (rem.length) {
    ws.send(JSON.stringify({ action: 'unsubscribe', trades: rem, quotes: rem }))
    for (const s of rem) conn.subscribed.delete(s)
  }
}

/** Close an upstream for good (no listeners left / orphaned). */
function teardownConn(conn: AlpacaConn) {
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer)
    conn.reconnectTimer = null
  }
  conn.authed = false
  try { conn.ws?.close() } catch { /* noop */ }
  conn.ws = null
  alpacaConns.delete(conn.keys.keyId)
}

/**
 * Alpaca permits ONE market-data websocket per key: every socket listens
 * through exactly ONE conn. Binding removes the socket from any previous conn
 * and immediately tears that conn down when orphaned (frees the account's
 * connection slot — e.g. right after the user rotates their API keys).
 */
function bindSocketToConn(socket: Socket, conn: AlpacaConn) {
  for (const other of [...alpacaConns.values()]) {
    if (other === conn) continue
    if (other.sockets.delete(socket) && other.sockets.size === 0) teardownConn(other)
  }
  conn.sockets.add(socket)
}

// ------------------------------ Binance upstream ---------------------------
let binanceWs: WebSocket | null = null
let binanceUp = false
let binanceBackoff = 1000
let binanceSubscribed = new Set<string>() // binance pair symbols (BTCUSDT)
let binanceLastMsg = 0
let binanceReconnectTimer: ReturnType<typeof setTimeout> | null = null

/** 'BTC/USD' → 'BTCUSDT' (Binance lists USD pairs as USDT) */
function toBinance(sym: string): string | null {
  const m = /^([A-Z0-9]{2,10})\/([A-Z]{2,6})$/.exec(sym)
  if (!m) return null
  return `${m[1]}${m[2] === 'USD' ? 'USDT' : m[2]}`
}
// reverse map rebuilt whenever the crypto desired set changes
const binanceReverse = new Map<string, string>() // BTCUSDT → BTC/USD

function binanceConnect() {
  if (binanceWs) return
  try {
    const ws = new WebSocket(BINANCE_WS)
    binanceWs = ws
    ws.onopen = () => {
      binanceUp = true
      binanceBackoff = 1000
      binanceLastMsg = Date.now()
      binanceSubscribed.clear()
      binanceSync(true)
    }
    ws.onmessage = (ev) => {
      binanceLastMsg = Date.now()
      let m: Record<string, unknown> | null = null
      try {
        m = JSON.parse(String(ev.data)) as Record<string, unknown>
      } catch {
        return
      }
      if (!m || m.e !== '24hrMiniTicker') return // subscribe acks etc.
      const pair = String(m.s ?? '')
      const sym = binanceReverse.get(pair)
      const price = Number.parseFloat(String(m.c ?? ''))
      if (!sym || !Number.isFinite(price) || price <= 0) return
      pushTick({
        s: sym,
        p: price,
        t: Math.floor(Number(m.E ?? Date.now()) / 1000),
        o: Number.parseFloat(String(m.o ?? '')) || undefined,
        h: Number.parseFloat(String(m.h ?? '')) || undefined,
        l: Number.parseFloat(String(m.l ?? '')) || undefined,
        v: Number.parseFloat(String(m.v ?? '')) || undefined,
      })
    }
    ws.onclose = () => {
      binanceWs = null
      binanceUp = false
      if (refcounts.size === 0) return
      const wait = binanceBackoff
      binanceBackoff = Math.min(binanceBackoff * 2, 30000)
      binanceReconnectTimer = setTimeout(binanceConnect, wait)
    }
    ws.onerror = () => {
      try { ws.close() } catch { /* noop */ }
    }
  } catch (e) {
    console.error('[binance] connect failed:', e instanceof Error ? e.message : e)
    binanceUp = false
    const wait = binanceBackoff
    binanceBackoff = Math.min(binanceBackoff * 2, 30000)
    if (!binanceReconnectTimer) binanceReconnectTimer = setTimeout(binanceConnect, wait)
  }
}

function binanceSync(full = false) {
  const wantedPairs = new Set<string>()
  binanceReverse.clear()
  for (const s of desiredCrypto()) {
    const p = toBinance(s)
    if (p) {
      wantedPairs.add(p)
      binanceReverse.set(p, s)
    }
  }
  const ws = binanceWs
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const add = [...wantedPairs].filter((p) => full || !binanceSubscribed.has(p))
  const rem = full ? [] : [...binanceSubscribed].filter((p) => !wantedPairs.has(p))
  if (add.length) {
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: add.map((p) => `${p.toLowerCase()}@miniTicker`), id: Date.now() % 1e9 }))
    for (const p of add) binanceSubscribed.add(p)
  }
  if (rem.length) {
    ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: rem.map((p) => `${p.toLowerCase()}@miniTicker`), id: Date.now() % 1e9 }))
    for (const p of rem) binanceSubscribed.delete(p)
  }
}

// watchdog: Binance closes idle conns — if no message for 90s while streams
// are actually subscribed, force reconnect (an open conn with ZERO subscribed
// pairs is legitimately silent and must NOT trigger reconnect churn)
setInterval(() => {
  if (
    binanceWs &&
    binanceUp &&
    binanceSubscribed.size > 0 &&
    Date.now() - binanceLastMsg > 90_000
  ) {
    console.warn('[binance] watchdog: no messages for 90s — reconnecting')
    try { binanceWs.close() } catch { /* noop */ }
  }
}, 30000)

// ------------------------------ demo simulator -----------------------------
const demoState = new Map<string, { p: number; anchor: number }>()
const anchorsFetched = new Set<string>()

function gauss(): number {
  const u = Math.max(Math.random(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random())
}

async function fetchAnchors(syms: string[]) {
  const need = syms.filter((s) => !anchorsFetched.has(s))
  if (need.length === 0) return
  for (let i = 0; i < need.length; i += 25) {
    const chunk = need.slice(i, i + 25)
    try {
      const res = await fetch(`${NEXT_BASE}/api/market/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols: chunk }),
        signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
      })
      if (!res.ok) continue
      const json = (await res.json()) as { quotes?: { symbol: string; price: number }[] }
      for (const q of json.quotes ?? []) {
        if (Number.isFinite(q.price) && q.price > 0) {
          demoState.set(q.symbol, { p: q.price, anchor: q.price })
          anchorsFetched.add(q.symbol)
        }
      }
    } catch { /* offline — anchor defaults below */ }
  }
}

// which symbols need simulated ticks (no live upstream covering them).
// Coverage is PER SYMBOL: an authed-but-capped conn leaves its extra symbols
// to the demo simulator instead of leaving them frozen.
function symbolsNeedingDemo(): string[] {
  const out: string[] = []
  const covered = new Set<string>()
  for (const c of alpacaConns.values()) {
    if (c.authed && !c.failed && c.ws?.readyState === WebSocket.OPEN) {
      for (const s of c.subscribed) covered.add(s)
    }
  }
  for (const s of desiredStocks()) if (!covered.has(s)) out.push(s)
  if (!binanceUp) out.push(...desiredCrypto())
  return out
}

setInterval(async () => {
  const syms = symbolsNeedingDemo()
  if (syms.length > 0) void fetchAnchors(syms)
  for (const s of syms) {
    let st = demoState.get(s)
    if (!st) {
      st = { p: 100, anchor: 100 }
      demoState.set(s, st)
    }
    const vol = st.p * 0.0006
    st.p = Math.max(st.p + gauss() * vol + (st.anchor - st.p) * 0.02, 0.0001)
    pushTick({ s, p: st.p, t: Math.floor(Date.now() / 1000), demo: true })
  }
}, DEMO_TICK_MS)

// refresh demo anchors periodically so simulated walks stay near reality
setInterval(() => anchorsFetched.clear(), 5 * 60 * 1000)

// ------------------------------ key resolution -----------------------------
const keyCache = new Map<string, { keys: AlpacaKeys | null; at: number }>()
async function keysForCookie(cookieHeader: string | undefined): Promise<AlpacaKeys | null> {
  const cacheKey = cookieHeader ?? ''
  const hit = keyCache.get(cacheKey)
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.keys
  let keys: AlpacaKeys | null = null
  try {
    const res = await fetch(`${NEXT_BASE}/api/stream/keys`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    })
    if (res.ok) {
      const j = (await res.json()) as { keyId?: string; secret?: string }
      if (j.keyId && j.secret) keys = { keyId: j.keyId, secret: j.secret }
    }
  } catch { /* offline → demo */ }
  keyCache.set(cacheKey, { keys, at: Date.now() })
  if (keyCache.size > 500) {
    const now = Date.now()
    for (const [k, v] of keyCache) if (now - v.at > KEY_CACHE_MS) keyCache.delete(k)
  }
  return keys
}

// --------------------------------- wiring ----------------------------------
io.on('connection', (socket: Socket) => {
  const cookieHeader = socket.handshake.headers.cookie

  // Register ALL handlers SYNCHRONOUSLY first: the client emits 'sub' right on
  // connect, and awaiting the keys fetch before registering used to DROP that
  // first emit (stream stayed dead until the next reconnect).
  socket.on('sub', (payload: { symbols?: string[] }) => {
    const syms = (payload?.symbols ?? []).filter((s) => typeof s === 'string' && s.length > 0)
    if (syms.length === 0) return
    let set = socketSyms.get(socket)
    if (!set) {
      set = new Set()
      socketSyms.set(socket, set)
    }
    console.log('[sub]', socket.id, syms.join(','))
    acquire(syms)
    for (const s of syms) set.add(s)

    // crypto → shared binance upstream
    if (syms.some(isCrypto)) {
      if (!binanceWs) binanceConnect()
      else binanceSync()
    }
    // stocks → the socket's bound alpaca upstream (if any), else demo ticks
    if (syms.some((s) => !isCrypto(s))) {
      const conn = [...alpacaConns.values()].find((c) => c.sockets.has(socket))
      if (conn) alpacaSync(conn)
    }
  })

  socket.on('unsub', (payload: { symbols?: string[] }) => {
    const syms = (payload?.symbols ?? []).filter((s) => typeof s === 'string' && s.length > 0)
    if (syms.length === 0) return
    const set = socketSyms.get(socket)
    if (set) for (const s of syms) set.delete(s)
    release(syms)
    binanceSync()
    for (const conn of alpacaConns.values()) {
      if (conn.sockets.has(socket)) alpacaSync(conn)
    }
  })

  socket.on('disconnect', () => {
    const set = socketSyms.get(socket)
    if (set) {
      release([...set])
      socketSyms.delete(socket)
    }
    for (const conn of [...alpacaConns.values()]) {
      conn.sockets.delete(socket)
      if (conn.sockets.size === 0) {
        // nobody bound → tear the upstream down (frees Alpaca's single
        // connection slot for this account immediately)
        teardownConn(conn)
      } else alpacaSync(conn)
    }
    if (refcounts.size === 0 && binanceWs) {
      try { binanceWs.close() } catch { /* noop */ }
      binanceWs = null
      binanceUp = false
    }
  })

  // keys resolve asynchronously — bind the socket to its (single) Alpaca
  // upstream when they arrive (until then its stock symbols get demo ticks)
  void keysForCookie(cookieHeader).then((keys) => {
    console.log('[conn]', socket.id, 'keys:', Boolean(keys))
    if (!keys || keysFailedRecently(keys)) return
    if (slotFailedRecently(keys)) {
      console.log('[alpaca] connection slot busy for these keys — socket stays on simulated ticks for now')
      return
    }
    const conn = getOrCreateAlpacaConn(keys)
    bindSocketToConn(socket, conn)
    alpacaConnect(conn)
    alpacaSync(conn)
  })
})

const failedKeys = new Map<string, number>()
function keysFailedRecently(keys: AlpacaKeys): boolean {
  const at = failedKeys.get(keys.keyId)
  return at != null && Date.now() - at < 10 * 60 * 1000
}

// 406/403 — another client holds Alpaca's single market-data connection slot.
// Cool down instead of reconnect-spamming; retried automatically below.
const slotCooldown = new Map<string, number>()
function slotFailedRecently(keys: AlpacaKeys): boolean {
  const at = slotCooldown.get(keys.keyId)
  return at != null && Date.now() - at < SLOT_COOLDOWN_MS
}

// Safety net: never keep an upstream Alpaca websocket with no listeners
// (e.g. a socket rebound to new keys would otherwise orphan the old conn and
// eat the account's only connection slot).
setInterval(() => {
  for (const conn of [...alpacaConns.values()]) {
    if (conn.sockets.size === 0) teardownConn(conn)
  }
}, 30_000)

// A busy connection slot usually frees when the other client disconnects —
// retry quietly after the cooldown without waiting for a fresh page load.
setInterval(() => {
  for (const conn of [...alpacaConns.values()]) {
    if (
      conn.failed &&
      conn.failedReason === 'slot' &&
      conn.sockets.size > 0 &&
      Date.now() - (slotCooldown.get(conn.keys.keyId) ?? 0) >= SLOT_COOLDOWN_MS
    ) {
      console.log('[alpaca] connection-slot cooldown elapsed — retrying')
      conn.failed = false
      conn.failedReason = null
      conn.backoff = 1000
      alpacaConnect(conn)
    }
  }
}, 60_000)

function getOrCreateAlpacaConn(keys: AlpacaKeys): AlpacaConn {
  let conn = alpacaConns.get(keys.keyId)
  if (!conn) {
    conn = {
      keys,
      ws: null,
      sockets: new Set(),
      wanted: new Set(),
      subscribed: new Set(),
      authed: false,
      failed: false,
      failedReason: null,
      capped: false,
      backoff: 1000,
      reconnectTimer: null,
    }
    alpacaConns.set(keys.keyId, conn)
  }
  return conn
}

httpServer.listen(PORT, () => {
  console.log(`stream-service listening on :${PORT} (socket.io path '/')`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
