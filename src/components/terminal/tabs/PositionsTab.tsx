'use client'

// Positions console tab: account strip (balance, buying power, daily P&L,
// equity curve Hour..Year, full account details) + every open paper + live
// position in one table — symbol, market, side/qty, entry price, TP, SL,
// trailing, P&L — with a per-row close button (market-close via the Alpaca
// Trading API). Below it: every PENDING (unfilled) entry order with its
// planned TP/SL — click any price to edit it (same PATCH the chart drags
// use) — and a cancel action. Missing TP/SL cells offer a [+ TP]/[+ SL]
// button that attaches the exit to the position (drag-to-price also exists
// on the chart).
import { useCallback, useEffect, useState } from 'react'
import { History, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice, fmtHeldDuration, ClosedTrade } from '@/lib/market-types'
import { ExitInfo, PendingOrderInfo, PositionRow, normSym } from '@/components/chart/trading-types'
import AccountOverview from './AccountOverview'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'

interface ModeData {
  mode: Mode
  positions: PositionRow[]
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
  pos: PositionRow
  sl?: ExitInfo
  tp?: ExitInfo
}

const MODES: Mode[] = ['paper', 'live']

export default function PositionsTab() {
  const { toast } = useToast()
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
          positions: (json.positions || []) as PositionRow[],
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

      {/* positions table — grows/shrinks with the available screen height
          so taller screens reveal more rows (min keeps it usable on small
          viewports, where the root scrolls instead) */}
      <div className="flex min-h-[150px] flex-[5_1_auto] flex-col overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-900/70">
        <div className="min-h-0 flex-1 overflow-auto terminal-scroll">
        <table className="w-full min-w-[900px] border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 text-left font-semibold">Symbol</th>
              <th className="px-3 py-2 text-left font-semibold">Market</th>
              <th className="px-3 py-2 text-left font-semibold">Side</th>
              <th className="px-3 py-2 text-right font-semibold">Qty</th>
              <th className="px-3 py-2 text-right font-semibold">Entry price</th>
              <th className="px-3 py-2 text-right font-semibold">Last</th>
              <th className="px-3 py-2 text-right font-semibold">TP</th>
              <th className="px-3 py-2 text-right font-semibold">SL</th>
              <th className="px-3 py-2 text-right font-semibold">Trailing</th>
              <th className="px-3 py-2 text-right font-semibold">P&amp;L</th>
              <th className="px-3 py-2 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-zinc-500">
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
            {rows.map((r) => {
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
                  <td className={cn('px-3 py-2 font-medium', long ? 'text-emerald-400' : 'text-rose-400')}>
                    {long ? 'LONG' : 'SHORT'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{r.pos.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPrice(r.pos.avgEntry)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPrice(r.pos.current)}</td>
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
                      onClick={() => void closePosition(r)}
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

      {/* pending (unfilled) entry orders — height follows the screen too */}
      <div className="flex min-h-[130px] flex-[3_1_auto] flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70">
        <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Pending orders</span>
          <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">{pendingRows.length}</Badge>
          <span className="ml-auto text-[10px] text-zinc-600">unfilled entries · TP/SL plan shown until filled</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto terminal-scroll">
          <table className="w-full min-w-[820px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-3 py-1.5 text-left font-semibold">Symbol</th>
                <th className="px-3 py-1.5 text-left font-semibold">Market</th>
                <th className="px-3 py-1.5 text-left font-semibold">Side</th>
                <th className="px-3 py-1.5 text-left font-semibold">Type</th>
                <th className="px-3 py-1.5 text-right font-semibold">Qty</th>
                <th className="px-3 py-1.5 text-right font-semibold">Filled</th>
                <th className="px-3 py-1.5 text-right font-semibold">Limit</th>
                <th className="px-3 py-1.5 text-right font-semibold">TP</th>
                <th className="px-3 py-1.5 text-right font-semibold">SL</th>
                <th className="px-3 py-1.5 text-left font-semibold">Status</th>
                <th className="px-3 py-1.5 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {pendingRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-6 text-center text-zinc-600">
                    No pending orders.
                  </td>
                </tr>
              )}
              {pendingRows.map(({ mode, p }) => (
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

      {/* trade history — realized round-trips (FIFO-matched closed orders),
          sharing the remaining screen height with the tables above */}
      <div className="flex min-h-[130px] flex-[3_1_auto] flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70">
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
                <th className="px-3 py-1.5 text-left font-semibold">Closed</th>
                <th className="px-3 py-1.5 text-left font-semibold">Symbol</th>
                <th className="px-3 py-1.5 text-left font-semibold">Market</th>
                <th className="px-3 py-1.5 text-left font-semibold">Side</th>
                <th className="px-3 py-1.5 text-right font-semibold">Qty</th>
                <th className="px-3 py-1.5 text-right font-semibold">Entry</th>
                <th className="px-3 py-1.5 text-right font-semibold">Exit</th>
                <th className="px-3 py-1.5 text-right font-semibold">Held</th>
                <th className="px-3 py-1.5 text-right font-semibold">P&amp;L</th>
                <th className="px-3 py-1.5 text-right font-semibold">%</th>
              </tr>
            </thead>
            <tbody>
              {historyRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-zinc-600">
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
              {historyRows.map(({ mode, t }) => {
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
        Close submits a market order for the full position · refreshes every 10s · TP/SL edits on the chart (drag lines) apply to these orders · [+TP]/[+SL] attaches a new exit to the position · Trade history pairs each entry fill with its exit fills (FIFO) to compute realized P&amp;L.
      </p>
    </div>
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
