// GET /api/health (Task 3-c) — unauthenticated liveness/readiness probe for
// uptime monitors and process managers. Reports ONLY non-sensitive values
// (no user data, no keys, no counts beyond engine/cache aggregates).
//
// Response 200 { status:'ok' }      — DB reachable
// Response 503 { status:'degraded' } — DB unreachable / timed out
//
// A 5s in-process cache keeps external probes (which may fire every second)
// from hammering SQLite. Sub-checks are individually guarded so one broken
// dependency never hides the rest of the report.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { APP_VERSION } from '@/generated/version'

const CACHE_TTL_MS = 5000
const DB_TIMEOUT_MS = 2000
const STREAM_TIMEOUT_MS = 1500
// Where the socket.io stream mini-service listens (Caddy pins the
// XTransformPort loopback proxy to this port). Another agent is adding the
// /healthz route there; until it exists we report 404 → 'down'.
const STREAM_HEALTH_URL = 'http://127.0.0.1:3030/healthz'

interface HealthPayload {
  status: 'ok' | 'degraded'
  uptimeSec: number
  memoryMB: number
  db: boolean
  algoRuns: number | null
  recoAgeMin: number | null
  stream: 'up' | 'down' | 'unknown'
  version: string
}

let cache: { at: number; payload: HealthPayload; httpStatus: number } | null = null
let inFlight: Promise<{ payload: HealthPayload; httpStatus: number }> | null = null

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** DB reachable? (2s budget — a wedged Prisma/SQLite must not hang the probe) */
async function checkDb(): Promise<boolean> {
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, DB_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

/** Is the stream mini-service's health endpoint answering? */
async function checkStream(): Promise<'up' | 'down' | 'unknown'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
  try {
    const res = await fetch(STREAM_HEALTH_URL, { signal: controller.signal, cache: 'no-store' })
    // 404 → service is up but the /healthz route is not added yet → 'down';
    // any other non-ok status also means the health check itself fails.
    return res.ok ? 'up' : 'down'
  } catch {
    // Connection refused / abort / DNS — we cannot tell service state
    // reliably → 'unknown' (never fabricate an 'up').
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

async function compute(): Promise<{ payload: HealthPayload; httpStatus: number }> {
  const dbOk = await checkDb()

  // Dependent aggregates — only meaningful (and only cheap) when the DB is up.
  let algoRuns: number | null = null
  let recoAgeMin: number | null = null
  if (dbOk) {
    try {
      algoRuns = await db.algoRun.count({ where: { status: 'running' } })
    } catch {
      algoRuns = null
    }
    try {
      const reco = await db.algoRecoCache.findFirst({ select: { updatedAt: true } })
      recoAgeMin = reco
        ? Math.max(0, Math.round((Date.now() - reco.updatedAt.getTime()) / 60000))
        : null
    } catch {
      recoAgeMin = null
    }
  }

  const payload: HealthPayload = {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    db: dbOk,
    algoRuns,
    recoAgeMin,
    stream: await checkStream(),
    version: APP_VERSION.display,
  }
  return { payload, httpStatus: dbOk ? 200 : 503 }
}

export async function GET() {
  // Serve the cached report while it is fresh; dedupe concurrent probes onto
  // one computation instead of stampeding the DB.
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json(cache.payload, { status: cache.httpStatus })
    }
    if (!inFlight) {
      inFlight = compute()
        .then((r) => {
          cache = { at: Date.now(), ...r }
          return r
        })
        .finally(() => {
          inFlight = null
        })
    }
    const { payload, httpStatus } = await inFlight
    return NextResponse.json(payload, { status: httpStatus })
  } catch (e) {
    // The probe itself must never 500 unstructured — degrade instead.
    console.warn('[health] probe failed:', e instanceof Error ? e.message : e)
    const payload: HealthPayload = {
      status: 'degraded',
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      db: false,
      algoRuns: null,
      recoAgeMin: null,
      stream: 'unknown',
      version: APP_VERSION.display,
    }
    return NextResponse.json(payload, { status: 503 })
  }
}
