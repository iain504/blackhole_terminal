// stream-service — real-time price streaming for the trading terminal.
//
// Browser ──socket.io (path '/socket.io', port 3030, via Caddy ?XTransformPort=3030)──▶ this service
//   ├─ CRYPTO: one shared Binance websocket (free, keyless) → 24h miniTicker ≈ 1 tick/s/symbol
//   ├─ STOCKS: EXACTLY ONE Alpaca v2 iex websocket per account (Alpaca allows ONE concurrent
//   │          market-data connection per key — a 2nd gets error 406/403 "connection limit
//   │          exceeded"; the free plan also caps 30 subscribed symbols per websocket).
//   │          All browser tabs/panes/watchlists multiplex over that single connection.
//   │          Keys are resolved server-side from the user's session cookie via Next
//   │          /api/stream/keys — the browser NEVER sees keys.
//   └─ NO SIM: symbols without a live upstream (no keys / auth failed / slot busy /
//              over the 30-symbol cap / binance down) simply DO NOT stream — the
//              simulated-tick generator was permanently removed (a trading terminal
//              must never fabricate prices); REST polling remains the fallback.
//   ▶ 'sub'   { symbols: string[] }    subscribe (refcounted)
//   ▶ 'unsub' { symbols: string[] }
//   ◀ 'tick'  { s, p, t, o?, h?, l?, v? }   throttled ≤ 5 msgs/s per symbol
//
// HANDSHAKE AUTH (Task 3-b): every socket handshake is verified against the app's
// HMAC session cookie (tt_session — token `userId.expiry.HMAC-SHA256(payload)`,
// mirrors src/lib/auth.ts byte-for-byte, including its AUTH_SECRET resolution:
// env → repo-root .env → hardcoded default). VALID session → full behavior.
// INVALID/absent → RESTRICTED GUEST MODE: crypto (public Binance) subs only,
// ≤10 simultaneous symbols, ≤20 sub/unsub events per minute; stock subs are
// ignored, no Alpaca keys are ever resolved, and stock ticks are not even
// fanned out to guest sockets. CORS is `origin: true, credentials: true`
// (same-origin via the gateway) — defense in depth on top of the handshake auth.
// GET /healthz on the same port returns {"ok":true} for uptime probes.
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { Server, Socket } from 'socket.io'

const PORT = 3030
const NEXT_BASE = 'http://localhost:3000'
const BINANCE_WS = 'wss://stream.binance.com:9443/ws'
const ALPACA_WS = 'wss://stream.data.alpaca.markets/v2/iex'
const FLUSH_MS = 200 // per-symbol emit throttle → ≤5 msgs/s
const KEY_CACHE_MS = 60_000
const QUOTE_TIMEOUT_MS = 4000
// Alpaca market data: ONE concurrent websocket per key (2nd → error 406/403)
// and the free/IEX plan caps 30 subscribed symbols per connection.
const ALPACA_SYMBOL_CAP = 30
const SLOT_COOLDOWN_MS = 2 * 60_000

// guest-mode limits (Task 3-b) — public crypto only, small blast radius
const GUEST_MAX_SYMBOLS = 10 // simultaneous subscribed symbols per guest socket
const GUEST_MAX_EVENTS = 20 // sub+unsub events per rolling minute per guest socket
const GUEST_EVENT_WINDOW_MS = 60_000

const isCrypto = (s: string) => s.includes('/')

// ------------------------- ops: rescue + restart (9-p) ----------------------
// The sidecar OUTLIVES the Next dev server: it is a separate, tiny process.
// That makes it the natural rescue channel — when the main server dies (OOM
// during a heavy backtest), this service can still (a) serve a recovery page
// and (b) restart the dev server on behalf of a logged-in user.
const SVC_DIR = (import.meta as { dir?: string }).dir ?? process.cwd()
const PROJECT_ROOT = join(SVC_DIR, '..', '..')
const NEXT_HEALTH_URL = 'http://127.0.0.1:3000/api/health'

async function probeNext(): Promise<'up' | 'down'> {
  try {
    // ANY http answer (even a 503 degraded health) means the process lives
    await fetch(NEXT_HEALTH_URL, { signal: AbortSignal.timeout(3000), cache: 'no-store' })
    return 'up'
  } catch {
    return 'down'
  }
}

let lastRestartAt = 0
function requestNextRestart(): { started: boolean; reason?: string } {
  const now = Date.now()
  if (now - lastRestartAt < 20_000) return { started: false, reason: 'recent' }
  lastRestartAt = now
  try {
    const child = spawn('bash', [join(PROJECT_ROOT, 'scripts-tmp', 'restart-next.sh')], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', (e) => console.error('[ops] restart spawn failed:', e instanceof Error ? e.message : e))
    child.unref()
    console.log('[ops] dev-server restart requested via /ops/restart-next')
    return { started: true }
  } catch (e) {
    console.error('[ops] restart failed:', e instanceof Error ? e.message : e)
    return { started: false, reason: 'spawn' }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Minimal dark rescue page — served for ANY browser GET that is not an API
 *  path. Reachable at /?XTransformPort=3030 through the gateway (and directly
 *  on :3030), i.e. even when the main server is completely dead. */
function rescuePageHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BLACKHOLE Terminal — Rescue</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
  .card{width:min(92vw,460px);background:#111113;border:1px solid #27272a;border-radius:14px;padding:28px 26px;box-shadow:0 10px 40px #0008}
  h1{font-size:19px;margin:0 0 6px;letter-spacing:.3px}
  p{margin:8px 0;color:#a1a1aa}
  #st{font-weight:600;color:#e4e4e7;min-height:24px}
  #st.down{color:#f87171}#st.up{color:#4ade80}#st.busy{color:#facc15}
  button{margin-top:14px;width:100%;padding:12px 16px;font-size:15px;font-weight:600;border-radius:10px;border:1px solid #3f3f46;background:#fafafa;color:#111113;cursor:pointer}
  button:disabled{opacity:.45;cursor:not-allowed}
  button:not(:disabled):hover{background:#fff}
  .hint{font-size:12.5px;color:#71717a;border-top:1px solid #27272a;margin-top:18px;padding-top:12px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f87171;margin-right:6px}
</style></head><body>
<div class="card">
  <h1><span class="dot"></span>BLACKHOLE Terminal — Rescue</h1>
  <p>The terminal server is not responding. This rescue page is served by the<br/>streaming sidecar, which stays alive when the main server dies.</p>
  <p id="st">Checking terminal server…</p>
  <button id="btn" disabled>Restart terminal server</button>
  <p class="hint">The auto-watchdog usually revives the server within a minute on its own — this button does the same thing on demand. If this page itself is unreachable, a full redeploy (Publish) is the only option left.</p>
</div>
<script>
(() => {
  const Q = '?XTransformPort=3030'
  const st = document.getElementById('st'), btn = document.getElementById('btn')
  let restarting = false
  const say = (t, c) => { st.textContent = t; st.className = c || '' }
  async function poll() {
    if (restarting) return
    try {
      const r = await fetch('/ops/status' + Q, { cache: 'no-store' })
      const j = await r.json()
      if (j.next === 'up') {
        say('Terminal server is UP — taking you back…', 'up')
        btn.disabled = true
        setTimeout(() => { location.href = '/' }, 1200)
      } else {
        say('Terminal server is DOWN.', 'down')
        btn.disabled = false
      }
    } catch {
      say('Rescue service unreachable — a full redeploy (Publish) is required.', 'down')
      btn.disabled = true
    }
  }
  btn.addEventListener('click', async () => {
    restarting = true; btn.disabled = true; say('Restarting… wait up to ~40s', 'busy')
    try { await fetch('/ops/restart-next' + Q, { method: 'POST' }) } catch {}
    let waited = 0
    const t = setInterval(async () => {
      waited += 3000
      try {
        const r = await fetch('/ops/status' + Q, { cache: 'no-store' })
        const j = await r.json()
        if (j.next === 'up') {
          clearInterval(t); say('Terminal server is UP — taking you back…', 'up')
          setTimeout(() => { location.href = '/' }, 1200)
        } else if (waited > 120000) {
          clearInterval(t); restarting = false; say('Still down after 2 minutes — try again or redeploy.', 'down')
        }
      } catch {}
    }, 3000)
  })
  setInterval(poll, 3000); poll()
})()
</script></body></html>`
}

// --------------------------- session verification --------------------------
// Mirrors src/lib/auth.ts EXACTLY (same cookie name, same token format
// `userId.expiry.HMAC-SHA256(payload)`, same secret resolution chain) so a
// cookie accepted by the Next app is accepted here and nothing else is.
const SESSION_COOKIE = 'tt_session'

// Task 9-p — secret resolution mirrors src/lib/app-secret.ts EXACTLY:
//   env (APP_ENCRYPTION_SECRET || AUTH_SECRET) wins → else the AppSecret DB
//   row (key 'master') the app generated at boot → else fail-closed.
// Getting this wrong is not theoretical: when the app-side chain gained
// APP_ENCRYPTION_SECRET while this sidecar kept reading AUTH_SECRET only,
// EVERY genuine session verified as a guest here (crypto streams masked it —
// guests get those too; stock streaming + /ops/restart-next silently 403'd).
function envFromDotEnv(name: string): string | null {
  try {
    const svcDir = (import.meta as { dir?: string }).dir ?? process.cwd()
    const envText = readFileSync(join(svcDir, '..', '..', '.env'), 'utf8')
    for (const line of envText.split(/\r?\n/)) {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`).exec(line)
      if (m?.[1]) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* no repo-root .env */
  }
  return null
}

/** Last resort — read the app's boot-generated master from SQLite (bun:sqlite,
 *  readonly). Only reached when neither secret env var exists anywhere. */
function appSecretFromDb(): string | null {
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require
    if (!req) return null
    const { Database } = req('bun:sqlite') as {
      Database: new (path: string, opts?: { readonly?: boolean }) => {
        query: (sql: string) => { get: () => Record<string, unknown> | undefined }
        close: () => void
      }
    }
    const dbUrl = process.env.DATABASE_URL || envFromDotEnv('DATABASE_URL') || 'file:./db/custom.db'
    const dbPath = dbUrl.replace(/^file:/, '')
    const db = new Database(dbPath, { readonly: true })
    const row = db.query("SELECT value FROM AppSecret WHERE key = 'master'").get()
    db.close()
    return row && typeof row.value === 'string' ? row.value : null
  } catch {
    return null
  }
}

let AUTH_SECRET =
  process.env.APP_ENCRYPTION_SECRET ||
  process.env.AUTH_SECRET ||
  envFromDotEnv('APP_ENCRYPTION_SECRET') ||
  envFromDotEnv('AUTH_SECRET') ||
  appSecretFromDb() ||
  ''
if (!AUTH_SECRET) {
  // Fail-closed, mirroring src/lib/auth.ts: never accept tokens signed with a
  // publicly-known default. Without a real secret the service cannot tell a
  // genuine session from a forged one, so it refuses to start.
  console.error('[stream-service] FATAL: no session secret found (env / .env / AppSecret DB) — refusing to start (forged-session guard).')
  process.exit(1)
}

function verifySessionToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [userId, expStr, sig] = parts
  const payload = `${userId}.${expStr}`
  const expected = createHmac('sha256', AUTH_SECRET).update(payload).digest('hex')
  if (sig.length !== expected.length) return null
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch {
    return null
  }
  if (parseInt(expStr, 10) * 1000 < Date.now()) return null
  return userId
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

// ------------------------------- socket.io ---------------------------------
// DO NOT change this path back to '/' — engine.io matches requests by path
// prefix and '/' would swallow EVERY http request on this port (including
// /healthz). The browser client (src/lib/stream-client.ts) uses socket.io's
// default path '/socket.io' — only the ?XTransformPort=3030 QUERY decides the
// Caddy route, so '/socket.io' reaches this service through the gateway
// exactly as before.
const AUTHED_ROOM = 'authed'
const httpServer = createServer((req, res) => {
  void handleHttp(req, res)
})

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0]
  try {
    // lightweight health probe on the same port (socket.io owns '/socket.io')
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true })
      return
    }
    // Task 9-p — rescue status: is the main server alive? (no session needed,
    // no sensitive data — a boolean every visitor may see)
    if (path === '/ops/status') {
      const next = await probeNext()
      sendJson(res, 200, { stream: 'up', next, ts: Date.now() })
      return
    }
    // Task 9-p — browser-triggered restart. A VALID session is required (the
    // same HMAC cookie the app issues); guests get 403. Fire-and-forget: the
    // restart script respawns the dev server detached, the page polls /ops/status.
    if (path === '/ops/restart-next') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' })
        return
      }
      const token = cookieValue(req.headers.cookie, SESSION_COOKIE)
      const userId = token ? verifySessionToken(token) : null
      if (!userId) {
        sendJson(res, 403, { error: 'a valid session is required to restart the server' })
        return
      }
      const r = requestNextRestart()
      sendJson(res, r.started ? 202 : 429, r)
      return
    }
    // Task 9-p — recovery page for browser navigation (any path): this is how
    // a dead server is restarted THROUGH THE BROWSER even when Next is gone.
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(rescuePageHtml())
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    try { sendJson(res, 500, { error: 'internal' }) } catch { /* socket gone */ }
    console.error('[http]', path, e instanceof Error ? e.message : e)
  }
}
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: { origin: true, credentials: true, methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// handshake auth: classify every socket as a full user or a restricted guest.
// NEVER rejects the handshake — anonymous visitors still get public crypto
// ticks (guest mode), everything else is gated in the event handlers below.
io.use((socket: Socket, next: (err?: Error) => void) => {
  const token = cookieValue(socket.handshake.headers.cookie, SESSION_COOKIE)
  const userId = token ? verifySessionToken(token) : null
  socket.data.authed = userId != null
  socket.data.userId = userId
  if (userId != null) socket.join(AUTHED_ROOM)
  next()
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

// --------------------------- guest rate limiting ----------------------------
// rolling 60s window of sub/unsub events, per guest socket, in memory
const guestEvents = new Map<Socket, number[]>()
function guestEventAllowed(socket: Socket): boolean {
  const now = Date.now()
  const recent = (guestEvents.get(socket) ?? []).filter((t) => now - t < GUEST_EVENT_WINDOW_MS)
  if (recent.length >= GUEST_MAX_EVENTS) {
    guestEvents.set(socket, recent)
    return false
  }
  recent.push(now)
  guestEvents.set(socket, recent)
  return true
}

// ------------------------------ tick fan-out -------------------------------
interface Tick {
  s: string
  p: number
  t: number
  o?: number
  h?: number
  l?: number
  v?: number
}
const latest = new Map<string, Tick>()
setInterval(() => {
  if (latest.size === 0 || io.engine.clientsCount === 0) return
  const batch = [...latest.values()]
  latest.clear()
  // guests (and sockets generally) may only receive public Binance crypto
  // ticks globally; stock ticks (other users' Alpaca upstreams) go to the
  // authed room only so a guest never receives them at all
  const cryptoTicks = batch.filter((t) => isCrypto(t.s))
  const stockTicks = batch.filter((t) => !isCrypto(t.s))
  if (cryptoTicks.length) io.emit('tick', cryptoTicks) // array of ticks
  if (stockTicks.length) io.to(AUTHED_ROOM).emit('tick', stockTicks)
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
            // bad keys — don't hammer; retry after the 10-min cooldown
            conn.failed = true
            conn.failedReason = 'keys'
            failedKeys.set(conn.keys.keyId, Date.now())
            try { ws.close() } catch { /* noop */ }
          } else if (code === 403 || code === 406) {
            // Alpaca docs: "Each account is limited to 1 concurrent connection
            // for market data streams. If you try to open more than 1
            // connection at the same time, you may receive a 406 or 403."
            // Another client (or a stale process) holds the slot → do NOT
            // reconnect-spam. Cool down and retry quietly when it elapses.
            conn.failed = true
            conn.failedReason = 'slot'
            slotCooldown.set(conn.keys.keyId, Date.now())
            try { ws.close() } catch { /* noop */ }
          } else if (code === 407 || code === 409) {
            // subscription rate/symbol limit (free plan: 30 symbols/conn):
            // keep what already streams; uncovered symbols stay quiet
            // (REST polling covers them — never simulate).
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
  // uncovered and simply do not stream (REST polling covers them)
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

// NOTE: the simulated-tick ("SIM") generator was PERMANENTLY REMOVED by user
// request — this service only ever forwards REAL ticks from Binance/Alpaca.
// Symbols without live upstream coverage simply produce no ticks; the client
// falls back to its REST polling.

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
  } catch { /* offline */ }
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
  const authed = socket.data.authed === true

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

    if (!authed) {
      // ---- GUEST MODE: public crypto channels only, hard limits ----
      if (!guestEventAllowed(socket)) {
        console.log('[guest] rate-limited sub', socket.id, `(${syms.length} sym(s) dropped)`)
        return
      }
      const cryptoSyms = [...new Set(syms.filter(isCrypto))]
      const fresh = cryptoSyms.filter((s) => !set.has(s))
      const room = Math.max(0, GUEST_MAX_SYMBOLS - set.size)
      const accepted = fresh.slice(0, room)
      const dropped = syms.length - accepted.length
      if (dropped > 0) {
        console.log('[guest] rejected sub', socket.id, `${dropped} sym(s) (stocks and/or >${GUEST_MAX_SYMBOLS}-symbol cap)`)
      }
      if (accepted.length === 0) return
      console.log('[guest] sub', socket.id, accepted.join(','))
      acquire(accepted)
      for (const s of accepted) set.add(s)
      if (!binanceWs) binanceConnect()
      else binanceSync()
      return
    }

    console.log('[sub]', socket.id, syms.join(','))
    acquire(syms)
    for (const s of syms) set.add(s)

    // crypto → shared binance upstream
    if (syms.some(isCrypto)) {
      if (!binanceWs) binanceConnect()
      else binanceSync()
    }
    // stocks → the socket's bound alpaca upstream (if any); without one the
    // symbols stay quiet (client-side REST polling is the fallback)
    if (syms.some((s) => !isCrypto(s))) {
      const conn = [...alpacaConns.values()].find((c) => c.sockets.has(socket))
      if (conn) alpacaSync(conn)
    }
  })

  socket.on('unsub', (payload: { symbols?: string[] }) => {
    const syms = (payload?.symbols ?? []).filter((s) => typeof s === 'string' && s.length > 0)
    if (syms.length === 0) return
    const set = socketSyms.get(socket)

    if (!authed) {
      // ---- GUEST MODE: rate-limited; may only release its OWN symbols
      // (never the shared refcounts of other sockets' subscriptions) ----
      if (!guestEventAllowed(socket)) {
        console.log('[guest] rate-limited unsub', socket.id)
        return
      }
      if (!set || set.size === 0) return
      const owned = syms.filter((s) => set.has(s))
      if (owned.length === 0) return
      for (const s of owned) set.delete(s)
      release(owned)
      binanceSync()
      return
    }

    if (set) for (const s of syms) set.delete(s)
    release(syms)
    binanceSync()
    for (const conn of alpacaConns.values()) {
      if (conn.sockets.has(socket)) alpacaSync(conn)
    }
  })

  socket.on('disconnect', () => {
    guestEvents.delete(socket)
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

  if (!authed) {
    // guests never resolve Alpaca keys — they only ever get public Binance
    // ticks (no /api/stream/keys call is made on their behalf)
    console.log('[conn]', socket.id, 'guest (no valid session)')
    return
  }

  // keys resolve asynchronously — bind the socket to its (single) Alpaca
  // upstream when they arrive (until then its stock symbols do not stream)
  void keysForCookie(cookieHeader).then((keys) => {
    console.log('[conn]', socket.id, 'keys:', Boolean(keys))
    if (!keys || keysFailedRecently(keys)) return
    if (slotFailedRecently(keys)) {
      console.log('[alpaca] connection slot busy for these keys — no stock upstream for now')
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
  console.log(
    `stream-service listening on :${PORT} (socket.io path '/socket.io', handshake auth: ` +
      `${process.env.AUTH_SECRET ? 'env' : 'default/dev'} secret, guests: crypto-only ≤${GUEST_MAX_SYMBOLS} syms, ≤${GUEST_MAX_EVENTS} ev/min)`,
  )
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
