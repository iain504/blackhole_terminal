'use client'

// Watchlist panel: multiple personal lists with tag colors; rows show
// symbol, price, daily change, daily % (Task 13 #2/#4, Task 16 #2).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal, Watchlist } from '@/store/terminal'
import { fmtPrice } from '@/lib/market-types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Plus, MoreVertical, Trash2, ChevronUp, ChevronDown, Palette, X, Tag } from 'lucide-react'

const LIST_COLORS = ['#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#e879f9', '#f4f4f5']

interface QuoteRow {
  symbol: string
  price: number
  change: number
  changePct: number
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
  const listRef = useRef<HTMLDivElement>(null)

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

  const addSymbol = async () => {
    const sym = newSymbol.trim().toUpperCase()
    if (!sym || !list) return
    const ok = await addSymbolToWatchlist(list.id, sym)
    if (ok) setNewSymbol('')
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

          {/* add symbol */}
          <div className="flex items-center gap-1 px-2 py-1.5">
            <Input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addSymbol()}
              placeholder="Add symbol (AAPL, BTC/USD)"
              className="h-6 border-zinc-800 bg-zinc-950 text-[11px]"
            />
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
