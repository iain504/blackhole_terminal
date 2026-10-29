'use client'

// Strategy Orders tab — full details for the conditional-order bot:
//   i)   the RULES: every strategy rule with its complete definition
//        (IF indicator condition · timeframe → THEN market buy/sell + TP/SL plan)
//   ii)  CURRENT P&L: live unrealized P&L of the open position on the rule's
//        symbol (strategy trade mode) · HISTORICAL P&L: realized P&L summed
//        over the trades the rule's fires produced
//   iii) HISTORICAL TRADES: per rule — the round-trip trades (FIFO-matched
//        from the broker's closed orders, attributed via each fire's entry
//        orderId) plus the full fire log
// Complements the 🤖 StrategyDrawer, which creates/arms the rules.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot, ChevronDown, ChevronRight, Loader2, RefreshCw, CheckCircle2, XCircle, Wrench,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice, fmtHeldDuration, ClosedTrade } from '@/lib/market-types'
import {
  StrategyRuleDetail, StrategiesHistoryData, PositionRow, normSym,
} from '@/components/chart/trading-types'
import { condSummary, statusBadgeCls, atrTfOf } from '../StrategyDrawer'
import { cn } from '@/lib/utils'
import { fmtAtrExit } from '@/lib/atr-client'

const money = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`
const pct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`

function relTime(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** TP/SL plan text from the rule config (pct shows %, price shows level,
 *  atr shows "1.5×ATR(1h)"). */
function exitText(mode: string, value: number | null, tf?: string | null): string {
  if (mode === 'atr' && value != null) return fmtAtrExit(value, tf)
  if (mode === 'pct' && value != null) return `${value >= 10 ? Math.round(value) : value}%`
  if (mode === 'price' && value != null) return fmtPrice(value)
  return '—'
}

export default function StrategyTab() {
  const { toast } = useToast()
  const [data, setData] = useState<StrategiesHistoryData | null>(null)
  // Task 94 — rules are pinned per rule, so the "current" P&L column reads
  // the position from the rule's OWN account: both tapes are fetched.
  // `unavailable` (review R-1#5) distinguishes "no position" from "can't
  // see the account" (keys missing/rejected) — rendering 'flat' for the
  // latter is a lie.
  const [posByMode, setPosByMode] = useState<Record<'paper' | 'live', { rows: PositionRow[]; unavailable: boolean }>>({
    paper: { rows: [], unavailable: false },
    live: { rows: [], unavailable: false },
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/strategies/history')
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
      } else {
        const json = (await res.json()) as StrategiesHistoryData
        setData(json)
        setError(null)
        // live P&L for the "current" column — per pinned account (Task 94)
        const [paperPos, livePos] = await Promise.all(
          (['paper', 'live'] as const).map(async (m): Promise<{ rows: PositionRow[]; unavailable: boolean }> => {
            try {
              const pres = await fetch(`/api/trading/positions?mode=${m}`)
              const pj = await pres.json().catch(() => ({}))
              // the positions route reports keysMissing/authError structurally
              // — either means "we cannot see this account", not "flat"
              const unavailable = !pres.ok || !!pj.keysMissing || !!pj.authError
              return { rows: (unavailable ? [] : (pj.positions || [])) as PositionRow[], unavailable }
            } catch {
              return { rows: [], unavailable: true }
            }
          }),
        )
        setPosByMode({ paper: paperPos, live: livePos })
      }
    } catch {
      setError('network error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 20000) // matches the strategy check cadence
    const onChanged = () => void load()
    window.addEventListener('tt:positions-changed', onChanged)
    return () => {
      clearInterval(timer)
      window.removeEventListener('tt:positions-changed', onChanged)
    }
  }, [load])

  const posMaps = useMemo(() => {
    const build = (rows: PositionRow[]) => {
      const m = new Map<string, PositionRow>()
      for (const p of rows) m.set(normSym(p.symbol), p)
      return m
    }
    return {
      paper: { map: build(posByMode.paper.rows), unavailable: posByMode.paper.unavailable },
      live: { map: build(posByMode.live.rows), unavailable: posByMode.live.unavailable },
    }
  }, [posByMode])

  const patch = async (id: string, body: Record<string, unknown>, label: string) => {
    setBusyId(id)
    try {
      const res = await fetch(`/api/strategies/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) toast({ title: label })
      else toast({ title: 'Update failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
    } catch {
      toast({ title: 'Update failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusyId(null)
      void load()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
    }
  }

  const remove = async (r: StrategyRuleDetail) => {
    setBusyId(r.id)
    try {
      const res = await fetch(`/api/strategies/${r.id}`, { method: 'DELETE' })
      if (res.ok) toast({ title: `Strategy deleted — ${r.symbol}` })
      else toast({ title: 'Delete failed', description: `HTTP ${res.status}`, variant: 'destructive' })
    } catch {
      toast({ title: 'Delete failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBusyId(null)
      void load()
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
    }
  }

  const rules = data?.rules ?? []
  const liveCount = rules.filter((r) => r.mode === 'live').length
  const totals = rules.reduce(
    (acc, r) => ({
      armed: acc.armed + (r.status === 'armed' ? 1 : 0),
      realized: acc.realized + r.realizedPnl,
      trades: acc.trades + r.tradeCount,
      fires: acc.fires + r.fires.length,
    }),
    { armed: 0, realized: 0, trades: 0, fires: 0 },
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 terminal-scroll">
      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
        <Bot className="h-4 w-4 text-violet-400" aria-hidden />
        <span className="text-sm font-semibold text-zinc-100">Strategy Orders</span>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
          {rules.length} rule{rules.length === 1 ? '' : 's'}
        </Badge>
        <Badge variant="outline" className="border-violet-500/40 text-[10px] text-violet-400">
          {totals.armed} armed
        </Badge>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
          {totals.fires} fire{totals.fires === 1 ? '' : 's'}
        </Badge>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
          {totals.trades} trade{totals.trades === 1 ? '' : 's'}
        </Badge>
        <span
          className={cn('text-sm font-semibold tabular-nums', totals.realized >= 0 ? 'text-emerald-400' : 'text-rose-400')}
          title="Realized P&L of all trades attributed to strategy fires"
        >
          {money(totals.realized)} realized
        </span>
        {data && (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px]',
              data.mode === 'live' ? 'border-amber-500/40 text-amber-400' : 'border-emerald-500/40 text-emerald-400',
            )}
            title="Your current Trade Mode — each rule fires on its own PINNED account (chip on each row), immune to this switch"
          >
            trade mode: {data.mode}
          </Badge>
        )}
        {liveCount > 0 && (
          <Badge
            variant="outline"
            className="border-amber-500/40 text-[10px] font-bold text-amber-400"
            title="Rules pinned to the LIVE account — real orders, real money"
          >
            {liveCount} live
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] text-violet-300 hover:bg-violet-500/10 hover:text-violet-200"
            onClick={() => window.dispatchEvent(new CustomEvent('tt:open-strategies'))}
            title="Open the strategy builder drawer"
          >
            <Wrench className="h-3.5 w-3.5" /> Builder
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-400 hover:text-zinc-100"
            onClick={() => void load()}
            aria-label="Refresh strategy details"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {error && (
        <p className="shrink-0 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-400">
          Failed to load strategy details — {error}
        </p>
      )}
      {data && (() => {
        // Task 94 — per-account tape availability: warn only for the accounts
        // that pinned rules actually need
        const hasPaper = rules.some((r) => r.mode !== 'live')
        const hasLive = rules.some((r) => r.mode === 'live')
        const miss: string[] = []
        if (hasPaper && data.paperConfigured === false) miss.push('paper')
        if (hasLive && data.liveConfigured === false) miss.push('LIVE')
        if (miss.length === 0) return null
        return (
          <p className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
            No Alpaca keys can serve the {miss.join(' / ')} account{miss.length > 1 ? 's' : ''} — or they were
            rejected (check Settings → API keys). Fire history and trade P&amp;L for those rules are unavailable
            until fixed.
          </p>
        )
      })()}

      {/* rules */}
      {rules.length === 0 && !error && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-zinc-800 bg-zinc-900/40 p-8 text-center">
          <Bot className="h-8 w-8 text-zinc-600" aria-hidden />
          <p className="max-w-md text-sm text-zinc-400">
            No strategy rules yet. A strategy is an automated conditional order —
            <span className="text-zinc-300"> IF</span> an indicator condition fires,
            <span className="text-zinc-300"> THEN</span> a market buy/sell is placed with its TP/SL (bracket).
          </p>
          <Button
            size="sm"
            className="bg-violet-600 text-xs text-white hover:bg-violet-500"
            onClick={() => window.dispatchEvent(new CustomEvent('tt:open-strategies'))}
          >
            🤖 Open Strategy builder
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {rules.map((r) => {
          const account: 'paper' | 'live' = r.mode === 'live' ? 'live' : 'paper'
          const posInfo = posMaps[account]
          const pos = posInfo.map.get(normSym(r.symbol))
          const open = expanded[r.id] ?? r.fires.length > 0
          const hasTp = r.tpMode !== 'none' && r.tpValue != null
          const hasSl = r.slMode !== 'none' && r.slValue != null
          return (
            <div key={r.id} className="flex flex-col rounded-md border border-zinc-800/80 bg-zinc-900/70">
              {/* ---- rule line ---- */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
                <Badge variant="outline" className={cn('shrink-0 text-[10px]', statusBadgeCls(r.status))}>
                  {r.status === 'placing' ? 'placing…' : r.status}
                </Badge>
                <span className="text-sm font-semibold text-zinc-100">{r.symbol}</span>
                {/* Task 94 — pinned account chip: amber LIVE / dim paper */}
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 text-[9px] font-bold uppercase',
                    r.mode === 'live' ? 'border-amber-500/40 text-amber-400' : 'border-zinc-700 text-zinc-500',
                  )}
                  title="The PINNED Alpaca account this rule fires on — immune to Trade Mode flips"
                >
                  {r.mode === 'live' ? 'LIVE' : 'paper'}
                </Badge>
                <span className={cn('font-semibold', r.action === 'sell' ? 'text-rose-400' : 'text-emerald-400')}>
                  {r.action.toUpperCase()} {r.qty} @ market
                </span>
                <span className="text-zinc-300" title="The rule's condition">
                  <span className="text-violet-400">IF</span> {condSummary(r)}
                </span>
                {(hasTp || hasSl) && (
                  <span className="text-zinc-400">
                    <span className="text-emerald-400/80">TP {exitText(r.tpMode, r.tpValue, atrTfOf(r, 'tp'))}</span>
                    {' · '}
                    <span className="text-rose-400/80">SL {exitText(r.slMode, r.slValue, atrTfOf(r, 'sl'))}</span>
                  </span>
                )}
                {r.repeat && (
                  <Badge variant="outline" className="border-violet-500/40 text-[10px] text-violet-400" title="Re-arms after every fire">
                    ∞ repeat
                  </Badge>
                )}
                <span className="text-[10px] text-zinc-600">armed {relTime(r.createdAt)}</span>
              </div>

              {/* ---- stats + actions line ---- */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800/60 px-3 py-1.5 text-[11px]">
                <span className="text-zinc-400">
                  Fires <span className="font-semibold text-zinc-200">{r.fires.length}</span>
                  {r.lastFireAt && <span className="ml-1 text-zinc-600">· last {relTime(r.lastFireAt)}</span>}
                </span>
                <span className="text-zinc-400">
                  Historical P&amp;L{' '}
                  <span className={cn('font-semibold tabular-nums', r.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                    {money(r.realizedPnl)}
                  </span>
                  <span className="ml-1 text-zinc-600">({r.tradeCount} trade{r.tradeCount === 1 ? '' : 's'})</span>
                  {r.unresolvedFires > 0 && (
                    <span
                      className="ml-1 text-zinc-600"
                      title={`${r.unresolvedFires} fire(s) whose entry order is not among the broker's recent closed orders (too old, still working, never filled — or the fire's account tape was unavailable)`}
                    >
                      · {r.unresolvedFires} unresolved
                    </span>
                  )}
                </span>
                <span className="text-zinc-400" title={`Live unrealized P&L of the open position on ${r.symbol} (${account === 'live' ? 'LIVE' : 'paper'} account) — includes positions opened manually or by other strategies on the same symbol`}>
                  Current P&amp;L{' '}
                  {pos ? (
                    <span className={cn('font-semibold tabular-nums', pos.upl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {pos.side.toUpperCase()} {Math.abs(pos.qty)} · {money(pos.upl)} ({pct(pos.uplPct)})
                    </span>
                  ) : posInfo.unavailable ? (
                    // review R-1#5 — never render 'flat' when the account can't be seen
                    <span className="text-amber-500/80" title={`The ${account} account tape is unavailable (keys missing or rejected) — position state unknown`}>
                      tape unavailable
                    </span>
                  ) : (
                    <span className="text-zinc-600">— flat</span>
                  )}
                </span>

                <span className="ml-auto flex items-center gap-0.5">
                  {(r.status === 'triggered' || r.status === 'failed' || r.status === 'paused') && (
                    <Button
                      variant="ghost" size="sm" className="h-9 sm:h-6 px-2 sm:px-1.5 text-[11px] text-emerald-400 hover:text-emerald-300"
                      disabled={busyId === r.id}
                      onClick={() => void patch(r.id, { status: 'armed' }, 'Strategy re-armed')}
                      title="Re-arm — fresh crossing memory, fires on the next genuine crossing"
                    >
                      Re-arm
                    </Button>
                  )}
                  {(r.status === 'armed' || r.status === 'paused') && (
                    <Button
                      variant="ghost" size="sm" className="h-9 sm:h-6 px-2 sm:px-1.5 text-[11px] text-zinc-400"
                      disabled={busyId === r.id}
                      onClick={() => void patch(r.id, { status: r.status === 'paused' ? 'armed' : 'paused' }, r.status === 'paused' ? 'Strategy resumed' : 'Strategy paused')}
                    >
                      {r.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                  )}
                  <Button
                    variant="ghost" size="sm" className="h-9 sm:h-6 px-2 sm:px-1.5 text-[10px] text-zinc-400"
                    disabled={busyId === r.id}
                    onClick={() => void patch(r.id, { repeat: !r.repeat }, r.repeat ? 'Switched to one-shot' : 'Switched to repeat')}
                    title={r.repeat ? 'Switch to one-shot' : 'Switch to repeat'}
                  >
                    {r.repeat ? '∞' : '1×'}
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-9 sm:h-6 px-2 sm:px-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
                    onClick={() => setExpanded((e) => ({ ...e, [r.id]: !open }))}
                    aria-expanded={open}
                    title="Show fire history & historical trades"
                  >
                    {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    History
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-9 sm:h-6 px-2 sm:px-1.5 text-[11px] text-rose-400 hover:text-rose-300"
                    disabled={busyId === r.id}
                    onClick={() => void remove(r)}
                    aria-label={`Delete strategy ${r.symbol}`}
                  >
                    ✕
                  </Button>
                </span>
              </div>

              {/* ---- expanded: fire log + historical trades ---- */}
              {open && (
                <div className="flex flex-col gap-2 border-t border-zinc-800/60 px-3 py-2">
                  {r.fireNote && (
                    <p className="rounded bg-zinc-950/80 px-2 py-1.5 text-[11px] text-zinc-400" title="Last fire detail">
                      <span className="text-zinc-500">Last fire — </span>{r.fireNote}
                    </p>
                  )}

                  {/* historical trades (realized round-trips) */}
                  <div className="flex max-h-64 flex-col overflow-hidden rounded border border-zinc-800/60">
                    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/60 bg-zinc-900 px-2 py-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Historical trades</span>
                      <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">{r.trades.length}</Badge>
                      <span className={cn('ml-auto text-[11px] font-semibold tabular-nums', r.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {money(r.realizedPnl)}
                      </span>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto terminal-scroll">
                      <table className="w-full min-w-[560px] border-collapse text-[11px]">
                        <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                          <tr className="border-b border-zinc-800">
                            <th className="px-2 py-1 text-left font-semibold">Closed</th>
                            <th className="px-2 py-1 text-left font-semibold">Side</th>
                            <th className="px-2 py-1 text-right font-semibold">Qty</th>
                            <th className="px-2 py-1 text-right font-semibold">Entry</th>
                            <th className="px-2 py-1 text-right font-semibold">Exit</th>
                            <th className="px-2 py-1 text-right font-semibold">Held</th>
                            <th className="px-2 py-1 text-right font-semibold">P&amp;L</th>
                            <th className="px-2 py-1 text-right font-semibold">%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.trades.length === 0 && (
                            <tr>
                              <td colSpan={8} className="px-2 py-3 text-center text-zinc-600">
                                No closed trades yet for this rule&apos;s fires.
                              </td>
                            </tr>
                          )}
                          {r.trades.map((t) => (
                            <tr key={t.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
                              <td className="whitespace-nowrap px-2 py-1 text-zinc-400">{fmtDateTime(t.exitAt)}</td>
                              <td className={cn('px-2 py-1 font-medium', t.side === 'long' ? 'text-emerald-400' : 'text-rose-400')}>
                                {t.side === 'long' ? 'LONG' : 'SHORT'}
                              </td>
                              <td className="px-2 py-1 text-right tabular-nums text-zinc-300">{t.qty}</td>
                              <td className="px-2 py-1 text-right tabular-nums text-zinc-300">{fmtPrice(t.entryPrice)}</td>
                              <td className="px-2 py-1 text-right tabular-nums text-zinc-300">{fmtPrice(t.exitPrice)}</td>
                              <td className="px-2 py-1 text-right tabular-nums text-zinc-500">{fmtHeldDuration(t.durationMs)}</td>
                              <td className={cn('px-2 py-1 text-right font-semibold tabular-nums', t.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                                {money(t.pnl)}
                              </td>
                              <td className={cn('px-2 py-1 text-right tabular-nums', t.pnl >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80')}>
                                {pct(t.pnlPct)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* fire log */}
                  <div className="flex max-h-52 flex-col overflow-hidden rounded border border-zinc-800/60">
                    <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/60 bg-zinc-900 px-2 py-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Fire history</span>
                      <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">{r.fires.length}</Badge>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto terminal-scroll">
                      <table className="w-full min-w-[480px] border-collapse text-[11px]">
                        <thead className="sticky top-0 z-10 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                          <tr className="border-b border-zinc-800">
                            <th className="px-2 py-1 text-left font-semibold">Time</th>
                            <th className="px-2 py-1 text-left font-semibold">Result</th>
                            <th className="px-2 py-1 text-left font-semibold">Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.fires.length === 0 && (
                            <tr>
                              <td colSpan={3} className="px-2 py-3 text-center text-zinc-600">
                                This rule has not fired yet — it fires on the next genuine crossing of its condition.
                              </td>
                            </tr>
                          )}
                          {r.fires.map((f) => (
                            <tr key={f.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
                              <td className="whitespace-nowrap px-2 py-1 text-zinc-400">{fmtDateTime(f.createdAt)}</td>
                              <td className="px-2 py-1">
                                {f.ok ? (
                                  <span className="inline-flex items-center gap-1 text-emerald-400" title="Order placed">
                                    <CheckCircle2 className="h-3 w-3" /> fired
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-rose-400" title="Order failed">
                                    <XCircle className="h-3 w-3" /> failed
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1 text-zinc-300">
                                {f.message}
                                {f.orderId && <span className="ml-1.5 text-[9px] text-zinc-600">#{f.orderId.slice(-8)}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="shrink-0 px-1 text-[11px] text-zinc-600">
        Rules are checked every 20s (client + server) and fire only on a genuine crossing of their timeframe ·
        each fire places a market order with the rule&apos;s TP/SL bracket · trades are attributed to a fire by its
        entry order id (FIFO round-trip matching of the broker&apos;s closed orders) · live “Current P&amp;L” is the
        open position on the symbol in the strategy&apos;s trade mode.
      </p>
    </div>
  )
}
