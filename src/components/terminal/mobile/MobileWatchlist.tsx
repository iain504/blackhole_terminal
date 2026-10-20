'use client'

// Mobile watchlist view (Task 56) — clones the TradingView mobile app screen
// from the user's dump (IMG_1748): full-screen list with a header (manager ⋯ ·
// logo · add +), scrollable watchlist tabs, user group sections (#separators),
// and large touch rows — colored avatar circle · symbol · name · price ·
// change/+%. Tapping a row opens it in the mobile chart view.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal, Watchlist } from '@/store/terminal'
import { fmtPrice } from '@/lib/market-types'
import { subscribeStream } from '@/lib/stream-client'
import { useSymbolNames } from '@/hooks/use-symbol-names'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus, Ellipsis, Pencil, Trash2, FolderPlus, Loader2, ChevronUp, ChevronDown, Search,
} from 'lucide-react'

const isSep = (s: string) => s.startsWith('#')

/** deterministic avatar background per symbol (no blue/indigo) */
const AVATAR_COLORS = ['#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#e879f9', '#84cc16', '#f97316', '#14b8a6', '#eab308']
function avatarColor(sym: string): string {
  let h = 0
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
function avatarInitial(sym: string): string {
  const base = sym.split('/')[0] || sym
  return (base[0] || '?').toUpperCase()
}

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

export function MobileWatchlist({ onOpenChart }: { onOpenChart: (symbol: string) => void }) {
  const lists = useTerminal((s) => s.watchlists)
  const activeId = useTerminal((s) => s.activeWatchlistId)
  const setActiveWatchlist = useTerminal((s) => s.setActiveWatchlist)
  const addSymbolToWatchlist = useTerminal((s) => s.addSymbolToWatchlist)
  const createWatchlist = useTerminal((s) => s.createWatchlist)
  const deleteWatchlist = useTerminal((s) => s.deleteWatchlist)
  const updateWatchlist = useTerminal((s) => s.updateWatchlist)
  const moveWatchlist = useTerminal((s) => s.moveWatchlist)
  const addGroupToWatchlist = useTerminal((s) => s.addGroupToWatchlist)

  const { toast } = useToast()
  const [quotes, setQuotes] = useState<Record<string, QuoteRow>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [sugg, setSugg] = useState<SuggRow[]>([])
  const [suggLoading, setSuggLoading] = useState(false)
  const suggDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#22c55e')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupName, setGroupName] = useState('')

  const list: Watchlist | undefined = lists.find((l) => l.id === activeId) || lists[0]
  const symbols = useMemo(() => (list?.items ?? []).filter((i) => !isSep(i)), [list])
  const names = useSymbolNames(symbols)
  const nameOf = (sym: string): string => {
    const n = names[sym]
    if (n) return n
    if (sym.includes('/')) return 'Crypto pair · 7×24'
    return ''
  }

  // ---- quotes: 10s REST batch + live stream ticks (compact mobile version
  // of the WatchlistPanel reconciliation — no tick-aware backoff needed here) ----
  const itemsKey = symbols.join(',')
  useEffect(() => {
    if (!itemsKey) return
    let alive = true
    const syms = itemsKey.split(',')
    const fetchQ = async () => {
      if (document.hidden) return
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: syms }),
        })
        if (!res.ok || !alive) return
        const json = await res.json()
        if (!alive) return
        const next: Record<string, QuoteRow> = {}
        for (const q of json.quotes || []) {
          next[q.symbol] = { symbol: q.symbol, price: q.price, change: q.change, changePct: q.changePct }
        }
        if (Object.keys(next).length > 0) setQuotes((prev) => ({ ...prev, ...next }))
      } catch {
        /* offline */
      }
    }
    fetchQ()
    const timer = setInterval(fetchQ, 10000)
    const unsub = subscribeStream(syms, (t) => {
      setQuotes((prev) => {
        const row = prev[t.s]
        if (!row) return prev
        const prevClose = row.price - row.change
        const change = t.p - prevClose
        return {
          ...prev,
          [t.s]: { ...row, price: t.p, change, changePct: prevClose ? (change / prevClose) * 100 : row.changePct },
        }
      })
    })
    return () => {
      alive = false
      clearInterval(timer)
      unsub()
    }
  }, [itemsKey])

  // ---- add symbol with live prediction ----
  const fetchSuggestions = async (q: string) => {
    try {
      setSuggLoading(true)
      const res = await fetch(`/api/market/symbols?q=${encodeURIComponent(q)}`)
      if (!res.ok) return
      const json = (await res.json()) as { symbols?: SuggRow[] }
      setSugg((json.symbols || []).slice(0, 10))
    } catch {
      /* offline — dropdown stays as-is */
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
      return
    }
    suggDebounce.current = setTimeout(() => void fetchSuggestions(q), 160)
  }

  const addSymbol = async (raw?: string) => {
    const sym = (raw ?? newSymbol).trim().toUpperCase()
    if (!sym || !list) return
    const res = await addSymbolToWatchlist(list.id, sym)
    if (res.ok) {
      setNewSymbol('')
      setSugg([])
    } else {
      const desc =
        res.reason === 'duplicate'
          ? `${sym} is already in “${list.name}”.`
          : res.reason === 'invalid'
            ? `“${sym}” is not a valid symbol format.`
            : res.reason === 'unknown'
              ? `“${sym}” was not found — pick a suggestion.`
              : 'Could not save — please try again.'
      toast({ title: 'Cannot add symbol', description: desc, variant: 'destructive' })
    }
  }

  const createList = async () => {
    const name = newName.trim()
    if (!name) return
    await createWatchlist(name, newColor)
    setNewName('')
    setNewColor('#22c55e')
    setCreateOpen(false)
  }

  const createGroup = async () => {
    if (!list) return
    const name = groupName.trim()
    if (!name) return
    const res = await addGroupToWatchlist(list.id, name)
    if (res.ok) {
      setGroupName('')
      setGroupOpen(false)
    } else {
      toast({
        title: 'Cannot create group',
        description:
          res.reason === 'duplicate'
            ? `A group or symbol named “${name}” already exists.`
            : 'Group name must be 1-24 characters.',
        variant: 'destructive',
      })
    }
  }

  const submitRename = async () => {
    if (!list) return
    const name = renameName.trim()
    if (!name || name === list.name) {
      setRenameOpen(false)
      return
    }
    try {
      await updateWatchlist(list.id, { name })
      setRenameOpen(false)
    } catch {
      toast({ title: 'Rename failed', description: 'Could not save the new name.', variant: 'destructive' })
    }
  }

  const sortedLists = useMemo(() => [...lists].sort((a, b) => a.sortOrder - b.sortOrder), [lists])

  // render rows split by group separators — pre-group symbols first, then
  // each #section header followed by its symbols (like the dump's CURRENCY/CFD)
  const sections = useMemo(() => {
    const items = list?.items ?? []
    const pre: string[] = []
    const groups: { name: string; symbols: string[] }[] = []
    let current: { name: string; symbols: string[] } | null = null
    for (const entry of items) {
      if (isSep(entry)) {
        current = { name: entry.slice(1), symbols: [] }
        groups.push(current)
      } else if (current) {
        current.symbols.push(entry)
      } else {
        pre.push(entry)
      }
    }
    return { pre, groups }
  }, [list])

  const renderRow = (sym: string) => {
    const q = quotes[sym]
    const up = (q?.changePct ?? 0) >= 0
    const sub = nameOf(sym)
    return (
      <button
        key={sym}
        type="button"
        onClick={() => onOpenChart(sym)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors active:bg-zinc-800/60"
        aria-label={`Open ${sym} chart${q ? ` — ${fmtPrice(q.price)} ${up ? '+' : ''}${q.changePct.toFixed(2)}%` : ''}`}
      >
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-zinc-950"
          style={{ backgroundColor: avatarColor(sym) }}
        >
          {avatarInitial(sym)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-zinc-100">{sym}</span>
            {sym.includes('/') && (
              <Badge variant="outline" className="shrink-0 border-amber-500/40 px-1 py-0 text-[8px] text-amber-400">
                7×24
              </Badge>
            )}
          </span>
          <span className="block truncate text-xs text-zinc-500">{sub || '\u00A0'}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[15px] font-semibold tabular-nums text-zinc-100">
            {q ? fmtPrice(q.price) : '—'}
          </span>
          <span className={cn('block text-xs tabular-nums', q ? (up ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-600')}>
            {q ? `${up ? '+' : ''}${fmtPrice(q.change)}  ${up ? '+' : ''}${q.changePct.toFixed(2)}%` : '\u00A0'}
          </span>
        </span>
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950">
      {/* ---- header: manager ⋯ · logo · add + (clone of the dump's top bar) ---- */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800/60 px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-zinc-300" aria-label="Watchlist options">
              <Ellipsis className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="border-zinc-800 bg-zinc-900 text-sm">
            <DropdownMenuItem className="gap-2" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New watchlist
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setGroupOpen(true)}>
              <FolderPlus className="h-4 w-4" /> New group section
            </DropdownMenuItem>
            {list && (
              <>
                <DropdownMenuItem className="gap-2" onClick={() => { setRenameName(list.name); setRenameOpen(true) }}>
                  <Pencil className="h-4 w-4" /> Rename “{list.name}”
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2" onClick={() => void moveWatchlist(list.id, -1)}>
                  <ChevronUp className="h-4 w-4" /> Move list up
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2" onClick={() => void moveWatchlist(list.id, 1)}>
                  <ChevronDown className="h-4 w-4" /> Move list down
                </DropdownMenuItem>
                <div className="flex items-center gap-2 px-2 py-2">
                  <Pencil className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                  {['#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#e879f9', '#f4f4f5'].map((c) => (
                    <button
                      key={c}
                      aria-label={`Set list color ${c}`}
                      className={cn('h-4 w-4 rounded-full', list.color === c && 'ring-2 ring-white/70')}
                      style={{ backgroundColor: c }}
                      onClick={() => void updateWatchlist(list.id, { color: c })}
                    />
                  ))}
                </div>
                <DropdownMenuSeparator className="bg-zinc-800" />
                <DropdownMenuItem
                  className="gap-2 text-rose-400"
                  onClick={() => {
                    void deleteWatchlist(list.id)
                    toast({ title: 'Watchlist deleted', description: `“${list.name}” was removed.` })
                  }}
                >
                  <Trash2 className="h-4 w-4" /> Delete list
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-emerald-400" />
          <span className="text-sm font-bold tracking-widest text-zinc-100">BLACKHOLE</span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-zinc-300"
          aria-label="Add symbol"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="h-5 w-5" />
        </Button>
      </header>

      {/* ---- watchlist tabs (scrollable pills) ---- */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto terminal-scroll px-3 py-2" role="tablist" aria-label="Watchlists">
        {sortedLists.map((l) => {
          const isActive = l.id === list?.id
          return (
            <button
              key={l.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveWatchlist(l.id)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors',
                isActive ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800 bg-zinc-900/60 text-zinc-400',
              )}
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
              {l.name}
              <span className="text-[11px] text-zinc-500">{l.items.filter((i) => !isSep(i)).length}</span>
            </button>
          )
        })}
        <button
          onClick={() => setCreateOpen(true)}
          aria-label="New watchlist"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-700 text-zinc-500"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* ---- rows: pre-group symbols, then #group sections ---- */}
      <div className="min-h-0 flex-1 overflow-y-auto terminal-scroll pb-4" role="list">
        {!list && <p className="px-4 py-10 text-center text-sm text-zinc-500">No watchlists yet — create one with +</p>}
        {list && symbols.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            Empty — tap <span className="text-zinc-300">+</span> to add symbols
          </p>
        )}
        {list && sections.pre.map(renderRow)}
        {list &&
          sections.groups.map((g) => (
            <section key={g.name} aria-label={g.name}>
              <h2 className="px-4 pb-1 pt-4 text-[11px] font-bold uppercase tracking-widest text-zinc-500">{g.name}</h2>
              {g.symbols.map(renderRow)}
            </section>
          ))}
      </div>

      {/* ---- add symbol sheet ---- */}
      <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) { setSugg([]) } }}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-base text-zinc-100">Add symbol {list ? `to “${list.name}”` : ''}</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
            <Input
              autoFocus
              value={newSymbol}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void addSymbol(sugg[0]?.symbol)
                }
              }}
              placeholder="AAPL, BTC/USD…"
              autoComplete="off"
              spellCheck={false}
              className="h-11 border-zinc-800 bg-zinc-950 pl-8 text-base"
              aria-label="Symbol to add"
            />
            {suggLoading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-600" />}
          </div>
          {sugg.length > 0 && (
            <div className="max-h-56 overflow-y-auto terminal-scroll rounded-lg border border-zinc-800 bg-zinc-950" role="listbox" aria-label="Symbol suggestions">
              {sugg.map((r) => (
                <button
                  key={r.symbol}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-zinc-200 active:bg-zinc-800"
                  onClick={() => void addSymbol(r.symbol)}
                >
                  <span className="w-20 shrink-0 font-semibold">{r.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-500">{r.name || (r.crypto ? 'Crypto pair' : '')}</span>
                  {r.crypto && <Badge variant="outline" className="shrink-0 border-amber-500/40 px-1 py-0 text-[8px] text-amber-400">7×24</Badge>}
                </button>
              ))}
            </div>
          )}
          <Button className="h-10 bg-emerald-500 text-base text-zinc-950 hover:bg-emerald-400" onClick={() => void addSymbol()} disabled={!newSymbol.trim()}>
            Add to watchlist
          </Button>
        </DialogContent>
      </Dialog>

      {/* ---- new watchlist ---- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-base text-zinc-100">New watchlist</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createList()}
            placeholder="List name"
            className="h-11 border-zinc-800 bg-zinc-950 text-base"
            aria-label="Watchlist name"
          />
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-500">Tag color</span>
            {['#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#e879f9', '#f4f4f5'].map((c) => (
              <button
                key={c}
                aria-label={`color ${c}`}
                className={cn('h-5 w-5 rounded-full', newColor === c && 'ring-2 ring-white/70')}
                style={{ backgroundColor: c }}
                onClick={() => setNewColor(c)}
              />
            ))}
          </div>
          <Button className="h-10 bg-emerald-500 text-zinc-950 hover:bg-emerald-400" onClick={() => void createList()}>
            Create list
          </Button>
        </DialogContent>
      </Dialog>

      {/* ---- rename watchlist ---- */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-base text-zinc-100">Rename watchlist</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameName}
            maxLength={40}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitRename()}
            className="h-11 border-zinc-800 bg-zinc-950 text-base"
            aria-label="New watchlist name"
          />
          <Button className="h-10 bg-emerald-500 text-zinc-950 hover:bg-emerald-400" disabled={!renameName.trim()} onClick={() => void submitRename()}>
            Save name
          </Button>
        </DialogContent>
      </Dialog>

      {/* ---- new group section ---- */}
      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-base text-zinc-100">New group section</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={groupName}
            maxLength={24}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createGroup()}
            placeholder="Group name (Currency, CFD…)"
            className="h-11 border-zinc-800 bg-zinc-950 text-base"
            aria-label="Group name"
          />
          <p className="text-xs leading-4 text-zinc-500">
            Sections render like the TradingView app headers. Manage symbol order from the desktop terminal.
          </p>
          <Button className="h-10 bg-emerald-500 text-zinc-950 hover:bg-emerald-400" disabled={!groupName.trim()} onClick={() => void createGroup()}>
            Create group
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
