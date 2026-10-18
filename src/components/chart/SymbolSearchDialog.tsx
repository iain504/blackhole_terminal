'use client'

// Symbol search: US stocks + Alpaca crypto (BTC/USD style).
import { useEffect, useMemo, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Search, Bitcoin, TrendingUp } from 'lucide-react'
import { ALL_US_SYMBOLS, CRYPTO_UNIVERSE, fmtPrice } from '@/lib/market-types'
import { cn } from '@/lib/utils'

interface Row {
  symbol: string
  crypto: boolean
}

export function SymbolSearchDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSelect: (symbol: string) => void
}) {
  const [query, setQuery] = useState('')

  // reset query when dialog opens (event-driven, not effect-driven)
  const handleOpenChange = (v: boolean) => {
    if (v) setQuery('')
    onOpenChange(v)
  }

  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [
      ...ALL_US_SYMBOLS.map((s) => ({ symbol: s, crypto: false })),
      ...CRYPTO_UNIVERSE.map((s) => ({ symbol: s, crypto: true })),
    ]
    const q = query.trim().toUpperCase()
    if (!q) return all.slice(0, 60)
    return all.filter((r) => r.symbol.includes(q)).slice(0, 60)
  }, [query])

  // Any exact ticker can be loaded even when it is not in the curated list
  // (Alpaca supports thousands of symbols — e.g. newer listings like SPCX).
  const exactQuery = query.trim().toUpperCase()
  const exactMatch = exactQuery.length >= 1 && exactQuery.length <= 15 && !rows.some((r) => r.symbol === exactQuery)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md border-zinc-800 bg-zinc-900 p-0">
        <DialogHeader className="border-b border-zinc-800 px-4 py-3">
          <DialogTitle className="text-sm text-zinc-200">Symbol Search</DialogTitle>
        </DialogHeader>
        <div className="px-4 pb-2 pt-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search — AAPL, TSLA, BTC/USD…"
              className="border-zinc-800 bg-zinc-950 pl-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (rows[0] || exactMatch)) {
                  onSelect(rows[0] ? rows[0].symbol : exactQuery)
                  onOpenChange(false)
                }
              }}
            />
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto terminal-scroll px-2 pb-3">
          {rows.length === 0 && !exactMatch && (
            <p className="py-6 text-center text-xs text-zinc-500">No symbols match “{query}”</p>
          )}
          {exactMatch && (
            <button
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-emerald-400 hover:bg-emerald-500/10"
              onClick={() => {
                onSelect(exactQuery)
                onOpenChange(false)
              }}
            >
              <TrendingUp className="h-4 w-4 shrink-0" />
              <span className="font-medium">Load “{exactQuery}” anyway</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-500">Alpaca symbol</span>
            </button>
          )}
          {rows.map((r) => (
            <button
              key={r.symbol}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800/70',
              )}
              onClick={() => {
                onSelect(r.symbol)
                onOpenChange(false)
              }}
            >
              {r.crypto ? (
                <Bitcoin className="h-4 w-4 shrink-0 text-amber-400" />
              ) : (
                <TrendingUp className="h-4 w-4 shrink-0 text-emerald-500" />
              )}
              <span className="font-medium">{r.symbol}</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-500">
                {r.crypto ? 'Crypto 7×24' : 'US Stock'}
              </span>
            </button>
          ))}
        </div>
        <p className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          Crypto pairs use the <span className="text-zinc-400">SYMBOL/USD</span> format (separate Alpaca crypto API, 7×24). Stocks show US market prices — e.g. {fmtPrice(232.1)}.
        </p>
      </DialogContent>
    </Dialog>
  )
}
