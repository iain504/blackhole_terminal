import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/crypt'
import { TIMEFRAMES } from '@/lib/market-types'

// ---------------------------------------------------------------------------
// Config backup — export / import the user's ENTIRE terminal configuration as
// ONE JSON file: layout (tabs/grid/sidebar), watchlists, alarms, strategy bot
// rules, chart drawings, calendar alarms, private credentials (Alpaca keys /
// Telegram token, decrypted to PLAINTEXT in the export — the user is warned in
// the UI) and trading defaults. Indicator settings live client-side
// (localStorage) and are merged into the file by the client on export, and
// written back to localStorage by the client on import.
//
// Import semantics: REPLACE per section present in the file. A section that is
// absent from the file is left untouched (partial backups are safe). Runtime
// state (crossing memory, triggered-at, broker order ids) is never exported —
// alarms re-arm fresh on import so they fire on the NEXT crossing. Strategy
// Orders keep their ARM STATE (Task 79): armed stays armed, paused stays
// paused, and rules caught mid-fire/failed (placing/triggered/failed) import
// PAUSED for review instead of surprise-firing again on the next crossing.
// ---------------------------------------------------------------------------

const FILE_KIND = 'blackhole-terminal-config'
const FILE_VERSION = 1

const VALID_TFS = Object.keys(TIMEFRAMES) as string[]
const ALERT_KINDS = ['price', 'rsi', 'macd', 'trend']
const STRAT_CONDITIONS = ['cross_above', 'cross_below', 'bull_cross', 'bear_cross']

interface UserSettings {
  alpacaKeyIdEnc?: string
  alpacaSecretEnc?: string
  // Task 37 — dual key pairs ride config export/import too
  alpacaPaperKeyIdEnc?: string
  alpacaPaperSecretEnc?: string
  alpacaLiveKeyIdEnc?: string
  alpacaLiveSecretEnc?: string
  telegramTokenEnc?: string
  telegramChatId?: string
  notifyFills?: boolean
  notifyCloses?: boolean
  tradeMode?: string
  tpslPercent?: number
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}
const validTf = (tf: unknown): string => (typeof tf === 'string' && VALID_TFS.includes(tf) ? tf : '1D')
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

// ---- GET: assemble the export file ----
export async function GET() {
  try {
    const user = await requireUser()
    // Task 89 — this export ships DECRYPTED broker keys + Telegram token, so
    // it is rate-limited like the sensitive surface it is (the session cookie
    // alone used to be able to harvest them in a loop).
    const rl = await rateLimit(`export:${user.id}`, 5, 60_000)
    if (!rl.ok) {
      return NextResponse.json({ error: `Too many export requests — retry in ${rl.retryAfterSec}s` }, { status: 429 })
    }
    const dbUser = await db.user.findUnique({ where: { id: user.id } })
    const s = ((dbUser?.settings as UserSettings | null) || {}) as UserSettings

    const [layout, watchlists, alerts, strategies, drawings, calendarAlarms] = await Promise.all([
      db.layout.findUnique({ where: { userId: user.id } }),
      db.watchlist.findMany({ where: { userId: user.id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      db.alert.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
      db.strategyRule.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
      db.drawing.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
      db.calendarAlarm.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
    ])

    // settings — decrypted for the file (export/import roundtrip must carry
    // the real keys; the UI warns the file contains them in plaintext)
    const settings: Record<string, unknown> = {
      tradeMode: s.tradeMode === 'live' ? 'live' : 'paper',
      tpslPercent: typeof s.tpslPercent === 'number' && isFinite(s.tpslPercent) && s.tpslPercent > 0 ? s.tpslPercent : 5,
    }
    if (s.alpacaKeyIdEnc) settings.alpacaKeyId = decrypt(s.alpacaKeyIdEnc) || undefined
    if (s.alpacaSecretEnc) settings.alpacaSecret = decrypt(s.alpacaSecretEnc) || undefined
    // Task 37 — the per-account pairs travel under their own names (old files
    // without them still import through the legacy pair below)
    if (s.alpacaPaperKeyIdEnc) settings.alpacaPaperKeyId = decrypt(s.alpacaPaperKeyIdEnc) || undefined
    if (s.alpacaPaperSecretEnc) settings.alpacaPaperSecret = decrypt(s.alpacaPaperSecretEnc) || undefined
    if (s.alpacaLiveKeyIdEnc) settings.alpacaLiveKeyId = decrypt(s.alpacaLiveKeyIdEnc) || undefined
    if (s.alpacaLiveSecretEnc) settings.alpacaLiveSecret = decrypt(s.alpacaLiveSecretEnc) || undefined
    if (s.telegramTokenEnc) settings.telegramToken = decrypt(s.telegramTokenEnc) || undefined
    if (typeof s.telegramChatId === 'string') settings.telegramChatId = s.telegramChatId
    settings.notifyFills = s.notifyFills !== false
    settings.notifyCloses = s.notifyCloses !== false

    return NextResponse.json({
      app: 'blackhole-terminal',
      kind: FILE_KIND,
      version: FILE_VERSION,
      exportedAt: new Date().toISOString(),
      username: dbUser?.username ?? user.username,
      data: {
        layout: layout?.data ?? null,
        watchlists: watchlists.map((w) => ({
          name: w.name,
          color: w.color,
          sortOrder: w.sortOrder,
          items: Array.isArray(w.items) ? (w.items as unknown[]).filter((i): i is string => typeof i === 'string') : [],
        })),
        alerts: alerts.map((a) => ({
          symbol: a.symbol, kind: a.kind, price: a.price, direction: a.direction,
          condition: a.condition, timeframe: a.timeframe, params: a.params,
          color: a.color, status: a.status, note: a.note,
        })),
        strategies: strategies.map((r) => ({
          symbol: r.symbol, kind: r.kind, condition: r.condition, level: r.level,
          timeframe: r.timeframe, params: r.params, action: r.action, qty: r.qty,
          tpMode: r.tpMode, tpValue: r.tpValue, slMode: r.slMode, slValue: r.slValue,
          repeat: r.repeat,
          // Task 79 — the enable/disable state rides the export so an import
          // recreates the same armed/paused state (runtime states below are
          // mapped on import)
          status: r.status,
        })),
        drawings: drawings.map((d) => ({
          // id rides the export so TREND-line alarms (params.drawingId) re-bind
          // to the same drawing after an import round-trip
          id: d.id, symbol: d.symbol, kind: d.kind, points: d.points, color: d.color, width: d.width, meta: d.meta,
        })),
        calendarAlarms: calendarAlarms.map((c) => ({ eventKey: c.eventKey })),
        settings,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}

// ---- POST: import (replace per section present in the file) ----
interface ImportBody {
  data?: Record<string, unknown>
}

interface SanitizedAlert {
  symbol: string; kind: string; price: number; direction: string
  condition: string | null; timeframe: string; params: Prisma.InputJsonValue | null
  color: string; status: string; note: string | null
}

interface SanitizedStrategy {
  symbol: string; kind: string; condition: string; level: number
  timeframe: string; params: Prisma.InputJsonValue; action: string; qty: number
  tpMode: string; tpValue: number | null; slMode: string; slValue: number | null
  repeat: boolean
  status: string
}

interface SanitizedDrawing {
  id?: string
  symbol: string; kind: string; points: Prisma.InputJsonValue
  color: string; width: number; meta: Prisma.InputJsonValue | null
}

function sanitizeAlert(raw: unknown): SanitizedAlert | null {
  const r = asRecord(raw)
  if (!r) return null
  const symbol = str(r.symbol).toUpperCase()
  if (!symbol || symbol.length > 24) return null
  const kind = ALERT_KINDS.includes(str(r.kind)) ? str(r.kind) : 'price'
  const price = num(r.price)
  // MACD alarms legitimately use level 0 (zero line) or NEGATIVE levels
  // (macd histogram values) — only reject non-finite / absurd magnitudes
  if (!Number.isFinite(price) || Math.abs(price) > 1e9) return null
  const params = asRecord(r.params)
  return {
    symbol,
    kind,
    price,
    direction: r.direction === 'below' ? 'below' : 'above',
    condition: typeof r.condition === 'string' ? r.condition.slice(0, 32) : null,
    timeframe: validTf(r.timeframe),
    params: params
      ? {
          period: clampInt(params.period, 2, 200, 14),
          fast: clampInt(params.fast, 1, 200, 12),
          slow: clampInt(params.slow, 2, 400, 26),
          signal: clampInt(params.signal, 1, 200, 9),
          // trend-line alarms carry their drawing binding (best-effort: if the
          // drawing ids in the file match the imported drawings the alert
          // stays live, otherwise it simply never fires)
          ...(typeof params.drawingId === 'string' && params.drawingId.length <= 40
            ? { drawingId: params.drawingId }
            : {}),
        }
      : null,
    color: /^#[0-9a-fA-F]{6}$/.test(str(r.color)) ? str(r.color) : '#f59e0b',
    // re-arm fresh: paused stays paused; triggered/active become active
    status: r.status === 'paused' ? 'paused' : 'active',
    note: typeof r.note === 'string' ? r.note.slice(0, 200) : null,
  }
}

function sanitizeStrategy(raw: unknown): SanitizedStrategy | null {
  const r = asRecord(raw)
  if (!r) return null
  const symbol = str(r.symbol).toUpperCase()
  if (!symbol || symbol.length > 24) return null
  const kind = str(r.kind) === 'macd' ? 'macd' : 'rsi'
  const action = r.action === 'sell' ? 'sell' : 'buy'
  const qty = num(r.qty)
  if (!Number.isFinite(qty) || qty <= 0) return null
  const tpMode = ['none', 'price', 'pct'].includes(str(r.tpMode)) ? str(r.tpMode) : 'none'
  const slMode = ['none', 'price', 'pct'].includes(str(r.slMode)) ? str(r.slMode) : 'none'
  const tpValue = tpMode === 'none' ? null : num(r.tpValue)
  const slValue = slMode === 'none' ? null : num(r.slValue)
  if (tpMode !== 'none' && (!tpValue || tpValue <= 0 || (tpMode === 'pct' && tpValue > 100))) return null
  if (slMode !== 'none' && (!slValue || slValue <= 0 || (slMode === 'pct' && slValue > 100))) return null
  let condition: string
  let level = num(r.level)
  if (!Number.isFinite(level)) level = 0
  let params: Record<string, number>
  if (kind === 'rsi') {
    condition = r.condition === 'cross_below' ? 'cross_below' : 'cross_above'
    if (level <= 0 || level >= 100) return null
    params = { period: clampInt(asRecord(r.params)?.period, 2, 200, 14) }
  } else {
    condition = STRAT_CONDITIONS.includes(str(r.condition)) ? str(r.condition) : 'bull_cross'
    const fast = clampInt(asRecord(r.params)?.fast, 1, 200, 12)
    const slow = clampInt(asRecord(r.params)?.slow, 2, 400, 26)
    if (slow <= fast) return null
    params = { fast, slow, signal: clampInt(asRecord(r.params)?.signal, 1, 200, 9) }
  }
  // Task 79 — carry the enable/disable state across the round-trip: armed
  // stays armed, paused stays paused; runtime/transient states (placing/
  // triggered/failed) import PAUSED for review — re-arming a fired one-shot
  // here would surprise-fire it again on the next crossing. Legacy files
  // without a status field default to armed (the previous import behavior).
  const st = str(r.status)
  const status = st === 'paused' || st === 'triggered' || st === 'failed' ? 'paused' : 'armed'
  return {
    symbol, kind, condition, level: Math.round(level * 100) / 100,
    timeframe: validTf(r.timeframe), params, action, qty: Math.round(qty * 1e8) / 1e8,
    tpMode, tpValue, slMode, slValue,
    repeat: Boolean(r.repeat),
    status,
  }
}

function sanitizeDrawing(raw: unknown): SanitizedDrawing | null {
  const r = asRecord(raw)
  if (!r) return null
  const symbol = str(r.symbol).toUpperCase()
  if (!symbol || symbol.length > 24) return null
  const kind = ['hline', 'vline', 'trend', 'fib', 'rect', 'text'].includes(str(r.kind)) ? str(r.kind) : null
  if (!kind || !Array.isArray(r.points) || r.points.length === 0) return null
  const width = clampInt(r.width, 1, 6, 2)
  return {
    // original id (when the file carries one) — TREND-line alarms re-bind to
    // their drawing after an import round-trip through this id
    ...(typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 40 ? { id: r.id } : {}),
    symbol, kind,
    points: r.points.slice(0, 8) as Prisma.InputJsonValue,
    color: /^#[0-9a-fA-F]{6}$/.test(str(r.color)) ? str(r.color) : '#2962ff',
    width,
    meta: (asRecord(r.meta) as Prisma.InputJsonValue | null) ?? null,
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    const body = (await req.json().catch(() => null)) as (ImportBody & Record<string, unknown>) | null
    // accept either { data: {...} } or the raw export file object
    const data = asRecord(body?.data) ?? asRecord(body)
    if (!data) return NextResponse.json({ error: 'Invalid config file (no data)' }, { status: 400 })
    if (data.kind && data.kind !== FILE_KIND) {
      return NextResponse.json({ error: 'Not a BLACKHOLE Terminal config file' }, { status: 400 })
    }

    const summary: Record<string, number | boolean> = {}

    // ---- layout ----
    const layout = asRecord(data.layout)
    if (layout) {
      const tabs = layout.tabs
      if (!Array.isArray(tabs) || tabs.length === 0) {
        return NextResponse.json({ error: 'Layout section invalid (tabs missing)' }, { status: 400 })
      }
      await db.layout.upsert({
        where: { userId: user.id },
        update: { data: layout as Prisma.InputJsonValue },
        create: { userId: user.id, data: layout as Prisma.InputJsonValue },
      })
      summary.layout = true
    }

    // ---- watchlists ----
    if (Array.isArray(data.watchlists)) {
      const lists = data.watchlists
        .slice(0, 50)
        .map((raw) => {
          const r = asRecord(raw)
          if (!r) return null
          const name = str(r.name).slice(0, 60)
          if (!name) return null
          const items = (Array.isArray(r.items) ? r.items : [])
            .filter((i): i is string => typeof i === 'string')
            .map((i) => {
              const t = i.trim()
              // "#Tech" entries are GROUP SEPARATORS — keep their case (real
              // symbols are uppercased)
              if (!t) return ''
              return t.startsWith('#') ? `#${t.slice(1).trim().slice(0, 30)}` : t.toUpperCase().slice(0, 24)
            })
            .filter(Boolean)
            .slice(0, 500)
          return {
            name,
            color: /^#[0-9a-fA-F]{6}$/.test(str(r.color)) ? str(r.color) : '#22c55e',
            sortOrder: clampInt(r.sortOrder, 0, 1000, 0),
            items,
          }
        })
        .filter((l): l is NonNullable<typeof l> => l !== null)
      await db.$transaction(async (tx) => {
        await tx.watchlist.deleteMany({ where: { userId: user.id } })
        for (const [i, l] of lists.entries()) {
          await tx.watchlist.create({ data: { userId: user.id, ...l, sortOrder: l.sortOrder || i } })
        }
      })
      summary.watchlists = lists.length
    }

    // ---- alerts ----
    if (Array.isArray(data.alerts)) {
      const alerts = data.alerts.slice(0, 500).map(sanitizeAlert).filter((a): a is SanitizedAlert => a !== null)
      await db.$transaction(async (tx) => {
        await tx.alert.deleteMany({ where: { userId: user.id } })
        if (alerts.length) {
          await tx.alert.createMany({
            data: alerts.map((a) => ({
              userId: user.id, ...a,
              // explicit JsonNull for absent params (Prisma's null-input union)
              params: (a.params ?? Prisma.JsonNull) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
            })),
          })
        }
      })
      summary.alerts = alerts.length
    }

    // ---- strategy rules ----
    if (Array.isArray(data.strategies)) {
      const rules = data.strategies.slice(0, 50).map(sanitizeStrategy).filter((r): r is SanitizedStrategy => r !== null)
      await db.$transaction(async (tx) => {
        await tx.strategyRule.deleteMany({ where: { userId: user.id } })
        if (rules.length) {
          await tx.strategyRule.createMany({ data: rules.map((r) => ({ userId: user.id, ...r })) })
        }
      })
      summary.strategies = rules.length
      // Task 79 — armed/paused split so the client can show what came back live
      summary.strategiesArmed = rules.filter((r) => r.status === 'armed').length
      summary.strategiesPaused = rules.filter((r) => r.status === 'paused').length
    }

    // ---- drawings ----
    if (Array.isArray(data.drawings)) {
      // dedupe by preserved id (a duplicate PK would fail the whole createMany)
      const seenIds = new Set<string>()
      const drawings = data.drawings.slice(0, 2000).map(sanitizeDrawing).filter((d): d is SanitizedDrawing => {
        if (!d) return false
        if (d.id) {
          if (seenIds.has(d.id)) return false
          seenIds.add(d.id)
        }
        return true
      })
      await db.$transaction(async (tx) => {
        await tx.drawing.deleteMany({ where: { userId: user.id } })
        if (drawings.length) {
          await tx.drawing.createMany({
            data: drawings.map((d) => ({
              ...(d.id ? { id: d.id } : {}),
              userId: user.id, symbol: d.symbol, kind: d.kind, points: d.points, color: d.color, width: d.width,
              meta: (d.meta ?? Prisma.JsonNull) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
            })),
          })
        }
      })
      summary.drawings = drawings.length
    }

    // ---- calendar alarms ----
    if (Array.isArray(data.calendarAlarms)) {
      const keys = Array.from(
        new Set(
          data.calendarAlarms
            .map((raw) => (asRecord(raw) ? str(asRecord(raw)!.eventKey) : ''))
            .filter((k) => k && k.length <= 300),
        ),
      ).slice(0, 500)
      await db.$transaction(async (tx) => {
        await tx.calendarAlarm.deleteMany({ where: { userId: user.id } })
        for (const eventKey of keys) {
          await tx.calendarAlarm.create({ data: { userId: user.id, eventKey } })
        }
      })
      summary.calendarAlarms = keys.length
    }

    // ---- settings (merge; absent fields are untouched) ----
    const incoming = asRecord(data.settings)
    if (incoming) {
      const dbUser = await db.user.findUnique({ where: { id: user.id } })
      const s = ((dbUser?.settings as UserSettings | null) || {}) as Record<string, unknown>
      if (str(incoming.alpacaKeyId)) s.alpacaKeyIdEnc = encrypt(str(incoming.alpacaKeyId))
      if (str(incoming.alpacaSecret)) s.alpacaSecretEnc = encrypt(str(incoming.alpacaSecret))
      // Task 37 — per-account pairs (absent in old files → untouched)
      if (str(incoming.alpacaPaperKeyId)) s.alpacaPaperKeyIdEnc = encrypt(str(incoming.alpacaPaperKeyId))
      if (str(incoming.alpacaPaperSecret)) s.alpacaPaperSecretEnc = encrypt(str(incoming.alpacaPaperSecret))
      if (str(incoming.alpacaLiveKeyId)) s.alpacaLiveKeyIdEnc = encrypt(str(incoming.alpacaLiveKeyId))
      if (str(incoming.alpacaLiveSecret)) s.alpacaLiveSecretEnc = encrypt(str(incoming.alpacaLiveSecret))
      if (str(incoming.telegramToken)) s.telegramTokenEnc = encrypt(str(incoming.telegramToken))
      if (typeof incoming.telegramChatId === 'string') s.telegramChatId = incoming.telegramChatId.trim()
      if (typeof incoming.notifyFills === 'boolean') s.notifyFills = incoming.notifyFills
      if (typeof incoming.notifyCloses === 'boolean') s.notifyCloses = incoming.notifyCloses
      if (incoming.tradeMode === 'paper' || incoming.tradeMode === 'live') s.tradeMode = incoming.tradeMode
      const pct = num(incoming.tpslPercent)
      if (Number.isFinite(pct) && pct > 0 && pct <= 90) s.tpslPercent = Math.round(pct * 100) / 100
      await db.user.update({ where: { id: user.id }, data: { settings: s as unknown as Prisma.InputJsonValue } })
      summary.settings = true
    }

    return NextResponse.json({ ok: true, summary })
  } catch (e) {
    return handleError(e)
  }
}
