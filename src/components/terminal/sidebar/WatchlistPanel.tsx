'use client'

// Watchlist panel: multiple personal lists with tag colors; rows show
// symbol, price, daily change, daily % (Task 13 #2/#4, Task 16 #2).
// Symbol input has live prediction (symbols starting with the typed query,
// backed by the Alpaca asset universe) and rejects unknown symbols.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal, Watchlist } from '@/store/terminal'
import { fmtPrice } from '@/lib/market-types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Plus, MoreVertical, Trash2, ChevronUp, ChevronDown, Palette, X, Tag, Loader2 } from 'lucide-react'

const LIST_COLORS = ['#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#e879f9', '#f4f4f5']

interface QuoteRow {
  symbol: string
  price: number
  change: number
  changePct: number
}

interface SuggRow {
  symbol: string
  name: string
  crypto: boolean
}

export function WatchlistPanel() {
  const lists = useTerminal((s) => s.watchlists)
  const activeId = useTerminal((s) => s.activeWatchlistId)
  const setActiveWatchlist = useTerminal((s) => s.setActiveWatchlist)
  const selectSymbol = useTerminal((s) => s.selectSymbol)
  const activeTab = useTerminal((s) => s.tabs.find((t) => t.id === s.activeTabId) || s.tabs[0])
  const addSymbolToWatchlist = useTerminal((s) => s.addSymbolToWatchlist)
  const removeSymbolFromWatchlist = useTerminal((s) => s.removeSymbolFromWatchlist)
  const createWatchlist = useTerminal((s) => s.createWatchlist)
  const deleteWatchlist = useTerminal((s) => s.deleteWatchlist)
  const updateWatchlist = useTerminal((s) => s.updateWatchlist)
  const moveWatchlist = useTerminal((s) => s.moveWatchlist)

  const [quotes, setQuotes] = useState<Record<string, QuoteRow>>({})
  const [newSymbol, setNewSymbol] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(LIST_COLORS[0])
  const [sugg, setSugg] = useState<SuggRow[]>([])
  const [suggOpen, setSuggOpen] = useState(false)
  const [suggIdx, setSuggIdx] = useState(-1)
  const [suggLoading, setSuggLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const suggDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputBoxRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()

  const list: Watchlist | undefined = lists.find((l) => l.id === activeId) || lists[0]

  // fetch quotes for this list every 10s
  const itemsKey = list?.items.join(',') ?? ''
  useEffect(() => {
    if (!itemsKey) return
    let alive = true
    const fetchQ = async () => {
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: itemsKey.split(',') }),
        })
        if (!res.ok || !alive) return
        const json = await res.json()
        if (!alive) return
        const next: Record<string, QuoteRow> = {}
        for (const q of json.quotes || []) {
          next[q.symbol] = { symbol: q.symbol, price: q.price, change: q.change, changePct: q.changePct }
        }
        setQuotes(next)
      } catch { /* offline */ }
    }
    fetchQ()
    const timer = setInterval(fetchQ, 10000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [itemsKey])

  // live symbol prediction: query the Alpaca-backed universe as the user types
  const fetchSuggestions = async (q: string) => {
    try {
      setSuggLoading(true)
      const res = await fetch(`/api/market/symbols?q=${encodeURIComponent(q)}`)
      if (!res.ok) return
      const json = (await res.json()) as { symbols?: SuggRow[] }
      const rows = (json.symbols || []).slice(0, 12)
      setSugg(rows)
      setSuggOpen(rows.length > 0)
      setSuggIdx(-1)
    } catch {
      /* offline — dropdown just stays closed */
    } finally {
      setSuggLoading(false)
    }
  }

  const onInputChange = (v: string) => {
    setNewSymbol(v)
    if (suggDebounce.current) clearTimeout(suggDebounce.current)
    const q = v.trim().toUpperCase()
    if (!q || /[^A-Z0-9./:\-]/.test(q) || q.length > 15) {
      setSugg([])
      setSuggOpen(false)
      return
    }
    suggDebounce.current = setTimeout(() => void fetchSuggestions(q), 160)
  }

  const closeSuggestions = () => {
    setSuggOpen(false)
    setSuggIdx(-1)
  }

  const addSymbol = async (raw?: string) => {
    const sym = (raw ?? newSymbol).trim().toUpperCase()
    if (!sym || !list) return
    const res = await addSymbolToWatchlist(list.id, sym)
    if (res.ok) {
      setNewSymbol('')
      closeSuggestions()
    } else {
      const desc =
        res.reason === 'duplicate'
          ? `${sym} is already in “${list.name}”.`
          : res.reason === 'invalid'
            ? `“${sym}” is not a valid symbol format (letters/digits, . - / only).`
            : res.reason === 'unknown'
              ? `“${sym}” was not found in the Alpaca asset universe. Pick a suggestion or check the spelling.`
              : 'Could not save — please try again.'
      toast({ title: 'Cannot add symbol', description: desc, variant: 'destructive' })
      if (res.reason === 'duplicate') {
        setNewSymbol('')
        closeSuggestions()
      }
    }
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && suggOpen && sugg.length > 0) {
      e.preventDefault()
      setSuggIdx((i) => Math.min(i + 1, sugg.length - 1))
    } else if (e.key === 'ArrowUp' && suggOpen && sugg.length > 0) {
      e.preventDefault()
      setSuggIdx((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Escape') {
      closeSuggestions()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // highlighted suggestion wins; otherwise validate the exact typed symbol
      // (unknown symbols are rejected with a clear error)
      const picked = suggOpen && suggIdx >= 0 && sugg[suggIdx] ? sugg[suggIdx].symbol : undefined
      void addSymbol(picked)
    }
  }

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    await createWatchlist(name, newColor)
    setNewName('')
    setNewColor(LIST_COLORS[0])
    setCreateOpen(false)
  }

  const sorted = useMemo(() => [...lists].sort((a, b) => a.sortOrder - b.sortOrder), [lists])

  return (
    <div className="flex h-full flex-col text-xs" ref={listRef}>
      {/* list switcher */}
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800/60 px-2 py-1.5">
        {sorted.map((l) => (
          <button
            key={l.id}
            onClick={() => setActiveWatchlist(l.id)}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              l.id === list?.id ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-transparent text-zinc-400 hover:bg-zinc-800/60',
            )}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
            {l.name}
            <span className="text-zinc-600">{l.items.length}</span>
          </button>
        ))}
        <Button variant="ghost" size="icon" className="h-5 w-5 text-zinc-500 hover:text-zinc-200" onClick={() => setCreateOpen(true)} aria-label="New watchlist">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {list && (
        <>
          {/* list actions */}
          <div className="flex items-center justify-between px-2 pt-1.5">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
              <Tag className="h-3 w-3" style={{ color: list.color }} /> {list.name}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-5 w-5 text-zinc-500 hover:text-zinc-200" aria-label="Watchlist options">
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-zinc-800 bg-zinc-900 text-xs">
                <DropdownMenuItem className="gap-2" onClick={() => void moveWatchlist(list.id, -1)}>
                  <ChevronUp className="h-3.5 w-3.5" /> Move up
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2" onClick={() => void moveWatchlist(list.id, 1)}>
                  <ChevronDown className="h-3.5 w-3.5" /> Move down
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-zinc-800" />
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <Palette className="h-3.5 w-3.5 text-zinc-500" />
                  {LIST_COLORS.map((c) => (
                    <button
                      key={c}
                      aria-label={`Set color ${c}`}
                      className={cn('h-3.5 w-3.5 rounded-full', list.color === c && 'ring-2 ring-white/70')}
                      style={{ backgroundColor: c }}
                      onClick={() => void updateWatchlist(list.id, { color: c })}
                    />
                  ))}
                </div>
                <DropdownMenuSeparator className="bg-zinc-800" />
                <DropdownMenuItem className="gap-2 text-rose-400" onClick={() => void deleteWatchlist(list.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete list
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* add symbol + prediction dropdown */}
          <div className="relative flex items-center gap-1 px-2 py-1.5" ref={inputBoxRef}>
            <div className="relative flex-1">
              <Input
                value={newSymbol}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onInputKeyDown}
                onBlur={(e) => {
                  if (!inputBoxRef.current?.contains(e.relatedTarget as Node)) closeSuggestions()
                }}
                placeholder="Add symbol (AAPL, BTC/USD)"
                autoComplete="off"
                spellCheck={false}
                className="h-6 border-zinc-800 bg-zinc-950 pr-6 text-[11px]"
              />
              {suggLoading && (
                <Loader2 className="absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-zinc-600" />
              )}
              {suggOpen && sugg.length > 0 && (
                <div
                  className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto terminal-scroll rounded-md border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl"
                  role="listbox"
                  aria-label="Symbol suggestions"
                >
                  {sugg.map((r, i) => (
                    <button
                      key={r.symbol}
                      type="button"
                      role="option"
                      aria-selected={i === suggIdx}
                      className={cn(
                        'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px]',
                        i === suggIdx ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/70',
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault() // keep input focus
                        void addSymbol(r.symbol)
                      }}
                      onMouseEnter={() => setSuggIdx(i)}
                    >
                      <span className="w-16 shrink-0 font-semibold">{r.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-zinc-500">{r.name || (r.crypto ? 'Crypto pair' : '')}</span>
                      {r.crypto ? (
                        <Badge variant="outline" className="shrink-0 border-amber-500/40 px-1 py-0 text-[8px] text-amber-400">7×24</Badge>
                      ) : (
                        <span className="shrink-0 text-[8px] uppercase tracking-wide text-zinc-600">US</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button size="sm" variant="secondary" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => void addSymbol()}>
              Add
            </Button>
          </div>

          {/* header */}
          <div className="grid grid-cols-[1fr_72px_64px_56px] items-center gap-1 border-b border-zinc-800/60 px-2 pb-1 text-[10px] uppercase tracking-wide text-zinc-500">
            <span>Symbol</span>
            <span className="text-right">Price</span>
            <span className="text-right">Chg</span>
            <span className="text-right">Chg%</span>
          </div>

          {/* rows */}
          <div className="min-h-0 flex-1 overflow-y-auto terminal-scroll">
            {list.items.length === 0 && (
              <p className="px-2 py-6 text-center text-[11px] text-zinc-500">Empty — add symbols above</p>
            )}
            {list.items.map((sym) => {
              const q = quotes[sym]
              const up = (q?.changePct ?? 0) >= 0
              const isActive = activeTab?.type === 'chart' && activeTab.symbol === sym
              return (
                <div
                  key={sym}
                  className={cn(
                    'group grid cursor-pointer grid-cols-[1fr_72px_64px_56px] items-center gap-1 px-2 py-1.5 hover:bg-zinc-800/60',
                    isActive && 'bg-emerald-500/5',
                  )}
                  onClick={() => selectSymbol(sym)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && selectSymbol(sym)}
                >
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-zinc-200">
                    <span className="truncate">{sym}</span>
                    {sym.includes('/') && <Badge variant="outline" className="border-amber-500/40 px-1 py-0 text-[8px] text-amber-400">7×24</Badge>}
                  </span>
                  <span className="text-right tabular-nums text-zinc-300">{q ? fmtPrice(q.price) : '—'}</span>
                  <span className={cn('text-right tabular-nums', q ? (up ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500')}>
                    {q ? `${up ? '+' : ''}${fmtPrice(q.change)}` : '—'}
                  </span>
                  <span className={cn('text-right tabular-nums', q ? (up ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500')}>
                    {q ? `${up ? '+' : ''}${q.changePct.toFixed(2)}%` : '—'}
                  </span>
                  <button
                    className="col-start-5 row-start-1 -mr-1 h-4 w-4 place-self-end rounded text-zinc-600 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                    aria-label={`Remove ${sym}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeSymbolFromWatchlist(list.id, sym)
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xs border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-sm text-zinc-100">New watchlist</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="List name"
            className="border-zinc-800 bg-zinc-950 text-sm"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Tag color</span>
            {LIST_COLORS.map((c) => (
              <button
                key={c}
                aria-label={`color ${c}`}
                className={cn('h-4 w-4 rounded-full', newColor === c && 'ring-2 ring-white/70')}
                style={{ backgroundColor: c }}
                onClick={() => setNewColor(c)}
              />
            ))}
          </div>
          <Button className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400" onClick={() => void create()}>
            Create list
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
