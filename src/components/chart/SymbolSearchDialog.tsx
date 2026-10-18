'use client'

// Symbol search backed by /api/market/symbols — the FULL Alpaca US-equity
// universe (~14k symbols, e.g. fresh listings like SPCX) + crypto majors,
// with server-side prefix/contains/name ranking and an authoritative
// per-symbol Alpaca lookup for exact typed queries. Falls back to the
// curated static list only when the API is unreachable.
import { useEffect, useRef, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Search, Bitcoin, TrendingUp } from 'lucide-react'
import { ALL_US_SYMBOLS, CRYPTO_UNIVERSE, fmtPrice, isValidSymbolFormat } from '@/lib/market-types'
import { cn } from '@/lib/utils'

interface Row {
  symbol: string
  name?: string
  crypto: boolean
}

const staticRows = (): Row[] => [
  ...ALL_US_SYMBOLS.map((s) => ({ symbol: s, crypto: false })),
  ...CRYPTO_UNIVERSE.map((s) => ({ symbol: s, crypto: true })),
]

function filterStatic(q: string): Row[] {
  const all = staticRows()
  if (!q) return all.slice(0, 60)
  return all.filter((r) => r.symbol.includes(q)).slice(0, 60)
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
  const [rows, setRows] = useState<Row[]>(() => staticRows())
  const [apiFailed, setApiFailed] = useState(false)
  const [searching, setSearching] = useState(false)
  const seqRef = useRef(0)

  // reset query when dialog opens (event-driven, not effect-driven)
  const handleOpenChange = (v: boolean) => {
    if (v) {
      setQuery('')
      setRows(staticRows())
      setApiFailed(false)
    }
    onOpenChange(v)
  }

  // debounced live search against the full universe
  useEffect(() => {
    if (!open) return
    const q = query.trim().toUpperCase()
    if (!q) {
      setRows(staticRows())
      setApiFailed(false)
      setSearching(false)
      return
    }
    setSearching(true)
    const seq = ++seqRef.current
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/market/symbols?q=${encodeURIComponent(q)}`)
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = (await res.json()) as { symbols?: { symbol: string; name?: string; crypto?: boolean }[] }
        if (seqRef.current !== seq) return
        setRows((data.symbols ?? []).map((s) => ({ symbol: s.symbol, name: s.name, crypto: !!s.crypto })))
        setApiFailed(false)
      } catch {
        if (seqRef.current !== seq) return
        // API unreachable — permissive static fallback
        setRows(filterStatic(q))
        setApiFailed(true)
      } finally {
        if (seqRef.current === seq) setSearching(false)
      }
    }, 160)
    return () => clearTimeout(t)
  }, [query, open])

  // "Load anyway" escape hatch — only when the live search is unavailable
  // (offline); when the API answers, a missing symbol genuinely does not exist.
  const exactQuery = query.trim().toUpperCase()
  const showAnyway =
    apiFailed &&
    exactQuery.length >= 1 &&
    isValidSymbolFormat(exactQuery) &&
    !rows.some((r) => r.symbol === exactQuery)

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
              placeholder="Search — AAPL, TSLA, SPCX, BTC/USD…"
              className="border-zinc-800 bg-zinc-950 pl-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (rows[0] || showAnyway)) {
                  onSelect(rows[0] ? rows[0].symbol : exactQuery)
                  onOpenChange(false)
                }
              }}
            />
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto terminal-scroll px-2 pb-3">
          {rows.length === 0 && !showAnyway && (
            <p className="py-6 text-center text-xs text-zinc-500">
              {searching ? 'Searching…' : <>No symbols match “{query}”</>}
            </p>
          )}
          {showAnyway && (
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
              {r.name && (
                <span className="truncate text-[11px] text-zinc-500">{r.name}</span>
              )}
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
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
