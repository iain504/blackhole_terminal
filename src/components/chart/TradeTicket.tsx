'use client'

// Compact trade ticket: paper/live order entry against the Alpaca Trading API.
// Market/limit entries with optional SL/TP (bracket for stocks; split exits for
// crypto) and trailing-stop exits for stocks.
import { useCallback, useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { fmtPrice } from '@/lib/market-types'
import { isCryptoTradeSymbol } from './trading-types'
import { cn } from '@/lib/utils'

type Mode = 'paper' | 'live'

export function TradeTicket({
  symbol,
  livePrice,
  prefill,
  onClose,
  onPlaced,
}: {
  symbol: string
  livePrice: number | null
  prefill: { side?: 'buy' | 'sell'; price?: number } | null
  onClose: () => void
  onPlaced: () => void
}) {
  const { toast } = useToast()
  const [mode, setMode] = useState<Mode>('paper')
  const [side, setSide] = useState<'buy' | 'sell'>(prefill?.side ?? 'buy')
  const [qty, setQty] = useState('1')
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market')
  const [limitPrice, setLimitPrice] = useState(prefill?.price ? String(prefill.price) : '')
  const [slPrice, setSlPrice] = useState('')
  const [tpPrice, setTpPrice] = useState('')
  const [trailPct, setTrailPct] = useState('')
  const [account, setAccount] = useState<{ buyingPower: string; equity: string; currency: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const isCrypto = isCryptoTradeSymbol(symbol)
  const refPrice = livePrice ?? 0

  // load saved trade mode + account info when opened / mode toggles
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const sres = await fetch('/api/settings')
        if (sres.ok) {
          const s = await sres.json()
          if (alive && (s.tradeMode === 'live' || s.tradeMode === 'paper') && !prefill) setMode(s.tradeMode)
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
    })()
    return () => {
      alive = false
    }
  }, [mode])

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
    const q = parseFloat(qty)
    if (!q || q <= 0) {
      toast({ title: 'Enter a quantity', variant: 'destructive' })
      return
    }
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
    const sl = parseFloat(slPrice)
    const tp = parseFloat(tpPrice)
    if (!Number.isNaN(sl) && sl > 0) body.stop_loss = sl
    if (!Number.isNaN(tp) && tp > 0) body.take_profit = tp
    const tr = parseFloat(trailPct)
    if (!Number.isNaN(tr) && tr > 0) body.trail_percent = tr

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
      window.dispatchEvent(new CustomEvent('tt:positions-changed'))
      onPlaced()
      // keep the ticket open for follow-up trades; reset protective inputs
      setSlPrice('')
      setTpPrice('')
      setTrailPct('')
    } catch (err) {
      toast({
        title: 'Order failed',
        description: err instanceof Error ? err.message : 'Something went wrong.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }, [qty, mode, symbol, side, orderType, limitPrice, slPrice, tpPrice, trailPct, toast, onPlaced])

  const est = refPrice * (parseFloat(qty) || 0)

  return (
    <div
      className="absolute right-2 top-12 z-40 w-64 rounded-lg border border-zinc-700/80 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur"
      role="dialog"
      aria-label={`Trade ticket ${symbol}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-semibold text-zinc-100">
          Trade <span className="text-emerald-400">{symbol}</span>
        </span>
        <button onClick={onClose} aria-label="Close trade ticket" className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
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
          <Label htmlFor="tt-qty" className="text-[10px] text-zinc-400">Quantity</Label>
          <Input
            id="tt-qty"
            type="number"
            min="0"
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
          />
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
              className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
            />
          </div>
        )}
        <div className="col-span-1">
          <Label htmlFor="tt-sl" className="text-[10px] text-zinc-400">Stop loss</Label>
          <Input
            id="tt-sl"
            type="number"
            min="0"
            step="any"
            value={slPrice}
            onChange={(e) => setSlPrice(e.target.value)}
            placeholder="none"
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
          />
        </div>
        <div className="col-span-1">
          <Label htmlFor="tt-tp" className="text-[10px] text-zinc-400">Take profit</Label>
          <Input
            id="tt-tp"
            type="number"
            min="0"
            step="any"
            value={tpPrice}
            onChange={(e) => setTpPrice(e.target.value)}
            placeholder="none"
            className="mt-0.5 h-7 border-zinc-800 bg-zinc-950 text-xs"
          />
        </div>
        {!isCrypto && (
          <div className="col-span-2">
            <Label htmlFor="tt-trail" className="text-[10px] text-zinc-400">
              Trailing stop % <span className="text-zinc-600">(exit order, ignores SL/TP)</span>
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
          </div>
        )}
      </div>

      {isCrypto && (slPrice || tpPrice) && (
        <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
          Crypto: SL/TP placed as separate exit orders, qty split 50/50 (no bracket support).
        </p>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-500">
        <span>Est. {est ? `≈ $${est.toFixed(2)}` : '—'}</span>
        {account && <span>Equity ${parseFloat(account.equity).toFixed(0)}</span>}
      </div>

      <Button
        onClick={() => void submit()}
        disabled={submitting}
        className={cn(
          'mt-2 h-8 w-full font-semibold',
          side === 'buy' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-rose-600 text-white hover:bg-rose-500',
        )}
      >
        {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
        {side === 'buy' ? 'Buy' : 'Sell'} {qty || '—'} {symbol} · {mode}
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
