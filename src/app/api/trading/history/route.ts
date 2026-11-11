import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getClosedOrders, getPositions, resolveTradeMode, isNoKeysError, isKeysUnreadableError, authBackoffMsLeft, parseCryptoPlan, type TradingOrder } from '@/lib/trading'
import { describeAlpacaKeys } from '@/lib/alpaca'
import { matchFifo, ghostLotSymbols, consumedPhantomSymbols, resolveRunStrategyNames, displaySymbolOf } from '@/lib/trade-history'
import { loadStewardActions, resolveTradeReason, resolveCancelReason } from '@/lib/trade-reasons'
import type { CanceledOrderRow, ClosedTrade } from '@/lib/market-types'
import { handleError } from '@/lib/api-helpers'

// v2.12.36 — the suspect→widen path re-pages the broker; a suspect the
// widening cannot heal (an entry older than the page cap) must not re-page
// on EVERY history poll (the tab polls every ~15s), so each account+mode's
// widen attempt is remembered for a minute.
const WIDEN_MEMO_MS = 60_000
const widenMemo = new Map<string, number>()
function widenRecently(key: string): boolean {
  const at = widenMemo.get(key)
  return at != null && Date.now() - at < WIDEN_MEMO_MS
}

// GET /api/trading/history?mode=paper&limit=100 — realized round-trip trades
// (FIFO-matched from the broker's filled closed orders) with realized P&L.
// Powers the Positions tab "Trade history" group + the Performance Report.
// Each trade carries `source: 'manual' | 'algo' | 'grid' | 'ai'` (decoded
// from the entry order's client_order_id, Task 10-k) and, for algo trades,
// the resolved strategy name.
// Task 82 — optional `from`/`to` (ISO timestamps) filter the matched trades
// by EXIT time (the CLOSED column): the FIFO walk still runs over the whole
// recent closed-orders window, the date filter is applied BEFORE the limit
// so a narrow range isn't crowded out by newer trades. Ranges come from the
// client in the browser's timezone (local-midnight ISO).
// v2.12.28 — three additions: (1) HELD-BUG fix — after the walk the open
// lots are checked against the LIVE positions; a lot with no backing
// position (or a contradicting side) is a WINDOW-TRUNCATION GHOST whose
// pairing poisoned HELD/P&L ("same-day trade shows 7d"), so the tape is
// WIDENED with older pages (page_token, up to 3 pages) and re-walked.
// (2) zero-fill CANCELED/expired orders surface as their own rows (they used
// to vanish without a trace; edit-replacements are excluded as noise).
// (3) every row gains a `reason` (TP/SL hit, AI-steward close/cancel with
// the steward's verdict, engine exit, manual close…) for the new REASON
// column.
export async function GET(req: Request) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { searchParams } = new URL(req.url)
    const mode = await resolveTradeMode(user.id, searchParams.get('mode'))
    const limitRaw = Number(searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(300, Math.round(limitRaw)) : 100
    const fromMs = Date.parse(searchParams.get('from') || '')
    const toMs = Date.parse(searchParams.get('to') || '')

    // v2.12.28 — the live-positions list rides along (parallel, cheap) for
    // the ghost-lot check; it does NOT fail the history when it errors.
    const [r, posRes] = await Promise.all([
      getClosedOrders(user.id, mode, 500),
      getPositions(user.id, mode).catch(() => ({ data: null, status: 0 })),
    ])
    if (!r.data) {
      // no keys configured is a quiet empty state (same convention as fills)
      if (isNoKeysError(r.error)) {
        return NextResponse.json({ mode, trades: [], canceled: [], configured: false })
      }
      // v2.12.6 — saved pair couldn't be decrypted (APP_ENCRYPTION_SECRET
      // changed): actionable re-save banner, never silent env substitution.
      if (isKeysUnreadableError(r.error)) {
        const keysDesc = await describeAlpacaKeys(user.id, mode)
        return NextResponse.json({
          mode,
          trades: [],
          canceled: [],
          configured: true,
          authError: {
            mode,
            message: `Your saved ${mode === 'live' ? 'LIVE' : 'Paper'} keys couldn't be decrypted — trade history is unavailable until they are re-entered (Settings → API keys). [using ${keysDesc}]`,
          },
        })
      }
      // v1.95.0 — an engaged 401 breaker must be ACTIONABLE, not a bare 401:
      // the UI renders an amber "keys rejected — retry in N min" banner from
      // this shape (same contract as /api/trading/positions). A history that
      // silently rendered empty while a real account had closed trades was
      // exactly the "my closed trade is missing" report.
      // v2.12.2 — but as a 200 + authError BODY, NOT an HTTP 401: the client's
      // global 401 watcher treats any non-auth /api/* 401 as SESSION DEATH and
      // logs the user out — upstream Alpaca key rejection must never kill the
      // terminal session. PositionsTab reads authError from the 200 body.
      if (r.status === 401) {
        const retryInSec = Math.ceil(authBackoffMsLeft(user.id, mode) / 1000)
        const keysDesc = await describeAlpacaKeys(user.id, mode)
        return NextResponse.json(
          {
            mode,
            trades: [],
            canceled: [],
            configured: true,
            authError: {
              mode,
              retryInSec,
              message: `${mode === 'live' ? 'LIVE' : 'Paper'} keys rejected by Alpaca — trade history for this account is unavailable until the keys are fixed. [using ${keysDesc}]`,
            },
          },
        )
      }
      return NextResponse.json({ error: r.error || 'Closed orders fetch failed' }, { status: r.status || 502 })
    }

    // v2.12.28 — GHOST CHECK → WIDEN: walk the tape; if the leftover open
    // lots can't be explained by the live positions (no position for the
    // symbol, or the side contradicts), the newest-500 window truncated a
    // straddling position — refetch with OLDER pages and re-walk.
    // v2.12.36 — second suspect class: CONSUMED PHANTOMS. An unanchored exit
    // (a fill that closed nothing) on a symbol whose LIVE side is OPPOSITE
    // the fill can only be explained by an entry lot outside the window —
    // the walk minted a phantom from that fill and a later re-entry fill
    // consumed it (the AI auto-trader re-enters the same symbols across
    // days), so a real cross-day round-trip vanished from history and a
    // bogus opposite-side trade took its place while the open lots LOOKED
    // consistent — the ghost check alone is structurally blind to it. Both
    // classes widen the tape (up to 4 pages, one broker call per page, only
    // on the suspect path, rate-limited once per WIDEN_MEMO_MS per
    // account+mode) and re-walk. At the cap we accept the best-effort tape.
    let orderList = Array.isArray(r.data) ? r.data : []
    const positions = Array.isArray(posRes.data) ? (posRes.data as { symbol: string; side: string }[]) : []
    let fm = matchFifo(orderList, 1000)
    try {
      const suspects = new Set<string>([
        ...ghostLotSymbols(fm.openLots, positions),
        ...consumedPhantomSymbols(fm.unanchored, positions),
      ])
      const memoKey = `${user.id}:${mode}`
      if (suspects.size > 0 && !widenRecently(memoKey)) {
        widenMemo.set(memoKey, Date.now())
        if (widenMemo.size > 200) for (const [k, at] of widenMemo) if (Date.now() - at > 10 * WIDEN_MEMO_MS) widenMemo.delete(k)
        const wider = await getClosedOrders(user.id, mode, 500, 4)
        if (Array.isArray(wider.data) && wider.data.length > orderList.length) {
          orderList = wider.data
          fm = matchFifo(orderList, 1000)
        }
      }
    } catch {
      // suspect check must never fail the history
    }

    // reason sources: the AI steward's recent executed actions (best-effort)
    const steward = await loadStewardActions(user.id)
    const byId = new Map<string, TradingOrder>()
    for (const o of orderList) byId.set(o.id, o)
    for (const o of orderList) for (const leg of o.legs ?? []) if (!byId.has(leg.id)) byId.set(leg.id, leg)

    // uncapped walk (large cap — 500+ orders can't produce more): filter by
    // exit time FIRST, then cap, so a date range gets its full share
    const matched = fm.trades.filter((t) => {
      const at = Date.parse(t.exitAt)
      if (!Number.isFinite(at)) return true // keep malformed-time trades out of the filter's blast radius
      if (Number.isFinite(fromMs) && at < fromMs) return false
      if (Number.isFinite(toMs) && at > toMs) return false
      return true
    })
    const trades = matched.slice(0, limit)
    // resolve algo run refs → strategy display names via the SHARED resolver
    // (refs are 8-char id prefixes so `startsWith` is unique in practice)
    const refs = [...new Set(trades.map((t) => t.runRef).filter((x): x is string => !!x))]
    const stratNames = await resolveRunStrategyNames(refs)
    const enriched: ClosedTrade[] = trades.map((t) => {
      const withStrat =
        t.source === 'algo' && t.runRef
          ? { ...t, strategy: stratNames.get(t.runRef) ?? 'Algo' }
          : t
      // v2.12.28 — close reason (exit order role/grammar + steward log)
      const exitOrder = byId.get(t.exitOrderIds[t.exitOrderIds.length - 1] ?? '')
      return { ...withStrat, reason: resolveTradeReason(withStrat, exitOrder, steward) }
    })

    // v2.12.28 — CANCELED/expired zero-fill orders (they used to vanish from
    // the Pending list without a trace). Edit-REPLACEMENTS (replaced_by set)
    // are excluded — every chart drag / steward amend produces one, pure
    // noise. Legs of a canceled UNFILLED family are folded into their
    // canceled parent row (the parent is the meaningful event; its TP/SL
    // plan died with it).
    const canceledRows: TradingOrder[] = orderList.filter(
      (o) =>
        (o.status === 'canceled' || o.status === 'expired') &&
        parseFloat(o.filled_qty || '0') === 0 &&
        !o.replaced_by,
    )
    const canceledParents = new Set(
      canceledRows.filter((o) => (o.legs?.length ?? 0) > 0 || o.order_class === 'bracket' || o.order_class === 'oto').map((o) => o.group_id ?? o.id),
    )
    const canceled: CanceledOrderRow[] = canceledRows
      .filter((o) => {
        // a leg whose family parent was itself canceled (unfilled entry) is
        // represented by the parent row — skip it here
        if (!o.group_id || !o.group_role) return true
        if (o.group_role === 'entry') return true
        return !canceledParents.has(o.group_id)
      })
      .sort((a, b) => new Date(b.updated_at || b.created_at || '').getTime() - new Date(a.updated_at || a.created_at || '').getTime())
      .slice(0, 60)
      .map((o) => ({
        id: o.id,
        symbol: displaySymbolOf(o),
        side: o.side === 'sell' ? ('sell' as const) : ('buy' as const),
        qty: parseFloat(o.qty || '0') || 0,
        price: Number.isFinite(parseFloat(o.limit_price ?? '')) && parseFloat(o.limit_price ?? '') > 0
          ? parseFloat(o.limit_price as string)
          : Number.isFinite(parseFloat(o.stop_price ?? '')) && parseFloat(o.stop_price ?? '') > 0
            ? parseFloat(o.stop_price as string)
            : null,
        type: o.type,
        status: o.status,
        createdAt: o.created_at ?? '',
        canceledAt: o.updated_at || o.created_at || '',
        source: (() => {
          const plan = parseCryptoPlan(o.client_order_id)
          return plan?.gridRef ? ('grid' as const) : plan?.runRef ? ('algo' as const) : plan?.aiRef ? ('ai' as const) : ('manual' as const)
        })(),
        reason: resolveCancelReason(o, steward),
      }))

    return NextResponse.json({ mode, trades: enriched, canceled, configured: true })
  } catch (e) {
    return handleError(e)
  }
}
