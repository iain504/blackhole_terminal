'use client'

// Positions console tab: account strip (balance, buying power, daily P&L,
// equity curve Hour..Year, full account details) + every open paper + live
// position in one table — symbol, market, source, side/qty, entry price,
// opened, last, TP, SL, trailing, P&L — with a per-row close button (market
// close via the Alpaca Trading API). Below it: every PENDING (unfilled) entry
// order with its planned TP/SL — click any price to edit it (same PATCH the
// chart drags use) — and a cancel action. Missing TP/SL cells offer a
// [+ TP]/[+ SL] button that attaches the exit to the position (drag-to-price
// also exists on the chart).
// Task 52.2: the three panels (Positions / Pending orders / Trade history)
// are separated by DRAGGABLE splitters — the flex weights persist in the
// layout blob (autosave + config export/import). Task 52.3: every table's
// columns sort asc/desc by clicking the header (click again cycles desc →
// back to the default order). Task 70: positions gained OPENED (oldest
// still-open FIFO entry lot) + SOURCE badges; pending orders gained PLACED.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, History, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice, fmtHeldDuration, ClosedTrade } from '@/lib/market-types'
import { ExitInfo, PendingOrderInfo, PositionRow, normSym } from '@/components/chart/trading-types'
import { useTerminal } from '@/store/terminal'
import AccountOverview from './AccountOverview'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'

interface ModeData {
  mode: Mode
  positions: PositionRowExt[]
  exits: Record<string, { sl?: ExitInfo; tp?: ExitInfo }>
  pending: PendingOrderInfo[]
  error?: string
  loaded: boolean
}

interface HistoryData {
  trades: ClosedTrade[]
  configured: boolean
  loaded: boolean
  error?: string
}

interface PosConsoleRow {
  mode: Mode
  pos: PositionRowExt
  sl?: ExitInfo
  tp?: ExitInfo
}

/** Position row + open-lot attribution fields (OPENED / SOURCE — served by
 * /api/trading/positions from the FIFO matcher's oldest open entry lot;
 * kept as a local extension so the shared trading-types file stays stable). */
type PositionRowExt = PositionRow & {
  openedAt?: string | null
  source?: 'manual' | 'algo' | 'grid'
  strategy?: string
}

const MODES: Mode[] = ['paper', 'live']

// panel minimum heights (px) — keep all three tables usable on short screens
const PANEL_MIN_PX = [150, 130, 130] as const

type SortState = { key: string; dir: 1 | -1 } | null

/** Cycle a column's sort state: asc → desc → default (null). */
const nextSort = (cur: SortState, key: string): SortState =>
  cur?.key === key ? (cur.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }

/** Generic stable sort by a derived value; nulls always sink to the bottom. */
function sortRows<T>(arr: T[], sort: SortState, val: (r: T) => string | number | null): T[] {
  if (!sort) return arr
  const mul = sort.dir
  return [...arr].sort((x, y) => {
    const a = val(x)
    const b = val(y)
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * mul
    return String(a).localeCompare(String(b)) * mul
  })
}

const numOr = (v: string | number | null | undefined): number =>
  typeof v === 'number' ? v : parseFloat(String(v ?? '')) || 0

/** Whole shares print bare; fractional crypto qty trims float noise (0.157800004 → 0.1578). */
function fmtQtyLabel(n: number): string {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(6))
}

/** Compact "21 Oct, 16:39" datetime — same style as the history table's
 * Closed column; full ISO rides in the cell's title/tooltip. */
function fmtCompactDT(iso: string | null | undefined): string {
  const t = iso != null ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** Manual / Algo / Grid source badge (Task 65, grid in Task 10-k): algo rows
 *  show which strategy placed it, grid rows an emerald Grid tag. Task 79 — an
 *  UNKNOWN source (no open entry lot in the recent closed-orders window,
 *  e.g. an old position or a pre-dating fill) used to render as "Manual" — a
 *  wrong attribution. It now shows a dim "—" like other unknown columns;
 *  only a decoded `ttb-`/external coid renders "Manual". */
function SourceBadge({ source, strategy }: { source: 'manual' | 'algo' | 'grid' | undefined; strategy?: string }) {
  if (source === 'algo') {
    return (
      <Badge
        variant="outline"
        className="border-violet-500/40 bg-violet-500/10 text-[10px] text-violet-300"
        title={strategy ? `Placed by the ${strategy} algo run` : 'Placed by an algo run'}
      >
        {strategy ? `Algo · ${strategy}` : 'Algo'}
      </Badge>
    )
  }
  if (source === 'grid') {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-300"
        title="Placed by a grid trade"
      >
        Grid
      </Badge>
    )
  }
  if (source == null) {
    return (
      <Badge
        variant="outline"
        className="border-zinc-800 text-[10px] text-zinc-600"
        title="Source unknown — the entry fill is outside the recent closed-orders window, or the order predates source tagging"
      >
        —
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400" title="Placed manually from the chart / ticket">
      Manual
    </Badge>
  )
}

export default function PositionsTab() {
  const { toast } = useToast()
  const panelSizes = useTerminal((s) => s.positionsPanelSizes)
  const commitPanelSizes = useTerminal((s) => s.setPositionsPanelSizes)
  const [data, setData] = useState<Record<Mode, ModeData>>({
    paper: { mode: 'paper', positions: [], exits: {}, pending: [], loaded: false },
    live: { mode: 'live', positions: [], exits: {}, pending: [], loaded: false },
  })
  const [history, setHistory] = useState<Record<Mode, HistoryData>>({
    paper: { trades: [], configured: true, loaded: false },
    live: { trades: [], configured: true, loaded: false },
  })
  const [refreshing, setRefreshing] = useState(false)
  const [closing, setClosing] = useState<string | null>(null) // `${mode}:${symbol}`
  const [canceling, setCanceling] = useState<string | null>(null)
  // Task 4-c: the row pending close-confirmation (a market close must never be
  // a single misclick — the dialog states the symbol + qty before the order)
  const [confirmCloseRow, setConfirmCloseRow] = useState<PosConsoleRow | null>(null)

  // ---- Task 52.2: draggable panel splitters ----
  // Local (live) weights during a drag; the store copy is committed on release.
  const [dragSizes, setDragSizes] = useState<[number, number, number] | null>(null)
  const sizes = dragSizes ?? panelSizes
  const panelRefs = [useRef<HTMLDivElement | null>(null), useRef<HTMLDivElement | null>(null), useRef<HTMLDivElement | null>(null)]
  const dragRef = useRef<{
    splitter: 0 | 1
    startY: number
    h: [number, number, number]
    pxPerW: number
  } | null>(null)

  const beginDrag = (splitter: 0 | 1) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const h = panelRefs.map((r) => r.current?.offsetHeight ?? 0) as [number, number, number]
    const total = h[0] + h[1] + h[2]
    if (!(total > 0)) return
    const totalW = sizes[0] + sizes[1] + sizes[2]
    dragRef.current = { splitter, startY: e.clientY, h, pxPerW: total / totalW }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.startY
    const min0 = PANEL_MIN_PX[0] / d.pxPerW
    const min1 = PANEL_MIN_PX[1] / d.pxPerW
    const min2 = PANEL_MIN_PX[2] / d.pxPerW
    const round = (n: number) => Math.round(n * 100) / 100
    if (d.splitter === 0) {
      const h01 = d.h[0] + d.h[1]
      const w0 = Math.min(Math.max((d.h[0] + dy) / d.pxPerW, min0), (h01 / d.pxPerW) - min1)
      const w1 = h01 / d.pxPerW - w0
      setDragSizes([round(w0), round(w1), sizes[2]])
    } else {
      const h12 = d.h[1] + d.h[2]
      const w1 = Math.min(Math.max((d.h[1] + dy) / d.pxPerW, min1), (h12 / d.pxPerW) - min2)
      const w2 = h12 / d.pxPerW - w1
      setDragSizes([sizes[0], round(w1), round(w2)])
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    // release is automatic on real pointerup; guard anyway (synthetic events
    // can throw NotFoundError and must NOT skip the commit below)
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch { /* not captured */ }
    if (dragSizes) commitPanelSizes(dragSizes)
    setDragSizes(null)
  }

  // keyboard support for the splitters (accessibility): ±0.5 weight swapped
  // with the neighbouring panel, clamped so nothing collapses below minimums
  const nudge = (splitter: 0 | 1, dir: 1 | -1) => {
    const step = 0.5 * dir
    if (splitter === 0) {
      const w0 = Math.max(0.5, sizes[0] + step)
      const w1 = Math.max(0.5, sizes[1] - step)
      if (w0 === sizes[0] || w1 === sizes[1]) return
      commitPanelSizes([w0, w1, sizes[2]])
    } else {
      const w1 = Math.max(0.5, sizes[1] + step)
      const w2 = Math.max(0.5, sizes[2] - step)
      if (w1 === sizes[1] || w2 === sizes[2]) return
      commitPanelSizes([sizes[0], w1, w2])
    }
  }

  // ---- Task 52.3: per-table sort states ----
  const [posSort, setPosSort] = useState<SortState>(null)
  const [pendSort, setPendSort] = useState<SortState>(null)
  const [histSort, setHistSort] = useState<SortState>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const one = async (mode: Mode): Promise<ModeData> => {
      try {
        const res = await fetch(`/api/trading/positions?mode=${mode}`)
        if (!res.ok) {
          return { mode, positions: [], exits: {}, pending: [], error: `HTTP ${res.status}`, loaded: true }
        }
        const json = await res.json()
        const errs: string[] | undefined = json.errors
        return {
          mode,
          positions: (json.positions || []) as PositionRowExt[],
          exits: (json.exits || {}) as Record<string, { sl?: ExitInfo; tp?: ExitInfo }>,
          pending: (json.pending || []) as PendingOrderInfo[],
          error: errs?.length ? errs.join(', ') : undefined,
          loaded: true,
        }
      } catch {
        return { mode, positions: [], exits: {}, pending: [], error: 'network error', loaded: true }
      }
    }
    const hist = async (mode: Mode): Promise<HistoryData> => {
      try {
        const res = await fetch(`/api/trading/history?mode=${mode}&limit=150`)
        if (!res.ok) return { trades: [], configured: true, loaded: true, error: `HTTP ${res.status}` }
        const json = await res.json()
        return { trades: (json.trades || []) as ClosedTrade[], configured: json.configured !== false, loaded: true }
      } catch {
        return { trades: [], configured: true, loaded: true, error: 'network error' }
      }
    }
    const [paper, live] = await Promise.all(MODES.map(one))
    const [hPaper, hLive] = await Promise.all(MODES.map(hist))
    setData({ paper, live })
    setHistory({ paper: hPaper, live: hLive })
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    const onChanged = () => void refresh()
    window.addEventListener('tt:positions-changed', onChanged)
    window.addEventListener('tt:settings-changed', onChanged)
    return () => {
      clearInterval(timer)
      window.removeEventListener('tt:positions-changed', onChanged)
      window.removeEventListener('tt:settings-changed', onChanged)
    }
  }, [refresh])

  const rows: PosConsoleRow[] = MODES.flatMap((m) =>
    (data[m].positions || []).map((pos) => ({
      mode: m,
      pos,
      sl: data[m].exits[normSym(pos.tradeSymbol)]?.sl,
      tp: data[m].exits[normSym(pos.tradeSymbol)]?.tp,
    })),
  )
  const pendingRows = MODES.flatMap((m) => (data[m].pending || []).map((p) => ({ mode: m as Mode, p })))
  // realized round-trips across both modes (newest first from the API)
  const historyRows = MODES.flatMap((m) =>
    (history[m].trades || []).map((t) => ({ mode: m as Mode, t })),
  ).sort((a, b) => new Date(b.t.exitAt).getTime() - new Date(a.t.exitAt).getTime())
  // applied sorts (52.3)
  const sortedRows = sortRows(rows, posSort, (r) => {
    switch (posSort?.key) {
      case 'symbol': return r.pos.symbol
      case 'market': return r.mode
      case 'source': return r.pos.source ?? null
      case 'side': return r.pos.side
      case 'qty': return Math.abs(numOr(r.pos.qty))
      case 'entry': return r.pos.avgEntry
      case 'last': return r.pos.current
      case 'opened': return r.pos.openedAt ? new Date(r.pos.openedAt).getTime() : null
      case 'tp': return r.tp?.limitPrice ?? null
      case 'sl': return r.sl?.stopPrice ?? r.sl?.limitPrice ?? null
      case 'trailing': return r.sl?.trailPercent ?? null
      case 'pnl': return r.pos.upl
      default: return null
    }
  })
  const sortedPending = sortRows(pendingRows, pendSort, ({ mode, p }) => {
    switch (pendSort?.key) {
      case 'symbol': return p.symbol
      case 'market': return mode
      case 'side': return p.side
      case 'type': return p.type
      case 'qty': return numOr(p.qty)
      case 'filled': return numOr(p.filledQty)
      case 'limit': return p.limitPrice ?? null
      case 'tp': return p.tpPrice ?? null
      case 'sl': return p.slPrice ?? null
      case 'status': return p.status
      case 'placed': return p.createdAt ? new Date(p.createdAt).getTime() || null : null
      default: return null
    }
  })
  const sortedHistory = sortRows(historyRows, histSort, ({ mode, t }) => {
    switch (histSort?.key) {
      case 'closed': return new Date(t.exitAt).getTime()
      case 'symbol': return t.symbol
      case 'market': return mode
      case 'side': return t.side
      case 'qty': return numOr(t.qty)
      case 'entry': return t.entryPrice
      case 'exit': return t.exitPrice
      case 'held': return t.durationMs
      case 'pnl': return t.pnl
      case 'pct': return t.pnlPct
      default: return null
    }
  })
  const historyPnl = historyRows.reduce((acc, r) => acc + r.t.pnl, 0)
  const noKeys = (m: Mode) => data[m].loaded && data[m].error === 'no-keys'

  const closePosition = async (row: PosConsoleRow) => {
    const key = `${row.mode}:${row.pos.tradeSymbol}`
    setClosing(key)
    try {
      const res = await fetch(
        `/api/trading/positions/${encodeURIComponent(row.pos.tradeSymbol)}?mode=${row.mode}`,
        { method: 'DELETE' },
      )
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: `Closing ${row.pos.tradeSymbol} (${row.mode})`, description: 'Market close submitted' })
      } else {
        toast({ title: 'Close failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Close failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setClosing(null)
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      void refresh()
    }
  }

  const cancelPending = async (mode: Mode, orderId: string, label: string) => {
    setCanceling(orderId)
    try {
      const res = await fetch(`/api/trading/orders/${orderId}?mode=${mode}`, { method: 'DELETE' })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: `Cancelled ${label}` })
      } else {
        toast({ title: 'Cancel failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Cancel failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setCanceling(null)
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      void refresh()
    }
  }

  const totals = rows.reduce(
    (acc, r) => ({ upl: acc.upl + r.pos.upl, count: acc.count + 1 }),
    { upl: 0, count: 0 },
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 terminal-scroll">
      {/* account strip: balance, buying power, daily P&L, equity curve, details */}
      <AccountOverview />

      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
        <span className="text-sm font-semibold text-zinc-100">Positions</span>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
          {totals.count} open
        </Badge>
        <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-400">
          {pendingRows.length} pending
        </Badge>
        <Badge
          variant="outline"
          className="border-zinc-700 text-[10px] text-zinc-400"
          title="Realized round-trip trades in the history group below"
        >
          <History className="mr-1 inline h-3 w-3" aria-hidden />
          {historyRows.length} closed
        </Badge>
        {historyRows.length > 0 && (
          <span
            className={cn('text-sm font-semibold tabular-nums', historyPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}
            title="Realized P&L of the trades in the history group below"
          >
            {historyPnl >= 0 ? '+' : '−'}${Math.abs(historyPnl).toFixed(2)} realized
          </span>
        )}
        <span className={cn('text-sm font-semibold tabular-nums', totals.upl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
          {totals.upl >= 0 ? '+' : '−'}${Math.abs(totals.upl).toFixed(2)} unrealized
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {MODES.map((m) => (
            <Badge
              key={m}
              variant="outline"
              className={cn(
                'text-[10px]',
                m === 'live'
                  ? 'border-amber-500/40 text-amber-400'
                  : 'border-emerald-500/40 text-emerald-400',
              )}
              title={noKeys(m) ? `No Alpaca keys can serve ${m} — add them in Settings` : `${data[m].positions.length} position(s)`}
            >
              {m}
              {noKeys(m) ? ' · no keys' : ''}
            </Badge>
          ))}
          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-zinc-100" onClick={() => void refresh()} aria-label="Refresh positions">
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* positions table — height follows the draggable splitter weights
          (persisted in the layout blob: autosave + export/import) */}
      <div
        ref={panelRefs[0]}
        style={{ flex: `${sizes[0]} 1 0%` }}
        className="flex min-h-[150px] flex-col overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-900/70"
      >
        <div className="min-h-0 flex-1 overflow-auto terminal-scroll">
        <table className="w-full min-w-[1060px] border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr className="border-b border-zinc-800">
              <SortTh label="Symbol" k="symbol" sort={posSort} onSort={setPosSort} />
              <SortTh label="Market" k="market" sort={posSort} onSort={setPosSort} />
              <SortTh label="Source" k="source" sort={posSort} onSort={setPosSort} />
              <SortTh label="Side" k="side" sort={posSort} onSort={setPosSort} />
              <SortTh label="Qty" k="qty" sort={posSort} onSort={setPosSort} align="right" />
              <SortTh label="Entry price" k="entry" sort={posSort} onSort={setPosSort} align="right" />
              <SortTh label="Last" k="last" sort={posSort} onSort={setPosSort} align="right" />
              <SortTh label="Opened" k="opened" sort={posSort} onSort={setPosSort} />
              <SortTh label="TP" k="tp" sort={posSort} onSort={setPosSort} align="right" />
              <SortTh label="SL" k="sl" sort={posSort} onSort={setPosSort} align="right" />
              <SortTh label="Trailing" k="trailing" sort={posSort} onSort={setPosSort} align="right" />
              <SortTh label="P&L" k="pnl" sort={posSort} onSort={setPosSort} align="right" />
              <th className="px-3 py-2 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-3 py-10 text-center text-zinc-500">
                  {data.paper.loaded && data.live.loaded ? (
                    <>
                      No open positions on paper or live.
                      <span className="mt-1 block text-[11px] text-zinc-600">
                        Place a trade from the chart (right-click → trade ticket) and it appears here.
                      </span>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading positions…</span>
                  )}
                </td>
              </tr>
            )}
            {sortedRows.map((r) => {
              const key = `${r.mode}:${r.pos.tradeSymbol}`
              const long = r.pos.side === 'long'
              const up = r.pos.upl >= 0
              const trailing = r.sl?.type === 'trailing_stop' ? `${r.sl.trailPercent ?? '—'}%` : null
              return (
                <tr key={key} className="border-b border-zinc-800/60 transition-colors hover:bg-zinc-800/40">
                  <td className="px-3 py-2 font-semibold text-zinc-100">{r.pos.symbol}</td>
                  <td className="px-3 py-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px]',
                        r.mode === 'live' ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400',
                      )}
                    >
                      {r.mode}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {r.pos.source ? (
                      <SourceBadge source={r.pos.source} strategy={r.pos.strategy} />
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className={cn('px-3 py-2 font-medium', long ? 'text-emerald-400' : 'text-rose-400')}>
                    {long ? 'LONG' : 'SHORT'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{r.pos.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPrice(r.pos.avgEntry)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPrice(r.pos.current)}</td>
                  <td
                    className="whitespace-nowrap px-3 py-2 text-zinc-400"
                    title={r.pos.openedAt ? `Entry fill ${r.pos.openedAt}` : undefined}
                  >
                    {r.pos.openedAt ? (
                      fmtCompactDT(r.pos.openedAt)
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-300">
                    {r.tp?.limitPrice != null ? (
                      fmtPrice(r.tp.limitPrice)
                    ) : (
                      <AddExitCell mode={r.mode} tradeSymbol={r.pos.tradeSymbol} kind="tp" onAdded={() => void refresh()} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-rose-300">
                    {r.sl && (r.sl.stopPrice != null || r.sl.limitPrice != null) ? (
                      fmtPrice((r.sl.stopPrice ?? r.sl.limitPrice)!)
                    ) : (
                      <AddExitCell mode={r.mode} tradeSymbol={r.pos.tradeSymbol} kind="sl" onAdded={() => void refresh()} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-300">
                    {trailing ?? <span className="text-zinc-600">—</span>}
                  </td>
                  <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', up ? 'text-emerald-400' : 'text-rose-400')}>
                    {up ? '+' : '−'}${Math.abs(r.pos.upl).toFixed(2)}
                    <span className="ml-1 text-[10px] font-normal opacity-80">
                      ({up ? '+' : '−'}{Math.abs(r.pos.uplPct).toFixed(2)}%)
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      className="h-6 border border-rose-500/40 bg-rose-500/10 px-2 text-[11px] font-semibold text-rose-400 hover:bg-rose-500/20 hover:text-rose-300"
                      disabled={closing === key}
                      onClick={() => setConfirmCloseRow(r)}
                      aria-label={`Close ${r.mode} position ${r.pos.tradeSymbol}`}
                    >
                      {closing === key ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Close position'}
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* draggable splitter between Positions and Pending orders */}
      <PanelSplitter
        label="Resize Positions and Pending orders panels"
        onPointerDown={beginDrag(0)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onKeyDown={(dir) => nudge(0, dir)}
      />

      {/* pending (unfilled) entry orders */}
      <div
        ref={panelRefs[1]}
        style={{ flex: `${sizes[1]} 1 0%` }}
        className="flex min-h-[130px] flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Pending orders</span>
          <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">{pendingRows.length}</Badge>
          <span className="ml-auto text-[10px] text-zinc-600">unfilled entries · TP/SL plan shown until filled</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto terminal-scroll">
          <table className="w-full min-w-[920px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-800">
                <SortTh label="Symbol" k="symbol" sort={pendSort} onSort={setPendSort} />
                <SortTh label="Market" k="market" sort={pendSort} onSort={setPendSort} />
                <SortTh label="Source" k="source" sort={pendSort} onSort={setPendSort} />
                <SortTh label="Side" k="side" sort={pendSort} onSort={setPendSort} />
                <SortTh label="Type" k="type" sort={pendSort} onSort={setPendSort} />
                <SortTh label="Qty" k="qty" sort={pendSort} onSort={setPendSort} align="right" />
                <SortTh label="Filled" k="filled" sort={pendSort} onSort={setPendSort} align="right" />
                <SortTh label="Limit" k="limit" sort={pendSort} onSort={setPendSort} align="right" />
                <SortTh label="TP" k="tp" sort={pendSort} onSort={setPendSort} align="right" />
                <SortTh label="SL" k="sl" sort={pendSort} onSort={setPendSort} align="right" />
                <SortTh label="Status" k="status" sort={pendSort} onSort={setPendSort} />
                <SortTh label="Placed" k="placed" sort={pendSort} onSort={setPendSort} />
                <th className="px-3 py-1.5 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedPending.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-3 py-6 text-center text-zinc-600">
                    No pending orders.
                  </td>
                </tr>
              )}
              {sortedPending.map(({ mode, p }) => (
                <tr key={`${mode}:${p.orderId}`} className="border-b border-zinc-800/60 transition-colors hover:bg-zinc-800/40">
                  <td className="px-3 py-1.5 font-semibold text-zinc-100">{p.symbol}</td>
                  <td className="px-3 py-1.5">
                    <Badge
                      variant="outline"
                      className={cn('text-[10px]', mode === 'live' ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400')}
                    >
                      {mode}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5">
                    <SourceBadge source={p.source} strategy={p.strategy} />
                  </td>
                  <td className={cn('px-3 py-1.5 font-medium', p.side === 'buy' ? 'text-emerald-400' : 'text-rose-400')}>
                    {p.side.toUpperCase()}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-300">
                    {p.type.toUpperCase()}
                    {p.managed ? <span className="ml-1 text-[9px] text-amber-400/80">OCO</span> : null}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{p.qty}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-500">{p.filledQty || '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                    {p.type === 'limit' || p.limitPrice != null ? (
                      <PendingPriceCell mode={mode} p={p} field="entry" onSaved={() => void refresh()} />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">
                    <PendingPriceCell mode={mode} p={p} field="tp" onSaved={() => void refresh()} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-rose-300">
                    <PendingPriceCell mode={mode} p={p} field="sl" onSaved={() => void refresh()} />
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400">{p.status}</td>
                  <td
                    className="whitespace-nowrap px-3 py-1.5 text-zinc-400"
                    title={p.createdAt ? `Placed ${p.createdAt}` : undefined}
                  >
                    {p.createdAt ? (
                      fmtCompactDT(p.createdAt)
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Button
                      size="sm"
                      className="h-5 border border-zinc-700 bg-transparent px-2 text-[10px] font-semibold text-zinc-400 hover:bg-rose-500/10 hover:text-rose-400"
                      disabled={canceling === p.orderId}
                      onClick={() => void cancelPending(mode, p.orderId, `${p.side} ${p.type} ${p.symbol}`)}
                      aria-label={`Cancel pending ${p.side} ${p.type} ${p.symbol}`}
                    >
                      {canceling === p.orderId ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Cancel'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* draggable splitter between Pending orders and Trade history */}
      <PanelSplitter
        label="Resize Pending orders and Trade history panels"
        onPointerDown={beginDrag(1)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onKeyDown={(dir) => nudge(1, dir)}
      />

      {/* trade history — realized round-trips (FIFO-matched closed orders) */}
      <div
        ref={panelRefs[2]}
        style={{ flex: `${sizes[2]} 1 0%` }}
        className="flex min-h-[130px] flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-1.5">
          <History className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Trade history</span>
          <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">{historyRows.length}</Badge>
          {historyRows.length > 0 && (
            <span
              className={cn(
                'text-[11px] font-semibold tabular-nums',
                historyPnl >= 0 ? 'text-emerald-400' : 'text-rose-400',
              )}
              title="Sum of realized P&L across the listed trades (paper + live)"
            >
              {historyPnl >= 0 ? '+' : '−'}${Math.abs(historyPnl).toFixed(2)}
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-600">realized round-trips · paper + live · FIFO-matched fills</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto terminal-scroll">
          <table className="w-full min-w-[860px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-800">
                <SortTh label="Closed" k="closed" sort={histSort} onSort={setHistSort} />
                <SortTh label="Symbol" k="symbol" sort={histSort} onSort={setHistSort} />
                <SortTh label="Market" k="market" sort={histSort} onSort={setHistSort} />
                <SortTh label="Source" k="source" sort={histSort} onSort={setHistSort} />
                <SortTh label="Side" k="side" sort={histSort} onSort={setHistSort} />
                <SortTh label="Qty" k="qty" sort={histSort} onSort={setHistSort} align="right" />
                <SortTh label="Entry" k="entry" sort={histSort} onSort={setHistSort} align="right" />
                <SortTh label="Exit" k="exit" sort={histSort} onSort={setHistSort} align="right" />
                <SortTh label="Held" k="held" sort={histSort} onSort={setHistSort} align="right" />
                <SortTh label="P&L" k="pnl" sort={histSort} onSort={setHistSort} align="right" />
                <SortTh label="%" k="pct" sort={histSort} onSort={setHistSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sortedHistory.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-6 text-center text-zinc-600">
                    {!history.paper.loaded && !history.live.loaded ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading trade history…</span>
                    ) : history.paper.configured === false && history.live.configured === false ? (
                      'No Alpaca keys configured — trade history unavailable.'
                    ) : (
                      'No closed trades yet — completed round-trips (entry + exit filled) appear here with their realized P&L.'
                    )}
                  </td>
                </tr>
              )}
              {sortedHistory.map(({ mode, t }) => {
                const up = t.pnl >= 0
                return (
                  <tr key={`${mode}:${t.id}`} className="border-b border-zinc-800/60 transition-colors hover:bg-zinc-800/40">
                    <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">
                      {new Date(t.exitAt).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
                      })}
                    </td>
                    <td className="px-3 py-1.5 font-semibold text-zinc-100">{t.symbol}</td>
                    <td className="px-3 py-1.5">
                      <Badge
                        variant="outline"
                        className={cn('text-[10px]', mode === 'live' ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400')}
                      >
                        {mode}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5">
                      <SourceBadge source={t.source} strategy={t.strategy} />
                    </td>
                    <td className={cn('px-3 py-1.5 font-medium', t.side === 'long' ? 'text-emerald-400' : 'text-rose-400')}>
                      {t.side === 'long' ? 'LONG' : 'SHORT'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{t.qty}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{fmtPrice(t.entryPrice)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{fmtPrice(t.exitPrice)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-500">{fmtHeldDuration(t.durationMs)}</td>
                    <td className={cn('px-3 py-1.5 text-right font-semibold tabular-nums', up ? 'text-emerald-400' : 'text-rose-400')}>
                      {up ? '+' : '−'}${Math.abs(t.pnl).toFixed(2)}
                    </td>
                    <td className={cn('px-3 py-1.5 text-right tabular-nums', up ? 'text-emerald-400/80' : 'text-rose-400/80')}>
                      {up ? '+' : '−'}{Math.abs(t.pnlPct).toFixed(2)}%
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="flex shrink-0 items-center gap-1.5 px-1 text-[11px] text-zinc-600">
        <X className="h-3 w-3" aria-hidden />
        Drag the ── handles to resize the panels (saved with your layout) · click a column header to sort asc/desc · Close submits a market order for the full position · refreshes every 10s · [+TP]/[+SL] attaches a new exit to the position · Trade history pairs each entry fill with its exit fills (FIFO) to compute realized P&amp;L.
      </p>

      {/* Task 4-c: close-position confirmation — restates symbol + qty so the
          market order is never one misclick away. The existing close logic and
          the row's spinner state are untouched inside the confirm handler. */}
      <AlertDialog
        open={confirmCloseRow != null}
        onOpenChange={(o) => { if (!o) setConfirmCloseRow(null) }}
      >
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-zinc-100">
              Close {confirmCloseRow?.pos.tradeSymbol ?? ''} position?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              This places a market order for{' '}
              <span className="font-semibold text-zinc-200">
                {confirmCloseRow ? fmtQtyLabel(Math.abs(numOr(confirmCloseRow.pos.qty))) : '0'}
              </span>{' '}
              units{confirmCloseRow ? ` (${confirmCloseRow.mode} account)` : ''} and closes the full position at the market price.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={() => {
                const row = confirmCloseRow
                setConfirmCloseRow(null)
                if (row) void closePosition(row)
              }}
            >
              Close position
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Thin draggable divider between two panels (Task 52.2). Pointer-drag
 * adjusts the flex weights; ↑/↓ arrows nudge for keyboard users. */
function PanelSplitter({ label, onPointerDown, onPointerMove, onPointerUp, onKeyDown }: {
  label: string
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
  onKeyDown: (dir: 1 | -1) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          onKeyDown(-1)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          onKeyDown(1)
        }
      }}
      className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center rounded outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60"
    >
      <div className="h-1 w-12 rounded-full bg-zinc-800 transition-colors group-hover:bg-emerald-500/50 group-focus-visible:bg-emerald-500/60" />
    </div>
  )
}

/** Sortable table header cell (Task 52.3): click cycles asc → desc → off. */
function SortTh({ label, k, sort, onSort, align = 'left' }: {
  label: string
  k: string
  sort: SortState
  onSort: (s: SortState) => void
  align?: 'left' | 'right'
}) {
  const active = sort?.key === k
  return (
    <th
      className={cn('px-3 py-1.5 font-semibold', align === 'right' ? 'text-right' : 'text-left')}
      aria-sort={active ? (sort?.dir === 1 ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, k))}
        aria-label={`Sort by ${label}${active ? (sort?.dir === 1 ? ' (ascending — click for descending)' : ' (descending — click to reset)') : ''}`}
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wider text-[10px] transition-colors hover:text-zinc-200',
          active ? 'text-emerald-400' : 'text-zinc-500',
        )}
      >
        {label}
        {active ? (
          sort?.dir === 1 ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  )
}

/** Click-to-edit price cell for a pending order's entry limit / TP / SL.
 * PATCHes the same endpoint the chart's line-drag uses. */
function PendingPriceCell({ mode, p, field, onSaved }: {
  mode: Mode
  p: PendingOrderInfo
  field: 'entry' | 'tp' | 'sl'
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const value = field === 'entry' ? p.limitPrice : field === 'tp' ? p.tpPrice : p.slPrice

  const save = async () => {
    const price = parseFloat(v)
    if (!Number.isFinite(price) || price <= 0) return
    setBusy(true)
    try {
      const body: Record<string, unknown> = { mode, crypto: p.symbol.includes('/') }
      if (field === 'entry') body.entry_limit = price
      else if (field === 'tp') body.tp_price = price
      else body.sl_price = price
      const res = await fetch(`/api/trading/orders/${p.orderId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({
          title: `${field === 'entry' ? 'Entry' : field.toUpperCase()} updated to ${fmtPrice(price)}`,
          description: json?.method === 'cancel-replace' ? 'Order re-created on Alpaca (new id)' : json?.note || undefined,
        })
      } else {
        toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Update failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusy(false)
      setOpen(false)
      onSaved()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
    }
  }

  if (!open) {
    return (
      <button
        className="tabular-nums underline-offset-2 transition-colors hover:text-emerald-300 hover:underline decoration-dashed"
        onClick={() => { setV(value != null ? String(value) : ''); setOpen(true) }}
        aria-label={`Edit ${field === 'entry' ? 'entry limit' : field.toUpperCase()} of pending ${p.side} ${p.symbol}`}
        title={`Click to change the ${field === 'entry' ? 'entry limit' : field.toUpperCase()} price`}
      >
        {value != null ? fmtPrice(value) : <span className="text-zinc-600">—</span>}
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        autoFocus
        type="number"
        step="any"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') setOpen(false)
        }}
        className="h-6 w-24 border-zinc-700 bg-zinc-950 text-[11px]"
        aria-label={`${field === 'entry' ? 'Entry limit' : field.toUpperCase()} price`}
      />
      <button
        className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300"
        onClick={() => void save()}
        disabled={busy}
        aria-label="Apply price"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'OK'}
      </button>
      <button className="text-[10px] text-zinc-500 hover:text-zinc-300" onClick={() => setOpen(false)} aria-label="Cancel edit">
        ✕
      </button>
    </span>
  )
}

/** Small "+ TP"/"+ SL" button for a position row missing that exit — opens an
 * inline price input, POSTs to /positions/[symbol]/exits. */
function AddExitCell({ mode, tradeSymbol, kind, onAdded }: {
  mode: Mode
  tradeSymbol: string
  kind: 'tp' | 'sl'
  onAdded: () => void
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const price = parseFloat(v)
    if (!Number.isFinite(price) || price <= 0) return
    setBusy(true)
    try {
      const res = await fetch(`/api/trading/positions/${encodeURIComponent(tradeSymbol)}/exits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, [kind]: price }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({
          title: `${kind.toUpperCase()} added at ${fmtPrice(price)}`,
          description: json?.oco ? 'OCO exit created on Alpaca' : undefined,
        })
      } else {
        toast({ title: `${kind.toUpperCase()} failed`, description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Network error', variant: 'destructive' })
    } finally {
      setBusy(false)
      setOpen(false)
      setV('')
      onAdded()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
    }
  }

  if (!open) {
    return (
      <button
        className="rounded border border-dashed border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:border-zinc-500 hover:text-zinc-300"
        onClick={() => setOpen(true)}
        aria-label={`Add ${kind.toUpperCase()} to ${tradeSymbol}`}
        title={`Attach a ${kind.toUpperCase()} order to this position`}
      >
        + {kind.toUpperCase()}
      </button>
    )
  }
  return (
    <span className="relative inline-flex items-center gap-1">
      <Input
        autoFocus
        type="number"
        step="any"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder={`${kind.toUpperCase()} price`}
        className="h-6 w-28 border-zinc-700 bg-zinc-950 text-[11px]"
      />
      <button
        className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300"
        onClick={() => void submit()}
        disabled={busy}
        aria-label={`Apply ${kind.toUpperCase()}`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'OK'}
      </button>
      <button
        className="text-[10px] text-zinc-500 hover:text-zinc-300"
        onClick={() => setOpen(false)}
        aria-label="Cancel"
      >
        ✕
      </button>
    </span>
  )
}
