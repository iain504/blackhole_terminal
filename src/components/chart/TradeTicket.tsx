'use client'

// Compact trade ticket: paper/live order entry against the Alpaca Trading API.
// Market/limit entries with optional SL/TP (bracket for stocks; split exits for
// crypto) and trailing-stop exits for stocks.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, X, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice } from '@/lib/market-types'
import { isCryptoTradeSymbol } from './trading-types'
import { useTerminal } from '@/store/terminal'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'

export interface TicketPrefill {
  side?: 'buy' | 'sell'
  price?: number
  /** right-click "buy/sell limit here" pre-selects a limit order at price */
  type?: 'market' | 'limit'
}

const fmtP = (v: number) => String(v >= 1 ? +v.toFixed(2) : +v.toFixed(6))

export function TradeTicket({
  symbol,
  livePrice,
  prefill,
  onClose,
  onPlaced,
}: {
  symbol: string
  livePrice: number | null
  prefill: TicketPrefill | null
  onClose: () => void
  onPlaced: () => void
}) {
  const { toast } = useToast()
  // ---- moveable ticket (Task 54.3): drag by the header; the position is a
  // left/top px offset inside the chart container, persisted in the layout ----
  const ticketPos = useTerminal((s) => s.ticketPos)
  const setTicketPos = useTerminal((s) => s.setTicketPos)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const lastPos = useRef<{ x: number; y: number } | null>(null)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const pos = dragPos ?? ticketPos

  const clampPos = useCallback((x: number, y: number): { x: number; y: number } => {
    const el = rootRef.current
    const parent = el?.parentElement
    if (!el || !parent) return { x, y }
    const pw = parent.clientWidth
    const ph = parent.clientHeight
    if (!(pw > 0) || !(ph > 0)) return { x, y }
    const maxX = Math.max(4, pw - el.offsetWidth - 4)
    const maxY = Math.max(4, ph - el.offsetHeight - 4)
    return { x: Math.min(Math.max(4, x), maxX), y: Math.min(Math.max(4, y), maxY) }
  }, [])

  // a saved position may fall outside after a chart resize — clamp VISUALLY
  // on mount (the stored value stays until the next drag commit)
  useEffect(() => {
    if (ticketPos) setDragPos(clampPos(ticketPos.x, ticketPos.y))
  }, [ticketPos, clampPos])

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return // close button
    const el = rootRef.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const er = el.getBoundingClientRect()
    const pr = parent.getBoundingClientRect()
    const origX = er.left - pr.left
    const origY = er.top - pr.top
    dragState.current = { startX: e.clientX, startY: e.clientY, origX, origY }
    lastPos.current = { x: origX, y: origY }
    setDragPos({ x: origX, y: origY })
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
  }
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current
    if (!st) return
    const next = clampPos(st.origX + (e.clientX - st.startX), st.origY + (e.clientY - st.startY))
    lastPos.current = next
    setDragPos(next)
  }
  const endHeaderDrag = () => {
    if (!dragState.current) return
    dragState.current = null
    const final = lastPos.current
    setDragPos(null)
    if (final) setTicketPos(final)
  }

  const [mode, setMode] = useState<Mode>('paper')
  const [side, setSide] = useState<'buy' | 'sell'>(prefill?.side ?? 'buy')
  const [qty, setQty] = useState('1')
  const [orderType, setOrderType] = useState<'market' | 'limit'>(prefill?.type ?? 'market')
  const [limitPrice, setLimitPrice] = useState(prefill?.price ? fmtP(prefill.price) : '')
  const [slPrice, setSlPrice] = useState('')
  const [tpPrice, setTpPrice] = useState('')
  const [slPct, setSlPct] = useState('5')
  const [tpPct, setTpPct] = useState('5')
  const [trailPct, setTrailPct] = useState('')
  // once the user edits SL/TP by hand the auto-fill stops overwriting them
  const [slTouched, setSlTouched] = useState(false)
  const [tpTouched, setTpTouched] = useState(false)
  const [account, setAccount] = useState<{ buyingPower: string; equity: string; currency: string } | null>(null)
  // open position size for THIS symbol — the SELL-side % buttons size from it
  const [positionQty, setPositionQty] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const isCrypto = isCryptoTradeSymbol(symbol)
  const refPrice = livePrice ?? 0
  // trailing stop mode: when set, the order IS the trailing stop (no entry
  // bracket) and SL/TP are ignored
  const trailActive = Number.isFinite(parseFloat(trailPct)) && parseFloat(trailPct) > 0

  // ---- Task 4-c: inline field validation -----------------------------------
  // Derived from state on EVERY render, so it re-evaluates on each keystroke
  // (validate-on-change, not just on blur). Mirrors submit()'s own guards —
  // the submit button is disabled while anything is invalid, and the existing
  // toast-on-error path stays as a defensive backstop.
  const qtyNum = parseFloat(qty)
  const qtyError: string | null =
    !qty.trim() || !Number.isFinite(qtyNum) || qtyNum <= 0
      ? 'Quantity must be greater than 0'
      : !isCrypto && !Number.isInteger(qtyNum)
        ? 'Stocks require a whole number of shares'
        : null
  // limit price only matters for a PLAIN limit order — a trailing stop replaces
  // the entry type entirely (submit deletes type/limit_price in that mode)
  const limitNum = parseFloat(limitPrice)
  const limitError: string | null =
    orderType === 'limit' && !trailActive && (!limitPrice.trim() || !Number.isFinite(limitNum) || limitNum <= 0)
      ? 'Limit price is required and must be greater than 0'
      : null
  const formInvalid = qtyError != null || limitError != null

  // load saved trade mode + default TP/SL percent when opened / mode toggles
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const sres = await fetch('/api/settings')
        if (sres.ok) {
          const s = await sres.json()
          if (alive && (s.tradeMode === 'live' || s.tradeMode === 'paper') && !prefill) setMode(s.tradeMode)
          if (alive && typeof s.tpslPercent === 'number' && s.tpslPercent > 0) {
            if (!slTouched) setSlPct(String(s.tpslPercent))
            if (!tpTouched) setTpPct(String(s.tpslPercent))
          }
        }
      } catch { /* ignore */ }
      try {
        const res = await fetch(`/api/trading/account?mode=${mode}`)
        if (res.ok) {
          const json = await res.json()
          if (alive && json.account) {
            setAccount({ buyingPower: json.account.buyingPower, equity: json.account.equity, currency: json.account.currency })
          }
        }
      } catch { /* ignore */ }
      try {
        const pres = await fetch(`/api/trading/positions?mode=${mode}`)
        if (pres.ok) {
          const pjson = await pres.json()
          if (alive) {
            const list = (pjson.positions || []) as { tradeSymbol?: string; symbol?: string; qty: number }[]
            const mine = list.find((x) => x.tradeSymbol === symbol || x.symbol === symbol)
            setPositionQty(mine && Math.abs(mine.qty) > 0 ? Math.abs(mine.qty) : 0)
          }
        }
      } catch { /* ignore */ }
    })()
    return () => {
      alive = false
    }
  }, [mode, symbol, slTouched, tpTouched])

  const changeMode = (m: Mode) => {
    setMode(m)
    // persist preference quietly
    void fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tradeMode: m }),
    }).catch(() => {})
  }

  const submit = useCallback(async () => {
    // Alpaca requires a whole-number quantity for non-fractional assets:
    // stock qty is rounded DOWN to an integer (crypto keeps its fractions).
    const raw = parseFloat(qty)
    const q = isCrypto ? raw : Math.floor(raw)
    if (!raw || raw <= 0) {
      toast({ title: 'Enter a quantity', variant: 'destructive' })
      return
    }
    if (!q || q <= 0) {
      toast({ title: 'Quantity rounds to 0', description: 'Stocks require a whole number — enter at least 1 share.', variant: 'destructive' })
      return
    }
    if (!isCrypto && q !== raw) setQty(String(q))
    const body: Record<string, unknown> = {
      mode,
      symbol,
      side,
      qty: q,
      type: orderType,
    }
    if (orderType === 'limit') {
      const lp = parseFloat(limitPrice)
      if (!lp || lp <= 0) {
        toast({ title: 'Enter a limit price', variant: 'destructive' })
        return
      }
      body.limit_price = lp
    }
    const tr = parseFloat(trailPct)
    if (!Number.isNaN(tr) && tr > 0) {
      // TRAILING STOP: the order is the trailing stop itself (side as chosen —
      // SELL trails below / BUY trails above). SL/TP are not part of it.
      if (isCrypto) {
        toast({ title: 'Trailing stops are not supported for crypto', description: 'Use the SL field — it places a stop_limit exit.', variant: 'destructive' })
        return
      }
      delete body.type
      delete body.limit_price
      body.trail_percent = tr
    } else {
      const sl = parseFloat(slPrice)
      const tp = parseFloat(tpPrice)
      if (!Number.isNaN(sl) && sl > 0) body.stop_loss = sl
      if (!Number.isNaN(tp) && tp > 0) body.take_profit = tp
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/trading/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(json?.error || `Order failed (${res.status})`)
      }
      const errs: string[] = json.errors || []
      const oid = json.orders?.[0]?.id
      if (trailActive) {
        toast({
          title: `🎯 Trailing stop submitted (${json.mode || mode})`,
          description: [`${side.toUpperCase()} ${q} ${symbol} · trail ${tr}%`, oid ? `#${String(oid).slice(0, 8)}` : '', ...errs].filter(Boolean).join(' · '),
          variant: errs.length ? 'destructive' : 'default',
        })
      } else {
        toast({
          title: `${side === 'buy' ? '🟢 Buy' : '🔴 Sell'} order submitted (${json.mode || mode})`,
          description: [
            `${q} ${symbol} ${orderType}`,
            json.splitNote,
            ...errs,
            oid ? `#${String(oid).slice(0, 8)}` : '',
          ].filter(Boolean).join(' · '),
          variant: errs.length ? 'destructive' : 'default',
        })
      }
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      onPlaced()
      // keep the ticket open for follow-up trades; reset protective inputs
      // (auto-fill re-applies the configured % because touched flags clear)
      setSlPrice('')
      setTpPrice('')
      setTrailPct('')
      setSlTouched(false)
      setTpTouched(false)
    } catch (err) {
      toast({
        title: 'Order failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [qty, mode, symbol, side, orderType, limitPrice, slPrice, tpPrice, trailPct, trailActive, isCrypto, toast, onPlaced])

  const est = refPrice * ((isCrypto ? parseFloat(qty) : Math.floor(parseFloat(qty))) || 0)

  // ---- Task 52.5: size the quantity from remaining buying power (BUY) or
  // the open position (SELL) via the 5/10/25/50/100% buttons ----
  const floorTo = (n: number, dp: number) => Math.floor(n * 10 ** dp) / 10 ** dp
  const pctQty = (p: number): number | null => {
    if (side === 'buy') {
      const bp = account ? parseFloat(account.buyingPower) : NaN
      if (!Number.isFinite(bp) || bp <= 0) return null
      if (refPrice <= 0) return null
      return Math.max(0, floorTo((bp * p) / 100 / refPrice, isCrypto ? 6 : 0))
    }
    if (!positionQty) return null
    return Math.max(0, floorTo((positionQty * p) / 100, isCrypto ? 6 : 0))
  }
  const pctTitle = (p: number): string => {
    if (side === 'buy') {
      const bp = account ? parseFloat(account.buyingPower) : NaN
      if (!Number.isFinite(bp)) return `${p}% of buying power — account not loaded yet`
      if (refPrice <= 0) return `${p}% of buying power — no live price yet`
      const q = pctQty(p)
      return `${p}% of buying power ($${bp.toFixed(2)}) ÷ ${refPrice} ≈ ${q != null ? q : '—'} ${symbol}`
    }
    if (!positionQty) return `${p}% of the open position — no open ${symbol} position`
    return `${p}% of the open position (${positionQty} ${symbol}) ≈ ${pctQty(p) ?? '—'} ${symbol}`
  }
  const applyPct = (p: number) => {
    const q = pctQty(p)
    if (q == null) {
      toast({
        title: 'Cannot size from percentage',
        description:
          side === 'buy'
            ? refPrice <= 0
              ? 'No live price yet — try again in a moment.'
              : 'Buying power not loaded yet.'
            : `No open ${symbol} position to size from.`,
        variant: 'destructive',
      })
      return
    }
    if (q <= 0) {
      toast({ title: 'Size rounds to zero', description: 'The percentage of the basis is below the minimum tradable quantity.', variant: 'destructive' })
      return
    }
    setQty(String(q))
  }

  // ---- auto TP/SL: pre-fill ± configured % from the entry basis ----
  // basis = limit price for limit orders (right-click price included), else
  // the live price. Runs until the user edits a price by hand.
  const basis =
    orderType === 'limit' && parseFloat(limitPrice) > 0
      ? parseFloat(limitPrice)
      : refPrice > 0
        ? refPrice
        : 0
  useEffect(() => {
    if (basis <= 0) return
    const slP = parseFloat(slPct)
    const tpP = parseFloat(tpPct)
    if (!isFinite(slP) || slP <= 0 || !isFinite(tpP) || tpP <= 0) return
    const dir = side === 'buy' ? 1 : -1
    if (!slTouched) setSlPrice(fmtP(basis * (1 - (dir * slP) / 100)))
    if (!tpTouched) setTpPrice(fmtP(basis * (1 + (dir * tpP) / 100)))
  }, [basis, side, slPct, tpPct, slTouched, tpTouched])

  return (
    <div
      ref={rootRef}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
      className={cn(
        'terminal-scroll absolute z-40 max-h-[calc(100%-3.5rem)] w-64 overflow-y-auto rounded-lg border border-zinc-700/80 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur',
        !pos && 'right-2 top-12',
      )}
      role="dialog"
      aria-label={`Trade ticket ${symbol}`}
    >
      <div
        className="mb-2 flex cursor-move touch-none select-none items-center justify-between"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
        title="Drag to move the trade ticket"
        aria-label="Drag to move the trade ticket"
      >
        <span className="flex items-center gap-1.5 font-semibold text-zinc-100">
          <GripVertical className="h-3.5 w-3.5 text-zinc-600" />
          Trade <span className="text-emerald-400">{symbol}</span>
        </span>
        <button data-no-drag onClick={onClose} aria-label="Close trade ticket" className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* paper / live */}
      <div className="mb-2 flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
        {(['paper', 'live'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => changeMode(m)}
            aria-pressed={mode === m}
            className={cn(
              'flex-1 rounded px-2 py-1 font-medium capitalize transition-colors',
              mode === m
                ? m === 'live'
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'bg-emerald-500/20 text-emerald-400'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === 'live' && (
        <p className="mb-2 rounded bg-amber-500/10 px-2 py-1 text-[10px] leading-snug text-amber-400">
          LIVE mode — real money orders.
        </p>
      )}

      {/* buy / sell */}
      <div className="mb-2 flex gap-1">
        <button
          onClick={() => setSide('buy')}
          aria-pressed={side === 'buy'}
          className={cn(
            'flex-1 rounded-md py-1.5 font-semibold transition-colors',
            side === 'buy' ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
          )}
        >
          Buy
        </button>
        <button
          onClick={() => setSide('sell')}
          aria-pressed={side === 'sell'}
          className={cn(
            'flex-1 rounded-md py-1.5 font-semibold transition-colors',
            side === 'sell' ? 'bg-rose-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
          )}
        >
          Sell
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-1">
          <Label htmlFor="tt-qty" className="text-[10px] text-zinc-400">
            Quantity{!isCrypto && <span title="Alpaca requires whole-number quantity for stocks — fractional input is rounded down" className="ml-1 cursor-help text-zinc-600">(whole)</span>}
          </Label>
          <Input
            id="tt-qty"
            type="number"
            min="0"
            step={isCrypto ? 'any' : '1'}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onBlur={() => {
              // stocks are non-fractionable — normalize to a whole number
              if (isCrypto) return
              const n = parseFloat(qty)
              if (Number.isFinite(n) && n > 0 && !Number.isInteger(n)) setQty(String(Math.floor(n)))
            }}
            aria-invalid={qtyError ? true : undefined}
            aria-describedby={qtyError ? 'tt-qty-error' : undefined}
            className={cn(
              'mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs',
              qtyError && 'border-rose-500/70 focus-visible:ring-rose-500/40',
            )}
          />
          {qtyError && (
            <p id="tt-qty-error" className="mt-0.5 text-[10px] leading-snug text-rose-400">
              {qtyError}
            </p>
          )}
        </div>
        <div className="col-span-1">
          <Label htmlFor="tt-type" className="text-[10px] text-zinc-400">Order type</Label>
          <select
            id="tt-type"
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as 'market' | 'limit')}
            className="mt-0.5 h-7 w-full rounded-md border border-zinc-800 bg-zinc-950 px-1.5 text-xs text-zinc-200"
          >
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </div>
        {/* size from remaining buying power (BUY) / open position (SELL) */}
        <div className="col-span-2 flex items-center gap-1">
          <span className="w-8 shrink-0 text-[9px] uppercase tracking-wider text-zinc-600">
            {side === 'buy' ? 'BP %' : 'Pos %'}
          </span>
          {[5, 10, 25, 50, 100].map((p) => {
            const unusable = side === 'buy' ? !account || refPrice <= 0 : !positionQty
            return (
              <button
                key={p}
                type="button"
                onClick={() => applyPct(p)}
                disabled={unusable}
                title={pctTitle(p)}
                aria-label={`Set quantity to ${p}% of ${side === 'buy' ? 'remaining buying power' : 'the open position'}`}
                className={cn(
                  'flex-1 rounded border px-1 py-0.5 text-[10px] font-semibold tabular-nums transition-colors',
                  side === 'buy'
                    ? 'border-zinc-800 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-400'
                    : 'border-zinc-800 text-zinc-400 hover:border-rose-500/50 hover:text-rose-400',
                  'disabled:pointer-events-none disabled:opacity-40',
                )}
              >
                {p}%
              </button>
            )
          })}
        </div>
        {orderType === 'limit' && (
          <div className="col-span-2">
            <Label htmlFor="tt-limit" className="text-[10px] text-zinc-400">Limit price</Label>
            <Input
              id="tt-limit"
              type="number"
              min="0"
              step="any"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder={refPrice ? String(refPrice) : ''}
              aria-invalid={limitError ? true : undefined}
              aria-describedby={limitError ? 'tt-limit-error' : undefined}
              className={cn(
                'mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs',
                limitError && 'border-rose-500/70 focus-visible:ring-rose-500/40',
              )}
            />
            {limitError && (
              <p id="tt-limit-error" className="mt-0.5 text-[10px] leading-snug text-rose-400">
                {limitError}
              </p>
            )}
          </div>
        )}
        <div className="col-span-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="tt-sl" className={cn('text-[10px]', trailActive ? 'text-zinc-600' : 'text-zinc-400')}>Stop loss{trailActive ? ' (off)' : ''}</Label>
            <div className="flex items-center gap-0.5">
              <input
                aria-label="Stop loss percent"
                type="number"
                min="0.1"
                step="0.5"
                value={slPct}
                onChange={(e) => {
                  const p = e.target.value
                  setSlPct(p)
                  const pv = parseFloat(p)
                  if (isFinite(pv) && pv > 0 && basis > 0) {
                    const dir = side === 'buy' ? 1 : -1
                    setSlPrice(fmtP(basis * (1 - (dir * pv) / 100)))
                  }
                  setSlTouched(true)
                }}
                className="h-4 w-9 rounded border border-zinc-800 bg-zinc-950 px-0.5 text-right text-[9px] text-zinc-400"
              />
              <span className="text-[9px] text-zinc-600">%</span>
            </div>
          </div>
          <Input
            id="tt-sl"
            type="number"
            min="0"
            step="any"
            value={trailActive ? '' : slPrice}
            onChange={(e) => {
              setSlPrice(e.target.value)
              setSlTouched(true)
            }}
            disabled={trailActive}
            placeholder={trailActive ? 'trailing stop active' : 'none'}
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs disabled:opacity-50"
          />
        </div>
        <div className="col-span-1">
          <div className="flex items-center justify-between">
            <Label htmlFor="tt-tp" className={cn('text-[10px]', trailActive ? 'text-zinc-600' : 'text-zinc-400')}>Take profit{trailActive ? ' (off)' : ''}</Label>
            <div className="flex items-center gap-0.5">
              <input
                aria-label="Take profit percent"
                type="number"
                min="0.1"
                step="0.5"
                value={tpPct}
                onChange={(e) => {
                  const p = e.target.value
                  setTpPct(p)
                  const pv = parseFloat(p)
                  if (isFinite(pv) && pv > 0 && basis > 0) {
                    const dir = side === 'buy' ? 1 : -1
                    setTpPrice(fmtP(basis * (1 + (dir * pv) / 100)))
                  }
                  setTpTouched(true)
                }}
                className="h-4 w-9 rounded border border-zinc-800 bg-zinc-950 px-0.5 text-right text-[9px] text-zinc-400"
              />
              <span className="text-[9px] text-zinc-600">%</span>
            </div>
          </div>
          <Input
            id="tt-tp"
            type="number"
            min="0"
            step="any"
            value={trailActive ? '' : tpPrice}
            onChange={(e) => {
              setTpPrice(e.target.value)
              setTpTouched(true)
            }}
            disabled={trailActive}
            placeholder={trailActive ? 'trailing stop active' : 'none'}
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs disabled:opacity-50"
          />
        </div>
        {!isCrypto && (
          <div className="col-span-2">
            <Label htmlFor="tt-trail" className="text-[10px] text-zinc-400">
              Trailing stop % <span className="text-zinc-600">{trailActive ? '— order IS the trailing stop' : '(optional)'}</span>
            </Label>
            <Input
              id="tt-trail"
              type="number"
              min="0"
              step="any"
              value={trailPct}
              onChange={(e) => setTrailPct(e.target.value)}
              placeholder="e.g. 1.5"
              className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
            />
            {trailActive && (
              <p className="mt-1 text-[10px] leading-snug text-amber-400/90">
                {side === 'sell'
                  ? 'SELL trailing stop — follows the price DOWN (exits / protects a long).'
                  : 'BUY trailing stop — follows the price UP (exits / opens a short).'}
                SL/TP ignored while this is set.
              </p>
            )}
          </div>
        )}
      </div>

      {isCrypto && (slPrice || tpPrice) && (
        <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
          Crypto has no native bracket orders — the entry is placed alone and
          TP/SL attach automatically the moment it fills (OCO-managed: when the
          position closes, any surviving exit is cancelled).
        </p>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-500">
        <span>Est. {est ? `≈ $${est.toFixed(2)}` : '—'}</span>
        {account && <span title="Remaining buying power">BP ${parseFloat(account.buyingPower).toFixed(0)}</span>}
        {account && <span>Equity ${parseFloat(account.equity).toFixed(0)}</span>}
      </div>

      <Button
        onClick={() => void submit()}
        disabled={submitting || formInvalid}
        className={cn(
          'mt-2 h-auto min-h-8 w-full whitespace-normal px-2 py-1 font-semibold leading-snug',
          side === 'buy' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-rose-600 text-white hover:bg-rose-500',
        )}
      >
        {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
        {trailActive
          ? `🎯 Trailing stop ${side.toUpperCase()} ${qty || '—'} ${symbol} · ${mode}`
          : `${side === 'buy' ? 'Buy' : 'Sell'} ${qty || '—'} ${symbol} · ${mode}`}
      </Button>

      <p className="mt-1.5 text-[10px] leading-snug text-zinc-600">
        Orders route through the Alpaca Trading API with your saved keys.{' '}
        <Badge variant="outline" className="h-auto border-zinc-800 px-1 py-0 text-[9px] text-zinc-500">
          paper default
        </Badge>
      </p>
    </div>
  )
}
