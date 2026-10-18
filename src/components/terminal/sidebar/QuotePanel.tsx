'use client'

// Quote panel: current symbol snapshot (price, change, OHLC, volume, range).
import { useEffect, useState } from 'react'
import { fmtPrice, isCryptoSymbol } from '@/lib/market-types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Bitcoin, TrendingUp } from 'lucide-react'

interface FullQuote {
  price: number
  change: number
  changePct: number
  open: number
  high: number
  low: number
  prevClose: number
  volume: number
  ts: number
}

export function QuotePanel({ symbol }: { symbol: string }) {
  const [state, setState] = useState<{ key: string; q: FullQuote } | null>(null)
  const q = state?.key === symbol ? state.q : null

  useEffect(() => {
    let alive = true
    const fetchQ = async () => {
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: [symbol] }),
        })
        if (!res.ok || !alive) return
        const json = await res.json()
        const quote = json.quotes?.[0]
        if (quote && alive) setState({ key: symbol, q: quote })
      } catch { /* offline */ }
    }
    fetchQ()
    const timer = setInterval(fetchQ, 10000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [symbol])

  const up = (q?.changePct ?? 0) >= 0

  return (
    <div className="p-2.5 text-xs">
      <div className="mb-2 flex items-center gap-2">
        {isCryptoSymbol(symbol) ? (
          <Bitcoin className="h-4 w-4 text-amber-400" />
        ) : (
          <TrendingUp className="h-4 w-4 text-emerald-500" />
        )}
        <span className="text-sm font-semibold text-zinc-100">{symbol}</span>
        {isCryptoSymbol(symbol) && (
          <Badge variant="outline" className="border-amber-500/40 text-[9px] text-amber-400">Crypto 7×24</Badge>
        )}
      </div>
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums text-zinc-50">{q ? fmtPrice(q.price) : '—'}</span>
        {q && (
          <span className={cn('text-xs font-medium tabular-nums', up ? 'text-emerald-400' : 'text-rose-400')}>
            {up ? '+' : ''}{fmtPrice(q.change)} ({up ? '+' : ''}{q.changePct.toFixed(2)}%)
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <Stat label="Open" value={q ? fmtPrice(q.open) : '—'} />
        <Stat label="Prev close" value={q ? fmtPrice(q.prevClose) : '—'} />
        <Stat label="Day high" value={q ? fmtPrice(q.high) : '—'} up />
        <Stat label="Day low" value={q ? fmtPrice(q.low) : '—'} up />
        <Stat
          label="Volume"
          value={q ? (q.volume >= 1e9 ? `${(q.volume / 1e9).toFixed(2)}B` : q.volume >= 1e6 ? `${(q.volume / 1e6).toFixed(2)}M` : q.volume >= 1e3 ? `${(q.volume / 1e3).toFixed(1)}K` : String(q.volume)) : '—'}
        />
        <Stat label="Updated" value={q ? new Date(q.ts * 1000).toLocaleTimeString() : '—'} />
      </div>
      {q && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
            <span>{fmtPrice(q.low)}</span>
            <span>Day range</span>
            <span>{fmtPrice(q.high)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-500"
              style={{
                width: `${Math.min(100, Math.max(2, ((q.price - q.low) / Math.max(q.high - q.low, 1e-9)) * 100))}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, up }: { label: string; value: string; up?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className={cn('tabular-nums text-zinc-200', up && 'text-emerald-400/90')}>{value}</span>
    </div>
  )
}
