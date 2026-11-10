import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import {
  getPositions, getOpenOrders, getClosedOrders, resolveTradeMode, ensureCryptoOcoSupervisor,
  TradingOrder, TradingPosition, parseCryptoPlan, authBackoffMsLeft, isNoKeysError, isKeysUnreadableError,
} from '@/lib/trading'
import { matchFifo, resolveRunStrategyNames, type OpenLot } from '@/lib/trade-history'
import { ensureFillNotifier } from '@/lib/fill-notifier'
import { hasAlpacaKeys, describeAlpacaKeys } from '@/lib/alpaca'
import { handleError } from '@/lib/api-helpers'
import { db } from '@/lib/db'

/** Chart symbol (AAPL, BTC/USD) -> trading symbol (AAPL, BTCUSD). */
function normSymbol(s: string): string {
  return s.replace('/', '').toUpperCase()
}

export interface ExitInfo {
  orderId: string
  kind: 'sl' | 'tp'
  stopPrice: number | null
  limitPrice: number | null
  trailPercent: number | null
  qty: string
  side: string
  type: string
  /** Alpaca status — 'held' = the ARMED sibling of a live OCO family */
  status: string
  /** v2.12.30 — broker client_order_id (`tte-<entryId>-tp|sl` for
   * supervisor-placed legs, `ttp-…` for user-attached crypto legs) */
  clientOrderId: string | null
  createdAt: string | null
}

/** v2.12.30 — an OPEN exit-side (TP/SL/protection) order as a first-class
 * row, INCLUDING legs nested in OCO/bracket families and ORPHANS (no live
 * position on the symbol any more). Before this, a working TP/SL appeared
 * only as static price text on the position row (no cancel affordance) and
 * an orphan leg was invisible AND unremovable from the Positions tab. */
export interface ExitOrderRow {
  orderId: string
  symbol: string // chart-style (crypto orders keep the slash)
  side: string
  type: string
  qty: number
  limitPrice: number | null
  stopPrice: number | null
  trailPercent: number | null
  status: string
  /** classified role: tp (exit-side limit) / sl (stop family) / exit (other) */
  kind: 'tp' | 'sl' | 'exit'
  /** linked live position on this symbol — null = orphan (its position is gone) */
  position: { side: string; qty: number; avgEntry: number } | null
  /** placement source of the PROTECTED position (null when orphan) */
  source: 'manual' | 'algo' | 'grid' | 'ai' | null
  clientOrderId: string | null
  createdAt: string | null
}

export interface PositionRow {
  symbol: string // chart-style symbol (BTC/USD for crypto)
  tradeSymbol: string
  qty: number
  qtyAvailable: number
  side: string
  avgEntry: number
  current: number
  upl: number
  uplPct: number
  assetClass: string
  /** entry fill time of the OLDEST still-open FIFO entry lot (null = unknown,
   * e.g. the entry fill predates the closed-orders window) */
  openedAt: string | null
  /** placement source decoded from that lot's client_order_id — absent when
   * no open lot was found (rendered as '—' like other unknown columns).
   * 'grid' (Task 10-k): a `ttg-` tagged entry OR any open lot whose orderId
   * appears in GridFill (retro-attribution of pre-tagging grid fills).
   * 'ai' (v2.12.25): a `tta-` tagged entry — the AI Trade Adviser auto-trader. */
  source?: 'manual' | 'algo' | 'grid' | 'ai'
  /** when source === 'algo': first 8 chars of the originating AlgoRun id */
  runRef?: string | null
  /** when source === 'algo': strategy display name (resolved from AlgoRun) */
  strategy?: string
  /** Task 81 — per-source inventory breakdown of the position's still-open
   * FIFO lots. Alpaca aggregates ONE position per symbol, so when algo AND
   * grid (or manual) inventory coexist on the same symbol, the single legacy
   * `source` badge had to pick a winner (grid claimed everything, masking an
   * algo position on a grid-active symbol). `sources` lists EVERY source
   * slice with its open qty, dominant (largest qty, tie → oldest) first.
   * Single-source positions return exactly one slice (UI renders unchanged). */
  sources?: PositionSourceSlice[]
}

export interface PositionSourceSlice {
  source: 'manual' | 'algo' | 'grid' | 'ai'
  /** summed open qty across this slice's FIFO lots (float-trimmed) */
  qty: number
  /** when source === 'algo': the originating AlgoRun id prefix */
  runRef?: string | null
  /** when source === 'algo': strategy display name (resolved from AlgoRun) */
  strategy?: string
}

/** An open ENTRY order (not yet — or not fully — filled) for the chart. */
export interface PendingOrderRow {
  orderId: string
  symbol: string // chart-style (crypto orders keep the slash)
  side: string
  type: string
  qty: number
  filledQty: number
  limitPrice: number | null
  status: string
  /** planned/attached take-profit price (bracket legs or the ttb- plan) */
  tpPrice: number | null
  /** planned/attached stop-loss price */
  slPrice: number | null
  /** true when TP/SL ride along (managed complex order) */
  managed: boolean
  /** placement source: algo entries carry a `ttr-`, grid entries a `ttg-`,
   * AI Trade Adviser entries a `tta-` client_order_id (Task 10-k, v2.12.25) */
  source: 'manual' | 'algo' | 'grid' | 'ai'
  /** strategy display name when source === 'algo' (resolved from AlgoRun) */
  strategy?: string
  createdAt: string | null
}

export interface AuthErrorInfo {
  mode: string
  /** seconds until the next REAL Alpaca attempt (circuit breaker, Task 36) */
  retryInSec: number
  message: string
}

/** Task 37 — this mode has NO usable key pair at all (vs authError: keys
 * exist but are rejected). Rendered as an informational banner. */
export interface KeysMissingInfo {
  mode: string
  message: string
}

export interface PositionsResponse {
  mode: string
  positions: PositionRow[]
  exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }>
  pending: PendingOrderRow[]
  /** v2.12.30 — open exit-side (TP/SL/protection) orders incl. OCO legs and
   * orphans; the Positions tab renders them as rows with linkage + Cancel */
  exitOrders: ExitOrderRow[]
  errors?: string[]
  /** set when Alpaca rejected the saved keys (401) for this mode — the UI
   *  renders it as an actionable banner instead of an unlabeled error string */
  authError?: AuthErrorInfo
  /** set when this mode has no key pair at all (Task 37) */
  keysMissing?: KeysMissingInfo
}

// GET /api/trading/positions?mode=paper&symbol=BTC/USD
// Returns open positions + their attached SL/TP exit orders (for chart lines).
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const symbolParam = (searchParams.get('symbol') || '').trim()
    // keep the crypto complex-order emulation running (OCO attach + cleanup)
    // and the Telegram watcher's cursor advancing — but ONLY when a key pair
    // for THIS mode exists: a keys-less mode must not spawn 6s polling timers
    // (Task 36; mode-strict since Task 37)
    const modeHasKeys = await hasAlpacaKeys(user.id, mode)
    if (modeHasKeys) {
      ensureCryptoOcoSupervisor(user.id, mode)
      ensureFillNotifier(user.id, mode)
    } else if (mode === 'live' && (await hasAlpacaKeys(user.id, 'paper'))) {
      // the Telegram fill watcher reads fills from the trade MODE — keep it
      // alive on the paper pair when only paper keys exist so paper alerts
      // keep flowing while live is unconfigured
      ensureFillNotifier(user.id, 'paper')
    }

    const posRes = await getPositions(user.id, mode)
    const errors: string[] = []
    // 401s are surfaced via the structured `authError` banner below (Task 36)
    // — repeating the raw "request is not authorized" string in `errors` on
    // every poll adds nothing. 'no-keys'/'no-live-keys' surface via
    // `keysMissing` (Task 37).
    if (
      posRes.error && !isNoKeysError(posRes.error) && posRes.status !== 401 &&
      !isKeysUnreadableError(posRes.error)
    ) errors.push(posRes.error)

    // A failed fetch (401 on live with paper-only keys, network error) returns
    // an error OBJECT — only treat real arrays as data or the .filter below
    // crashes the whole route.
    const positions: TradingPosition[] = Array.isArray(posRes.data) ? posRes.data : []

    // Symbols with live positions drive the held-leg recovery sweep in
    // getOpenOrders (the armed SL leg of a FILLED bracket is invisible to a
    // status=open query). ORDER symbols keep the crypto slash (BTC/USD) while
    // POSITION symbols drop it (BTCUSD) — pass the order-symbol form.
    const heldSymbols = [...new Set(positions.map((p) => (p.asset_class === 'crypto' ? (p.symbol.includes('/') ? p.symbol : `${p.symbol.replace(/USD$/, '')}/USD`) : p.symbol)))]
    const chartKey = symbolParam ? normSymbol(symbolParam) : null
    const sweepSymbols = chartKey ? heldSymbols.filter((s) => normSymbol(s) === chartKey) : heldSymbols

    // Open orders + filled closed orders in PARALLEL: exits/pending come from
    // the open list; the FIFO matcher (trade-history) walks the closed fills
    // to find each position's still-open entry lot → openedAt + source.
    const [ordRes, closedRes] = await Promise.all([
      getOpenOrders(user.id, mode, symbolParam || undefined, sweepSymbols),
      getClosedOrders(user.id, mode, 500),
    ])
    if (ordRes.error && !isNoKeysError(ordRes.error) && ordRes.status !== 401) errors.push(ordRes.error)
    if (closedRes.error && !isNoKeysError(closedRes.error) && closedRes.status !== 401) errors.push(closedRes.error)

    // Task 36 — structured auth surfacing: a 401 (wrong-section keys, rotated
    // keys) travels as an actionable banner; the 5-min server circuit breaker
    // keeps polling cheap until the keys are fixed in Settings.
    // Task 37 — but ONLY when this mode still HAS a key pair: with no pair at
    // all the honest answer is keysMissing, not a stale "401 rejected".
    const blockedMs = authBackoffMsLeft(user.id, mode)
    const saw401 = posRes.status === 401 || ordRes.status === 401 || closedRes.status === 401
    // v2.12.6 — saved pair couldn't be decrypted (APP_ENCRYPTION_SECRET
    // changed): its own banner — the re-save fix — never a silent env swap.
    const sawUnreadable =
      isKeysUnreadableError(posRes.error) || isKeysUnreadableError(ordRes.error) ||
      isKeysUnreadableError(closedRes.error)
    const authError: AuthErrorInfo | undefined =
      modeHasKeys && (blockedMs > 0 || saw401 || sawUnreadable)
        ? sawUnreadable
          ? {
              mode,
              retryInSec: Math.ceil(blockedMs / 1000),
              message: `Your saved ${mode === 'live' ? 'LIVE' : 'Paper'} keys couldn't be decrypted — re-enter them in Settings → API keys and save again (this happens when the deployment's APP_ENCRYPTION_SECRET changed, e.g. after a redeploy without a stable secret). [using ${await describeAlpacaKeys(user.id, mode)}]`,
            }
          : {
              mode,
              retryInSec: Math.ceil(blockedMs / 1000),
              // v2.12.4 — banner names the exact pair in use (masked) so the
              // user can compare it against the Alpaca dashboard directly.
              message: `Alpaca rejected your API keys (401)${mode === 'live' ? ' for LIVE trading' : ''} — an Alpaca key works on paper OR live, never both. Check Settings → API keys: the Paper and Live sections must each hold keys for their OWN account. Retrying automatically. [using ${await describeAlpacaKeys(user.id, mode)}]`,
            }
        : undefined
    // Task 37 — distinguish "keys rejected" (authError) from "no keys for this
    // mode at all" so the UI can tell the user exactly what to add.
    const keysMissing: KeysMissingInfo | undefined = !modeHasKeys
      ? {
          mode,
          message:
            mode === 'live'
              ? 'No LIVE Alpaca keys configured — add your live-account keys in Settings → API keys (Live account).'
              : 'No Alpaca keys configured — add them in Settings → API keys (Paper account).',
        }
      : undefined
    const orders: TradingOrder[] = Array.isArray(ordRes.data) ? ordRes.data : []
    const closedOrders: TradingOrder[] = Array.isArray(closedRes.data) ? closedRes.data : []
    // max=0: closed TRADES are not needed here — only the open lots per symbol
    const openLots = matchFifo(closedOrders, 0).openLots
    // Task 79 — FIFO lot keys keep the crypto slash (ORDER symbols are
    // 'BTC/USD') while POSITION symbols drop it ('BTCUSD'), so the direct
    // `openLots.get(p.symbol)` lookup missed EVERY crypto position and their
    // source degraded to unknown/Manual even for algo-placed entries. Index
    // the lots by the normalized key (slash stripped, uppercased) so both
    // spellings resolve to the same bucket.
    const openLotsByNorm = new Map<string, OpenLot[]>()
    for (const [sym, lots] of openLots) openLotsByNorm.set(normSymbol(sym), lots)

    // Task 10-k — retro-attribution: GridFill rows record the broker orderId
    // of EVERY grid-placed order, so open lots placed BEFORE the `ttg-`
    // client_order_id tagging still resolve to source 'grid'. Capped to the
    // newest 2000 fills (indexed on userId) — far wider than the FIFO window
    // this route actually walks. v2.12.30 — the map carries gridTradeId too,
    // so retro-matched lots can be liveness-checked against their GridTrade.
    let gridOrderGridMap: Map<string, string> | null = null
    try {
      const gfills = await db.gridFill.findMany({
        where: { userId: user.id, orderId: { not: null } },
        orderBy: { ts: 'desc' },
        take: 2000,
        select: { orderId: true, gridTradeId: true },
      })
      gridOrderGridMap = new Map()
      for (const f of gfills) if (f.orderId) gridOrderGridMap.set(f.orderId, f.gridTradeId)
    } catch {
      gridOrderGridMap = null // degrade to coid-only attribution
    }

    // v2.12.30 — ENGINE LIVENESS. Source tags are decoded from broker-side
    // client_order_ids (and GridFill orderIds), which OUTLIVE the engine that
    // placed them: delete a finished algo run / grid and its lots keep the
    // 'Algo'/'Grid' badge forever, and the AI steward's isManual() check then
    // permanently refuses to protect the position ("引擎管理中") — exactly the
    // user-reported "removed algo/grid tags block AI 護盤 from taking care of
    // TP/SL". Fix: every tagged slice is liveness-checked against the LIVE
    // engine rows — AlgoRun.status==='running' / GridTrade.status==='active'
    // ('paused' stays live: the user paused it deliberately and can resume;
    // 'stopped'/'error'/deleted row = dead). Dead slices decay to 'manual' so
    // the steward re-owns them. DB failure degrades to "everything live"
    // (the old behavior) — attribution never flips on a transient error.
    const runRefSet = new Set<string>()
    const gridRefSet = new Set<string>()
    for (const lots of openLotsByNorm.values()) {
      for (const l of lots) {
        const plan = parseCryptoPlan(l.clientOrderId)
        if (plan?.runRef) runRefSet.add(plan.runRef)
        if (plan?.gridRef) gridRefSet.add(plan.gridRef)
      }
    }
    const pendingPlansEarly = orders.map((o) => ({ o, plan: parseCryptoPlan(o.client_order_id) }))
    for (const { plan } of pendingPlansEarly) {
      if (plan?.runRef) runRefSet.add(plan.runRef)
      if (plan?.gridRef) gridRefSet.add(plan.gridRef)
    }
    const liveRunRefs = new Set<string>() // runRef prefixes whose AlgoRun is 'running'
    const liveGridRefs = new Set<string>() // gridRef prefixes whose GridTrade is 'active'
    const liveGridIds = new Set<string>() // full active GridTrade ids (retro path)
    let enginesKnown = true
    try {
      const [runs, grids] = await Promise.all([
        db.algoRun.findMany({ where: { userId: user.id }, select: { id: true, status: true } }),
        db.gridTrade.findMany({ where: { userId: user.id }, select: { id: true, status: true } }),
      ])
      for (const r of runs) {
        if (r.status !== 'running') continue
        for (const ref of runRefSet) if (r.id.startsWith(ref)) liveRunRefs.add(ref)
      }
      for (const g of grids) {
        if (g.status !== 'active') continue
        liveGridIds.add(g.id)
        for (const ref of gridRefSet) if (g.id.startsWith(ref)) liveGridRefs.add(ref)
      }
    } catch {
      enginesKnown = false // degrade: treat every tagged slice as engine-live
    }

    const rows: PositionRow[] = positions
      .filter((p) => !symbolParam || normSymbol(p.symbol) === normSymbol(symbolParam))
      .map((p) => {
        // FIFO entry lots for this symbol → when the position was opened + who
        // placed it. Each lot is decoded INDIVIDUALLY (ttb-… manual · ttr-…
        // algo run · ttg-… grid, or a GridFill orderId match for pre-tagging
        // grid fills); lookup is normalized (Task 79) so crypto 'BTCUSD'
        // positions find 'BTC/USD' lots.
        // Task 81 — the old single-tag policy ("a grid lot ANYWHERE in the
        // FIFO claims the source") collapsed mixed inventory: an algo position
        // on a symbol where the grid engine also holds open lots was labeled
        // plain "Grid", hiding the algo run. The lots are now aggregated into
        // per-source slices (source + runRef key, qty summed, dominant qty
        // first, tie → oldest) so every coexisting source stays visible.
        const lots = openLotsByNorm.get(normSymbol(p.symbol)) ?? []
        const oldest = lots[0]
        type LotSrc = { source: 'manual' | 'algo' | 'grid' | 'ai'; qty: number; runRef: string | null; at: number }
        const lotSrcs: LotSrc[] = lots.map((l) => {
          const plan = parseCryptoPlan(l.clientOrderId)
          const retroGridId = gridOrderGridMap?.get(l.orderId)
          const isGridRef = plan?.gridRef != null
          const isRetroGrid = !isGridRef && retroGridId != null
          // v2.12.30 — a grid/algo tag with NO live engine behind it decays to
          // 'manual': the dead badge must not block the AI steward, and the
          // slice list must reflect who is ACTUALLY managing the inventory.
          const gridLive = isGridRef
            ? !enginesKnown || liveGridRefs.has(plan!.gridRef!)
            : isRetroGrid
              ? !enginesKnown || liveGridIds.has(retroGridId!)
              : false
          const isAi = !isGridRef && !isRetroGrid && plan?.aiRef != null
          const isAlgoRef = !isGridRef && !isRetroGrid && !isAi && plan?.runRef != null
          const algoLive = isAlgoRef && (!enginesKnown || liveRunRefs.has(plan!.runRef!))
          const source: LotSrc['source'] =
            (isGridRef || isRetroGrid) ? (gridLive ? 'grid' : 'manual')
            : isAi ? 'ai'
            : isAlgoRef ? (algoLive ? 'algo' : 'manual')
            : 'manual'
          return {
            source,
            qty: l.qty,
            runRef: source === 'algo' && plan?.runRef ? plan.runRef : null,
            at: new Date(l.entryTime).getTime() || 0,
          }
        })
        // merge lots into slices keyed by source (algo also by runRef, so two
        // different runs on one symbol stay separately labeled)
        const sliceMap = new Map<string, LotSrc>()
        for (const ls of lotSrcs) {
          const key = ls.source === 'algo' ? `algo:${ls.runRef ?? ''}` : ls.source
          const cur = sliceMap.get(key)
          if (cur) {
            cur.qty = Number((cur.qty + ls.qty).toPrecision(10))
            if (ls.at < cur.at) cur.at = ls.at
          } else {
            sliceMap.set(key, { ...ls })
          }
        }
        const slices = [...sliceMap.values()].sort((a, b) => (b.qty - a.qty) || (a.at - b.at))
        const dominant = slices[0]
        return {
          symbol: p.symbol.includes('/') ? p.symbol : p.asset_class === 'crypto' ? p.symbol.replace(/USD$/, '/USD') : p.symbol,
          tradeSymbol: p.symbol,
          qty: parseFloat(p.qty) || 0,
          qtyAvailable: parseFloat(p.qty_available) || 0,
          side: p.side,
          avgEntry: parseFloat(p.avg_entry_price) || 0,
          current: parseFloat(p.current_price) || 0,
          upl: parseFloat(p.unrealized_pl) || 0,
          uplPct: (parseFloat(p.unrealized_plpc) || 0) * 100,
          assetClass: p.asset_class,
          openedAt: oldest?.entryTime ?? null,
          // legacy single-source fields = the DOMINANT slice (backward compat:
          // chart consumers + the Source column sort keep working)
          ...(slices.length
            ? { source: dominant!.source, sources: slices.map(({ at: _at, ...s }) => s) }
            : {}),
          runRef: dominant?.runRef ?? null,
        }
      })

    // Map open exit orders (SL/TP legs) onto positions by symbol.
    const exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }> = {}
    const byTradeSym = new Map(rows.map((r) => [normSymbol(r.tradeSymbol), r]))
    // Legs nested under a NOT-yet-filled parent belong to a PENDING entry
    // family — they are future legs, not exits of the open position (a held
    // leg OPPOSITE its parent's side marks exactly that case). Held legs of
    // FILLED families are armed OCO siblings — real exits. The same leg can
    // ALSO appear flat (top-level, no parent) in the merged order list: the
    // pendingFamilyLegIds set keeps that shape from being double-counted as
    // an exit of an older position on the same symbol.
    const pendingFamilyLegIds = new Set<string>()
    for (const o of orders) {
      if (o.status === 'filled') continue
      for (const leg of o.legs || []) pendingFamilyLegIds.add(leg.id)
    }
    const visit = (o: TradingOrder, parent?: TradingOrder) => {
      if (o.status === 'held') {
        if (!parent) {
          // Flat held leg: the armed sibling of a FILLED bracket/OCO family
          // (recovered by the held-leg sweep) — a real exit. Skip it only
          // when it also nests under an open UNFILLED parent (pending entry).
          if (pendingFamilyLegIds.has(o.id)) return
        } else if (parent.status !== 'filled' && parent.side !== o.side) {
          // Held leg under an unfilled parent on the OPPOSITE side = pending
          // entry's future leg. (A held leg on the SAME side as its parent is
          // the armed sibling of a live OCO EXIT — Alpaca keeps the stop_loss
          // leg `held` while the take_profit leg works — and IS a real exit.)
          return
        }
      }
      const key = normSymbol(o.symbol)
      if (byTradeSym.has(key)) {
        const bucket = exits[key] || {}
        // exits ride the side OPPOSITE the position: a long exits with SELL
        // orders, a SHORT exits with BUY orders (side-aware fix — a short's
        // buy-side TP/SL used to be invisible)
        const posSide = byTradeSym.get(key)!.side
        const isExitSide = posSide === 'short' ? o.side === 'buy' : o.side === 'sell'
        if ((o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop') && isExitSide) {
          bucket.sl = {
            orderId: o.id,
            kind: 'sl',
            stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
            limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
            trailPercent: o.trail_percent ? parseFloat(o.trail_percent) : null,
            qty: o.qty,
            side: o.side,
            type: o.type,
            status: o.status,
            clientOrderId: o.client_order_id || null,
            createdAt: o.created_at ?? null,
          }
        } else if (o.type === 'limit' && isExitSide) {
          bucket.tp = {
            orderId: o.id,
            kind: 'tp',
            stopPrice: null,
            limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
            trailPercent: null,
            qty: o.qty,
            side: o.side,
            type: o.type,
            status: o.status,
            clientOrderId: o.client_order_id || null,
            createdAt: o.created_at ?? null,
          }
        }
        exits[key] = bucket
      }
    }
    for (const o of orders) {
      visit(o)
      for (const leg of o.legs || []) visit(leg, o)
    }

    // ---- pending (unfilled) ENTRY orders for the chart ----
    // Bracket parents (stocks) carry their TP/SL as legs; entries placed by
    // this terminal carry the planned TP/SL in the client_order_id (`ttb-`/
    // `ttr-`, decoded here — `ttr-` also marks the order as an ALGO entry).
    // Excluded: legs of other orders, our managed `tte-` exit legs, and —
    // when a position exists — orders on the OPPOSITE side (those already
    // classify as SL/TP exits above).
    const legIds = new Set<string>(orders.flatMap((o) => (o.legs || []).map((l) => l.id)))
    // batch-resolve algo run refs → strategy names: pending rows AND every
    // algo slice of every position share ONE resolver (trade-history) so
    // labels stay consistent across pending/positions/history
    const pendingPlans = orders.map((o) => ({ o, plan: parseCryptoPlan(o.client_order_id) }))
    const pendingRefs = [...new Set(pendingPlans.map(({ plan }) => plan?.runRef).filter((x): x is string => !!x))]
    const sliceRefs = rows.flatMap((r) => (r.sources ?? []).filter((s) => s.source === 'algo' && s.runRef).map((s) => s.runRef as string))
    const stratNames = await resolveRunStrategyNames([...new Set([...sliceRefs, ...pendingRefs])])
    // attach strategy names to every algo slice (and the dominant legacy field)
    const enrichedRows = rows.map((r) => {
      const sources = r.sources?.map((s) =>
        s.source === 'algo' && s.runRef ? { ...s, strategy: stratNames.get(s.runRef) ?? 'Algo' } : s,
      )
      const dominant = sources?.[0]
      return {
        ...r,
        ...(sources ? { sources } : {}),
        // legacy `strategy` keeps its old meaning — a name on an ALGO-source
        // row only; mixed rows carry per-slice names in `sources`
        strategy: dominant && dominant.source === 'algo' ? dominant.strategy : undefined,
      }
    })
    const pending: PendingOrderRow[] = []
    for (const { o, plan } of pendingPlans) {
      if (legIds.has(o.id)) continue
      if ((o.client_order_id || '').startsWith('tte-')) continue
      const key = normSymbol(o.symbol)
      if (symbolParam && key !== normSymbol(symbolParam)) continue
      const pos = byTradeSym.get(key)
      // an order on the opposite side of the position is an EXIT (already
      // mapped above); position side is long/short, order side is buy/sell
      const entrySide = pos ? (pos.side === 'long' ? 'buy' : 'sell') : null
      if (pos && o.side !== entrySide) continue
      let tpPrice: number | null = null
      let slPrice: number | null = null
      for (const leg of o.legs || []) {
        if (leg.side === o.side) continue
        if (leg.type === 'limit' && leg.limit_price) tpPrice = parseFloat(leg.limit_price)
        if ((leg.type === 'stop' || leg.type === 'stop_limit') && leg.stop_price) slPrice = parseFloat(leg.stop_price)
      }
      if (plan) {
        if (plan.tp != null) tpPrice = plan.tp
        if (plan.sl != null) slPrice = plan.sl
      }
      // v2.12.30 — engine liveness for the SOURCE tag too: a pending entry
      // whose algo run / grid was removed is a stray order the steward must
      // be allowed to babysit/cancel, not a sacred engine-owned row.
      const pGridLive = plan?.gridRef != null && (!enginesKnown || liveGridRefs.has(plan.gridRef))
      const pRunLive = plan?.runRef != null && (!enginesKnown || liveRunRefs.has(plan.runRef))
      const pSource: PendingOrderRow['source'] =
        plan?.gridRef != null ? (pGridLive ? 'grid' : 'manual')
        : plan?.aiRef != null ? 'ai'
        : plan?.runRef != null ? (pRunLive ? 'algo' : 'manual')
        : 'manual'
      pending.push({
        orderId: o.id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        qty: parseFloat(o.qty) || 0,
        filledQty: parseFloat(o.filled_qty) || 0,
        limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
        status: o.status,
        tpPrice,
        slPrice,
        managed: Boolean(plan) || (o.legs?.length ?? 0) > 0,
        source: pSource,
        strategy: plan?.runRef && pRunLive ? stratNames.get(plan.runRef) : undefined,
        createdAt: o.created_at,
      })
    }

    // ---- v2.12.30 — exit-side (TP/SL/protection) orders as first-class rows
    // ---- (the user report: pending TP/SL orders were neither visible nor
    // ---- removable in the Positions tab and carried no linkage to the
    // ---- position they protect). Collected SEPARATELY from `pending` — the
    // ---- steward babysits entries via that array, and exit legs must never
    // ---- leak into it (the model would cancel real protection thinking it
    // ---- is a stray entry).
    const exitOrders: ExitOrderRow[] = []
    const seenExit = new Set<string>()
    const isStopType = (t: string) => t === 'stop' || t === 'stop_limit' || t === 'trailing_stop'
    const visitExit = (o: TradingOrder) => {
      if (o.status === 'filled') return
      if (seenExit.has(o.id)) return // legs appear BOTH nested and flat (held sweep)
      seenExit.add(o.id)
      const key = normSymbol(o.symbol)
      if (symbolParam && key !== normSymbol(symbolParam)) return
      const pos = byTradeSym.get(key)
      const coid = o.client_order_id || ''
      const managedLeg = coid.startsWith('tte-') || coid.startsWith('ttp-')
      const isExitSide = pos ? (pos.side === 'short' ? o.side === 'buy' : o.side === 'sell') : null
      // entry-side orders of an open position belong to `pending`; a plain
      // limit with no position is an entry too (also `pending`, status quo).
      // Everything else — exit-side stops/limits of a live position, managed
      // tte-/ttp- legs, orphan stops — is PROTECTION the user must be able
      // to see and cancel.
      if (pos && isExitSide === false && !managedLeg) return
      if (!pos && !managedLeg && !isStopType(o.type)) return
      const kind: ExitOrderRow['kind'] = managedLeg
        ? coid.endsWith('-tp') ? 'tp' : coid.endsWith('-sl') ? 'sl' : 'exit'
        : isExitSide
          ? isStopType(o.type) ? 'sl' : o.type === 'limit' ? 'tp' : 'exit'
          : isStopType(o.type) ? 'sl' : 'exit'
      exitOrders.push({
        orderId: o.id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        qty: parseFloat(o.qty) || 0,
        limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
        stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
        trailPercent: o.trail_percent ? parseFloat(o.trail_percent) : null,
        status: o.status,
        kind,
        position: pos ? { side: pos.side, qty: pos.qty, avgEntry: pos.avgEntry } : null,
        source: pos ? (pos.source ?? null) : null,
        clientOrderId: coid || null,
        createdAt: o.created_at ?? null,
      })
    }
    for (const o of orders) {
      visitExit(o)
      for (const leg of o.legs || []) visitExit(leg)
    }

    return NextResponse.json({ mode, positions: enrichedRows, exits, pending, exitOrders, errors: errors.length ? errors : undefined, authError, keysMissing })
  } catch (e) {
    return handleError(e)
  }
}
