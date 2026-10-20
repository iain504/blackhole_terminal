'use client'

// Watchlist panel: multiple personal lists with tag colors; rows show
// symbol, price, daily change, daily % (Task 13 #2/#4, Task 16 #2).
// Symbol input has live prediction (symbols starting with the typed query,
// backed by the Alpaca asset universe) and rejects unknown symbols.
// Group separators (Task 51): an items entry starting with '#' ("#Tech")
// renders a user-defined section header — symbols can be dragged into/out of
// groups and the separator itself drags its whole block (order persists).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTerminal, Watchlist } from '@/store/terminal'
import { fmtPrice } from '@/lib/market-types'
import { subscribeStream } from '@/lib/stream-client'
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
import { Plus, MoreVertical, Trash2, ChevronUp, ChevronDown, Palette, X, Tag, Loader2, Pencil, GripVertical, FolderPlus } from 'lucide-react'

const LIST_COLORS = ['#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#e879f9', '#f4f4f5']

/** group separator marker: an items entry starting with '#' is a section
 *  header, not a symbol (symbol format /^[A-Z0-9./:-]+$/ can never clash) */
const isSep = (s: string) => s.startsWith('#')
/** number of real symbols between a separator (at idx) and the next one */
const groupSize = (items: string[], idx: number) => {
  let n = 0
  for (let j = idx + 1; j < items.length && !isSep(items[j]); j++) n++
  return n
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
  const reorderWatchlistSymbol = useTerminal((s) => s.reorderWatchlistSymbol)
  const addGroupToWatchlist = useTerminal((s) => s.addGroupToWatchlist)
  const renameWatchlistGroup = useTerminal((s) => s.renameWatchlistGroup)
  const deleteWatchlistGroup = useTerminal((s) => s.deleteWatchlistGroup)

  const [quotes, setQuotes] = useState<Record<string, QuoteRow>>({})
  const [newSymbol, setNewSymbol] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(LIST_COLORS[0])
  const [sugg, setSugg] = useState<SuggRow[]>([])
  const [suggOpen, setSuggOpen] = useState(false)
  const [suggIdx, setSuggIdx] = useState(-1)
  const [suggLoading, setSuggLoading] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const suggDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputBoxRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()

  // drag & drop reordering (HTML5): index of the row being dragged and the
  // insertion boundary it currently hovers over (drives the drop indicator line)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  // group create / rename dialogs
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupRenameOpen, setGroupRenameOpen] = useState(false)
  const [groupRenameName, setGroupRenameName] = useState('')
  const [groupRenameTarget, setGroupRenameTarget] = useState('')

  const list: Watchlist | undefined = lists.find((l) => l.id === activeId) || lists[0]

  // REST quotes are the reconciliation BACKSTOP for the live stream. The whole
  // list costs ONE batched request (server-side Alpaca snapshots endpoint;
  // 200 req/min plan limit → 6 req/min here, far under it). The cadence is
  // TICK-AWARE, not socket-aware: only when EVERY symbol actually received a
  // fresh stream tick (≤8s ago) do we drop to a ~30s reconcile; symbols
  // without a live upstream keep the full 10s poll (no simulated ticks exist
  // anymore). Skips entirely while the page is hidden; a hidden→visible
  // switch refreshes immediately.
  const itemsKey = (list?.items ?? []).filter((i) => !isSep(i)).join(',')
  const tickAtRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    if (!itemsKey) return
    let alive = true
    let n = 0
    const syms = itemsKey.split(',')
    tickAtRef.current.clear() // symbol set changed — freshness starts over
    const streamFresh = (s: string, now: number) => {
      const at = tickAtRef.current.get(s)
      return at != null && now - at < 8000
    }
    const fetchQ = async () => {
      if (document.hidden) return // background tab — save the API budget
      const now = Date.now()
      if (syms.every((s) => streamFresh(s, now)) && ++n % 3 !== 1) return // whole list streaming → reconcile every 30s
      try {
        const res = await fetch('/api/market/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: syms }),
        })
        if (!res.ok || !alive) return
        const json = await res.json()
        if (!alive) return
        const at = Date.now()
        const next: Record<string, QuoteRow> = {}
        for (const q of json.quotes || []) {
          if (streamFresh(q.symbol, at)) continue // a cached REST snapshot must not yank a live tick backwards
          next[q.symbol] = { symbol: q.symbol, price: q.price, change: q.change, changePct: q.changePct }
        }
        setQuotes((prev) => {
          const merged: Record<string, QuoteRow> = { ...next }
          for (const s of syms) {
            // rows with a fresh live tick keep their streamed value
            if (!merged[s] && prev[s] && streamFresh(s, at)) merged[s] = prev[s]
          }
          return merged
        })
      } catch { /* offline */ }
    }
    fetchQ()
    const timer = setInterval(fetchQ, 10000)
    const onVis = () => {
      if (!document.hidden) void fetchQ()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [itemsKey])

  // stream ticks: the PRIMARY price source between REST reconciliations
  // (crypto streams from Binance; stocks from the one shared Alpaca websocket
  // when the keys pass its data-stream auth — simulated ticks are PERMANENTLY
  // disabled: symbols without a live upstream fall back to the 10s REST poll)
  useEffect(() => {
    if (!itemsKey) return
    return subscribeStream(itemsKey.split(','), (t) => {
      tickAtRef.current.set(t.s, Date.now())
      setQuotes((prev) => {
        const row = prev[t.s]
        if (!row) return prev
        const prevClose = row.price - row.change // implied by the last REST row
        const change = t.p - prevClose
        return {
          ...prev,
          [t.s]: {
            ...row,
            price: t.p,
            change,
            changePct: prevClose ? (change / prevClose) * 100 : row.changePct,
          },
        }
      })
    })
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
            ? `A group or symbol named “${name}” already exists in “${list.name}”.`
            : res.reason === 'invalid'
              ? 'Group name must be 1-24 characters.'
              : 'Could not save — please try again.',
        variant: 'destructive',
      })
    }
  }

  const submitGroupRename = async () => {
    if (!list || !groupRenameTarget) return
    const name = groupRenameName.trim()
    if (!name || name === groupRenameTarget) {
      setGroupRenameOpen(false)
      return
    }
    const res = await renameWatchlistGroup(list.id, groupRenameTarget, name)
    if (res.ok) {
      setGroupRenameOpen(false)
    } else {
      toast({
        title: 'Cannot rename group',
        description:
          res.reason === 'duplicate'
            ? `A group or symbol named “${name}” already exists in “${list.name}”.`
            : res.reason === 'invalid'
              ? 'Group name must be 1-24 characters.'
              : 'Could not save — please try again.',
        variant: 'destructive',
      })
    }
  }

  const openRename = (l: Watchlist) => {
    setRenameTargetId(l.id)
    setRenameName(l.name)
    setRenameOpen(true)
  }

  const submitRename = async () => {
    if (!renameTargetId) return
    const name = renameName.trim()
    if (!name) return
    const original = lists.find((l) => l.id === renameTargetId)
    if (original && name === original.name) {
      setRenameOpen(false)
      return
    }
    try {
      setRenaming(true)
      await updateWatchlist(renameTargetId, { name })
      toast({ title: 'Watchlist renamed', description: `Now “${name}”.` })
      setRenameOpen(false)
    } catch {
      toast({ title: 'Rename failed', description: 'Could not save the new name — please try again.', variant: 'destructive' })
    } finally {
      setRenaming(false)
    }
  }

  const sorted = useMemo(() => [...lists].sort((a, b) => a.sortOrder - b.sortOrder), [lists])

  // drop: move the dragged symbol to the hovered insertion index (top half of
  // a row → its index, bottom half → after it). No-op drops (on itself / right
  // below itself) are skipped.
  const onRowDrop = (toIdx: number) => {
    if (dragFrom != null && list && toIdx !== dragFrom && toIdx !== dragFrom + 1) {
      void reorderWatchlistSymbol(list.id, dragFrom, toIdx)
    }
    setDragFrom(null)
    setDragOver(null)
  }

  // separator rows: a dragged SYMBOL always drops BELOW the marker (first row
  // of that group); a dragged SEPARATOR keeps the regular half-row boundaries
  // and moves its whole block (store handles the block extraction)
  const onSepDragOver = (e: React.DragEvent<HTMLDivElement>, idx: number) => {
    if (dragFrom == null || !list) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (isSep(list.items[dragFrom])) {
      const r = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      const target = after ? idx + 1 : idx
      setDragOver(target === dragFrom || target === dragFrom + 1 ? null : target)
    } else {
      setDragOver(idx + 1)
    }
  }

  const onSepDrop = (e: React.DragEvent<HTMLDivElement>, idx: number) => {
    e.preventDefault()
    if (dragFrom == null || !list) {
      setDragFrom(null)
      setDragOver(null)
      return
    }
    if (isSep(list.items[dragFrom])) {
      const r = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      const toIdx = after ? idx + 1 : idx
      if (toIdx !== dragFrom && toIdx !== dragFrom + 1) {
        void reorderWatchlistSymbol(list.id, dragFrom, toIdx)
      }
    } else {
      // land as the FIRST row of the group: insertion boundary below the
      // marker; when moving down the store's offset eats one — compensate so
      // the symbol ends up after the marker in both directions
      const toIdx = idx + 1
      const to = dragFrom < toIdx ? toIdx + 1 : toIdx
      if (to !== dragFrom && to !== dragFrom + 1) {
        void reorderWatchlistSymbol(list.id, dragFrom, to)
      }
    }
    setDragFrom(null)
    setDragOver(null)
  }

  return (
    <div className="flex h-full flex-col text-xs" ref={listRef}>
      {/* list switcher */}
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800/60 px-2 py-1.5">
        {sorted.map((l) => (
          <button
            key={l.id}
            onClick={() => setActiveWatchlist(l.id)}
            onDoubleClick={() => openRename(l)}
            title={`${l.name} — double-click to rename`}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              l.id === list?.id ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-transparent text-zinc-400 hover:bg-zinc-800/60',
            )}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
            {l.name}
            <span className="text-zinc-600">{l.items.filter((i) => !isSep(i)).length}</span>
          </button>
        ))}
        <Button variant="ghost" size="icon" className="h-5 w-5 text-zinc-500 hover:text-zinc-200" onClick={() => setCreateOpen(true)} aria-label="New watchlist">
          <Plus className="h-3.5 w-3.5" />
        </Button>
        {list && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-zinc-500 hover:text-zinc-200"
            onClick={() => { setGroupName(''); setGroupOpen(true) }}
            aria-label="New group separator"
            title="New group separator (e.g. Tech, Health)"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        )}
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
                <DropdownMenuItem className="gap-2" onClick={() => openRename(list)}>
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </DropdownMenuItem>
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
            {list.items.map((entry, idx) => {
              if (isSep(entry)) {
                // ---- group separator (user-defined section header) ----
                const name = entry.slice(1)
                const draggingSep = dragFrom != null && isSep(list.items[dragFrom])
                const isDragged = dragFrom === idx
                const dropAbove = draggingSep && dragOver === idx
                const dropBelow = dragFrom != null && dragOver === idx + 1
                return (
                  <div
                    key={`${entry}-${idx}`}
                    className={cn(
                      'group flex cursor-pointer items-center gap-1 border-l-2 px-2 py-1',
                      isDragged && 'opacity-40',
                      dropAbove && 'border-t-2 border-t-emerald-500',
                      dropBelow && 'border-b-2 border-b-emerald-500',
                    )}
                    style={{ borderLeftColor: list.color }}
                    draggable
                    onDragStart={(e) => {
                      setDragFrom(idx)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', entry) // required by Firefox
                    }}
                    onDragOver={(e) => onSepDragOver(e, idx)}
                    onDrop={(e) => onSepDrop(e, idx)}
                    onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                  >
                    <GripVertical
                      className="h-3 w-3 shrink-0 cursor-grab text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-[10px] font-bold uppercase tracking-widest text-zinc-300">
                      {name}
                    </span>
                    <span className="text-[10px] tabular-nums text-zinc-600">{groupSize(list.items, idx)}</span>
                    <button
                      className="h-4 w-4 shrink-0 rounded text-zinc-600 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
                      aria-label={`Rename group ${name}`}
                      title="Rename group"
                      onClick={(e) => {
                        e.stopPropagation()
                        setGroupRenameTarget(name)
                        setGroupRenameName(name)
                        setGroupRenameOpen(true)
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      className="-mr-1 h-4 w-4 shrink-0 rounded text-zinc-600 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                      aria-label={`Delete group ${name} (symbols are kept)`}
                      title="Delete group (symbols are kept)"
                      onClick={(e) => {
                        e.stopPropagation()
                        void deleteWatchlistGroup(list.id, name)
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )
              }
              const sym = entry
              const q = quotes[sym]
              const up = (q?.changePct ?? 0) >= 0
              const isActive = activeTab?.type === 'chart' && activeTab.symbol === sym
              const isDragged = dragFrom === idx
              // insertion line: dragOver holds the TARGET index (0..items.length)
              // — above this row when it equals idx, below when it equals idx+1
              const dropAbove = dragFrom != null && dragOver === idx
              const dropBelow = dragFrom != null && dragOver === idx + 1
              return (
                <div
                  key={sym}
                  className={cn(
                    'group grid cursor-pointer grid-cols-[1fr_72px_64px_56px] items-center gap-1 px-2 py-1.5 hover:bg-zinc-800/60',
                    isActive && 'bg-emerald-500/5',
                    isDragged && 'opacity-40',
                    dropAbove && 'border-t-2 border-t-emerald-500',
                    dropBelow && 'border-b-2 border-b-emerald-500',
                  )}
                  onClick={() => selectSymbol(sym)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && selectSymbol(sym)}
                  draggable
                  onDragStart={(e) => {
                    setDragFrom(idx)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', sym) // required by Firefox
                  }}
                  onDragOver={(e) => {
                    if (dragFrom == null) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    const r = e.currentTarget.getBoundingClientRect()
                    const after = e.clientY > r.top + r.height / 2
                    const target = after ? idx + 1 : idx
                    setDragOver(target === dragFrom || target === dragFrom + 1 ? null : target)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    // dropping in the bottom half of the LAST row → after it
                    const r = e.currentTarget.getBoundingClientRect()
                    const after = e.clientY > r.top + r.height / 2
                    onRowDrop(after ? idx + 1 : idx)
                  }}
                  onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                >
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-zinc-200">
                    <GripVertical
                      className="h-3 w-3 shrink-0 cursor-grab text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
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

      {/* rename dialog */}
      <Dialog open={renameOpen} onOpenChange={(o) => { if (!renaming) setRenameOpen(o) }}>
        <DialogContent className="max-w-xs border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-sm text-zinc-100">Rename watchlist</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameName}
            maxLength={40}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && renameName.trim()) void submitRename() }}
            onFocus={(e) => e.target.select()}
            placeholder="List name"
            aria-label="New watchlist name"
            className="border-zinc-800 bg-zinc-950 text-sm"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-600">{renameName.trim().length}/40</span>
            <Button
              className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
              disabled={!renameName.trim() || renaming}
              onClick={() => void submitRename()}
            >
              <span className="flex items-center gap-1.5">
                {renaming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save name
              </span>
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* new group separator dialog */}
      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent className="max-w-xs border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-sm text-zinc-100">New group separator</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={groupName}
            maxLength={24}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createGroup()}
            placeholder="Group name (Tech, Health…)"
            aria-label="Group name"
            className="border-zinc-800 bg-zinc-950 text-sm"
          />
          <p className="text-[10px] leading-4 text-zinc-600">
            Drag symbols onto the separator to group them; drag the separator to move the whole group.
          </p>
          <Button className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400" disabled={!groupName.trim()} onClick={() => void createGroup()}>
            Create group
          </Button>
        </DialogContent>
      </Dialog>

      {/* rename group dialog */}
      <Dialog open={groupRenameOpen} onOpenChange={setGroupRenameOpen}>
        <DialogContent className="max-w-xs border-zinc-800 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="text-sm text-zinc-100">Rename group</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={groupRenameName}
            maxLength={24}
            onChange={(e) => setGroupRenameName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitGroupRename()}
            onFocus={(e) => e.target.select()}
            placeholder="Group name"
            aria-label="New group name"
            className="border-zinc-800 bg-zinc-950 text-sm"
          />
          <Button className="bg-emerald-500 text-zinc-950 hover:bg-emerald-400" disabled={!groupRenameName.trim()} onClick={() => void submitGroupRename()}>
            Save name
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
