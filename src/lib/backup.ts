// Task 9-r — shared backup/restore core. ONE JSON file carries the user's
// account (username, passwordHash, encrypted TOTP secret, settings as stored)
// plus every data row they own, so a publish/redeploy reset (fresh DB) is
// recoverable in ~30 seconds: restore-into-empty from the login screen or
// restore-into-current from Settings.
//
// SECURITY MODEL (mirrors the task spec):
//  - NOTHING is decrypted here. `settings` and `totpSecret` ride the file
//    exactly as stored (AES-256-GCM blobs). They restore 1:1 when the target
//    install resolves the SAME encryption secret (same APP_ENCRYPTION_SECRET /
//    AUTH_SECRET env, mirrored to AppSecret by app-secret.ts); otherwise the
//    blobs simply fail to decrypt (decrypt() → null) and the user re-enters
//    keys — the UI warns about this. Plaintext secrets never touch the file.
//  - passwordHash is the scrypt `salt:hash` string — NOT encrypted, NOT
//    plaintext: restoring it as-is keeps the old password working.
//  - Restores are hard-gated: into the CURRENT account (session required) or
//    into an EMPTY system (user table must be empty — first-run bootstrap
//    trust level, same gate as registration's empty-table branch).
//  - Row caps (MAX_ROWS_PER_TABLE) keep a hostile/huge file from OOM-ing the
//    box; row whitelists below keep unknown/unsafe fields out of the DB.
import { Prisma } from '@prisma/client'

export const BACKUP_APP = 'blackhole-terminal'
export const BACKUP_VERSION = 1
export const MAX_ROWS_PER_TABLE = 5000
export const RECO_ID_PREFIX = 'algo-reco:'

export const BACKUP_TABLE_KEYS = [
  'watchlists',
  'drawings',
  'alerts',
  'strategyRules',
  'algoRuns',
  'algoLogs',
  'calendarAlarms',
  'gridTrades',
  'gridFills',
] as const

export interface BackupEnvelope {
  user: Record<string, unknown>
  data: Record<string, unknown>
}

export type ParseResult =
  | { ok: true; file: BackupEnvelope }
  | { ok: false; error: string }

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * Validate the backup envelope. Accepts the raw file object or a
 * `{ backup: {...} }` wrapper. Enforces app/version/data presence and the
 * per-table row cap (400-level refusal is the caller's job).
 */
export function parseBackupEnvelope(body: unknown): ParseResult {
  const outer = asRecord(body)
  const file = asRecord(outer?.backup) ?? outer
  if (!file) return { ok: false, error: 'Not a BLACKHOLE Terminal backup file' }
  if (file.app !== BACKUP_APP) {
    return { ok: false, error: 'Not a BLACKHOLE Terminal backup file' }
  }
  if (file.version !== BACKUP_VERSION) {
    return {
      ok: false,
      error: `Unsupported backup version (${String(file.version)}) — expected ${BACKUP_VERSION}`,
    }
  }
  const data = asRecord(file.data)
  if (!data) return { ok: false, error: 'Backup file has no data section' }
  for (const key of BACKUP_TABLE_KEYS) {
    const rows = data[key]
    if (Array.isArray(rows) && rows.length > MAX_ROWS_PER_TABLE) {
      return {
        ok: false,
        error: `Table "${key}" has ${rows.length} rows — the limit is ${MAX_ROWS_PER_TABLE}`,
      }
    }
  }
  // `user` is optional for restore-into-current (only settings is consumed
  // there); restore-into-empty re-validates its fields itself.
  return { ok: true, file: { user: asRecord(file.user) ?? {}, data } }
}

// ---------------------------------------------------------------------------
// Row whitelisting — field specs keyed exactly like the Prisma models. A field
// marked req drops the WHOLE row when invalid (required by the schema, no
// usable default); the rest are omitted on invalid input so the schema
// default (or NULL) applies. `id` is preserved when it looks like one so
// cross-row references survive the round-trip (algoLogs.runId → algoRuns.id,
// gridFills.gridTradeId → gridTrades.id, StrategyFireLog-style order ids).
// ---------------------------------------------------------------------------

interface FieldSpec {
  /** s=string, n=number, b=boolean, j=JSON, d=DateTime */
  t: 's' | 'n' | 'b' | 'j' | 'd'
  /** invalid value ⇒ drop the row (schema-required, no default) */
  req?: boolean
  /** string max length (trim + slice) */
  max?: number
}

const SPECS: Record<string, Record<string, FieldSpec>> = {
  watchlist: {
    name: { t: 's', req: true, max: 60 },
    color: { t: 's', max: 16 },
    sortOrder: { t: 'n' },
    items: { t: 'j', req: true },
    createdAt: { t: 'd' },
  },
  drawing: {
    symbol: { t: 's', req: true, max: 24 },
    kind: { t: 's', req: true, max: 16 },
    points: { t: 'j', req: true },
    color: { t: 's', max: 16 },
    width: { t: 'n' },
    meta: { t: 'j' },
    createdAt: { t: 'd' },
  },
  alert: {
    symbol: { t: 's', req: true, max: 24 },
    kind: { t: 's', max: 16 },
    price: { t: 'n', req: true },
    direction: { t: 's', max: 8 },
    condition: { t: 's', max: 32 },
    timeframe: { t: 's', max: 8 },
    params: { t: 'j' },
    color: { t: 's', max: 16 },
    status: { t: 's', max: 16 },
    note: { t: 's', max: 200 },
    lastSide: { t: 's', max: 8 },
    triggeredAt: { t: 'd' },
    createdAt: { t: 'd' },
  },
  strategyRule: {
    symbol: { t: 's', req: true, max: 24 },
    kind: { t: 's', req: true, max: 8 },
    condition: { t: 's', req: true, max: 32 },
    level: { t: 'n', req: true },
    timeframe: { t: 's', max: 8 },
    params: { t: 'j', req: true },
    action: { t: 's', req: true, max: 8 },
    qty: { t: 'n', req: true },
    tpMode: { t: 's', max: 8 },
    tpValue: { t: 'n' },
    slMode: { t: 's', max: 8 },
    slValue: { t: 'n' },
    repeat: { t: 'b' },
    status: { t: 's', max: 16 },
    // Task 94 (review R-1#4) — the pinned account survives backup restore;
    // restore normalizes anything that is not exactly 'live' to 'paper'
    // (fail-safe: a tampered backup can never mint a live rule — that still
    // requires the create/PATCH opt-in rail with liveConfirm + live keys)
    mode: { t: 's', max: 8 },
    lastSide: { t: 's', max: 8 },
    triggeredAt: { t: 'd' },
    orderId: { t: 's', max: 64 },
    fireNote: { t: 's', max: 500 },
    createdAt: { t: 'd' },
  },
  algoRun: {
    symbol: { t: 's', req: true, max: 24 },
    timeframe: { t: 's', max: 8 },
    strategy: { t: 's', req: true, max: 32 },
    params: { t: 'j', req: true },
    qty: { t: 'n', req: true },
    sizingMode: { t: 's', max: 8 },
    riskBasis: { t: 's', max: 8 },
    riskMoney: { t: 'n' },
    riskMoneyPct: { t: 'n' },
    tpMode: { t: 's', max: 8 },
    tpValue: { t: 'n' },
    slMode: { t: 's', max: 8 },
    slValue: { t: 'n' },
    maxTradesDay: { t: 'n' },
    rthOnly: { t: 'b' },
    flattenEod: { t: 'b' },
    cooldownMin: { t: 'n' },
    requireNewSignal: { t: 'b' },
    status: { t: 's', max: 16 },
    state: { t: 'j' },
    startedAt: { t: 'd' },
    stoppedAt: { t: 'd' },
    createdAt: { t: 'd' },
  },
  algoLog: {
    runId: { t: 's', req: true, max: 64 },
    level: { t: 's', max: 8 },
    message: { t: 's', req: true, max: 2000 },
    createdAt: { t: 'd' },
  },
  calendarAlarm: {
    eventKey: { t: 's', req: true, max: 300 },
    createdAt: { t: 'd' },
  },
  gridTrade: {
    symbol: { t: 's', req: true, max: 24 },
    lowerPrice: { t: 'n', req: true },
    upperPrice: { t: 'n', req: true },
    gridCount: { t: 'n', req: true },
    spacing: { t: 's', max: 16 },
    qtyPerGrid: { t: 'n', req: true },
    maxSL: { t: 'n' },
    maxTP: { t: 'n' },
    closeOnStop: { t: 'b' },
    status: { t: 's', max: 16 },
    stopReason: { t: 's', max: 200 },
    realizedPnl: { t: 'n' },
    feePaid: { t: 'n' },
    state: { t: 'j' },
    startedAt: { t: 'd' },
    stoppedAt: { t: 'd' },
    createdAt: { t: 'd' },
  },
  gridFill: {
    gridTradeId: { t: 's', req: true, max: 64 },
    levelIndex: { t: 'n', req: true },
    side: { t: 's', req: true, max: 8 },
    reason: { t: 's', max: 16 },
    price: { t: 'n', req: true },
    qty: { t: 'n', req: true },
    pnl: { t: 'n' },
    fee: { t: 'n' },
    orderId: { t: 's', max: 64 },
    note: { t: 's', max: 500 },
    ts: { t: 'd' },
  },
}

const toDate = (v: unknown): Date | null => {
  if (typeof v !== 'string' && !(v instanceof Date)) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Whitelist one raw row into a createMany data object; null ⇒ drop the row. */
function buildRow(raw: unknown, spec: Record<string, FieldSpec>): Record<string, unknown> | null {
  const r = asRecord(raw)
  if (!r) return null
  const out: Record<string, unknown> = {}
  // preserve ids (cross-row references) — but only plausible ones; anything
  // else lets the DB generate a fresh cuid
  if (typeof r.id === 'string' && r.id.length >= 1 && r.id.length <= 64) out.id = r.id
  for (const [field, f] of Object.entries(spec)) {
    const v = r[field]
    switch (f.t) {
      case 's': {
        const s = typeof v === 'string' ? v.trim().slice(0, f.max ?? 500) : ''
        if (s) { out[field] = s; break }
        if (v === null && !f.req) { out[field] = null; break } // explicit NULL
        if (f.req) return null
        break // omit → schema default
      }
      case 'n': {
        if (typeof v === 'number' && Number.isFinite(v)) { out[field] = v; break }
        if (v === null && !f.req) { out[field] = null; break }
        if (f.req) return null
        break
      }
      case 'b': {
        if (typeof v === 'boolean') { out[field] = v; break }
        if (f.req) return null
        break
      }
      case 'j': {
        if (v === undefined) { if (f.req) return null; break }
        if (v === null) { if (f.req) return null; out[field] = null; break }
        out[field] = v as Prisma.InputJsonValue
        break
      }
      case 'd': {
        const d = toDate(v)
        if (d) { out[field] = d; break }
        if (v === null && !f.req) { out[field] = null; break }
        if (f.req) return null
        break
      }
    }
  }
  return out
}

/** Build rows for a table: whitelist each entry, drop invalids, dedupe ids. */
export function buildRows(rawRows: unknown[], model: keyof typeof SPECS): Record<string, unknown>[] {
  const spec = SPECS[model]
  const seenIds = new Set<string>()
  const rows: Record<string, unknown>[] = []
  for (const raw of rawRows) {
    const row = buildRow(raw, spec)
    if (!row) continue
    const id = typeof row.id === 'string' ? row.id : null
    if (id) {
      // duplicate PK would fail the whole createMany — keep the first
      if (seenIds.has(id)) continue
      seenIds.add(id)
    }
    rows.push(row)
  }
  return rows
}

const jsonOrNull = (v: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput =>
  (v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue))

/**
 * Restore every data section present in `data` for `userId` inside the
 * CALLER's transaction. Sections absent from the file are skipped entirely
 * (no delete, no create) — partial restores are safe. Layout is an upsert by
 * userId (@id); the per-user recommended-setups cache row is rewritten to
 * `algo-reco:<userId>` (its id IS the user key). Returns per-table counts.
 */
export async function restoreBackupData(
  tx: Prisma.TransactionClient,
  userId: string,
  data: Record<string, unknown>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const has = (k: string) => Array.isArray(data[k])

  if (has('watchlists')) {
    const rows = buildRows(data.watchlists as unknown[], 'watchlist')
    await tx.watchlist.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.watchlist.createMany({
        data: rows.map((r) => ({ ...r, userId })) as unknown as Prisma.WatchlistCreateManyInput[],
      })
    }
    counts.watchlists = rows.length
  }

  if (data.layout !== undefined) {
    const layoutRow = asRecord(data.layout)
    const layoutData = asRecord(layoutRow?.data)
    if (!layoutData) throw new Error('Layout section invalid (data missing)')
    // bound the blob — layout autosaves are bounded upstream, this is just a
    // seatbelt against a hand-edited multi-GB file
    if (JSON.stringify(layoutData).length > 4_000_000) throw new Error('Layout section too large')
    await tx.layout.upsert({
      where: { userId },
      update: { data: layoutData as Prisma.InputJsonValue },
      create: { userId, data: layoutData as Prisma.InputJsonValue },
    })
    counts.layout = 1
  }

  if (has('drawings')) {
    const rows = buildRows(data.drawings as unknown[], 'drawing')
    await tx.drawing.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.drawing.createMany({
        data: rows.map((r) => ({
          ...r,
          userId,
          meta: jsonOrNull(r.meta),
        })) as unknown as Prisma.DrawingCreateManyInput[],
      })
    }
    counts.drawings = rows.length
  }

  if (has('alerts')) {
    const rows = buildRows(data.alerts as unknown[], 'alert')
    await tx.alert.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.alert.createMany({
        data: rows.map((r) => ({
          ...r,
          userId,
          params: jsonOrNull(r.params),
        })) as unknown as Prisma.AlertCreateManyInput[],
      })
    }
    counts.alerts = rows.length
  }

  if (has('strategyRules')) {
    const rows = buildRows(data.strategyRules as unknown[], 'strategyRule')
    await tx.strategyRule.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.strategyRule.createMany({
        data: rows.map((r) => ({
          ...r,
          // fail-safe normalize (see whitelist comment)
          mode: r.mode === 'live' ? 'live' : 'paper',
          userId,
        })) as unknown as Prisma.StrategyRuleCreateManyInput[],
      })
    }
    counts.strategyRules = rows.length
  }

  if (has('algoRuns')) {
    const rows = buildRows(data.algoRuns as unknown[], 'algoRun')
    await tx.algoRun.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.algoRun.createMany({
        data: rows.map((r) => ({
          ...r,
          userId,
          state: jsonOrNull(r.state),
        })) as unknown as Prisma.AlgoRunCreateManyInput[],
      })
    }
    counts.algoRuns = rows.length
  }

  if (has('algoLogs')) {
    const rows = buildRows(data.algoLogs as unknown[], 'algoLog')
    await tx.algoLog.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.algoLog.createMany({
        data: rows.map((r) => ({ ...r, userId })) as unknown as Prisma.AlgoLogCreateManyInput[],
      })
    }
    counts.algoLogs = rows.length
  }

  if (data.algoRecoCache !== undefined) {
    const raw = asRecord(data.algoRecoCache)
    // payload is a String column (the shaped feed JSON)
    const payload = typeof raw?.payload === 'string' ? raw.payload.slice(0, 2_000_000) : ''
    if (!payload) throw new Error('algoRecoCache section invalid (payload missing)')
    const generatedAt = toDate(raw?.generatedAt) ?? new Date()
    await tx.algoRecoCache.deleteMany({ where: { id: `${RECO_ID_PREFIX}${userId}` } })
    await tx.algoRecoCache.create({ data: { id: `${RECO_ID_PREFIX}${userId}`, generatedAt, payload } })
    counts.algoRecoCache = 1
  }

  if (has('calendarAlarms')) {
    const rows = buildRows(data.calendarAlarms as unknown[], 'calendarAlarm')
    // @@unique([userId, eventKey]) — dedupe event keys so one bad row can't
    // fail the whole createMany
    const seen = new Set<string>()
    const unique = rows.filter((r) => {
      const key = typeof r.eventKey === 'string' ? r.eventKey : ''
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    await tx.calendarAlarm.deleteMany({ where: { userId } })
    if (unique.length) {
      await tx.calendarAlarm.createMany({
        data: unique.map((r) => ({ ...r, userId })) as unknown as Prisma.CalendarAlarmCreateManyInput[],
      })
    }
    counts.calendarAlarms = unique.length
  }

  if (has('gridTrades')) {
    const rows = buildRows(data.gridTrades as unknown[], 'gridTrade')
    await tx.gridTrade.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.gridTrade.createMany({
        data: rows.map((r) => ({
          ...r,
          userId,
          state: jsonOrNull(r.state),
        })) as unknown as Prisma.GridTradeCreateManyInput[],
      })
    }
    counts.gridTrades = rows.length
  }

  if (has('gridFills')) {
    const rows = buildRows(data.gridFills as unknown[], 'gridFill')
    await tx.gridFill.deleteMany({ where: { userId } })
    if (rows.length) {
      await tx.gridFill.createMany({
        data: rows.map((r) => ({ ...r, userId })) as unknown as Prisma.GridFillCreateManyInput[],
      })
    }
    counts.gridFills = rows.length
  }

  return counts
}
