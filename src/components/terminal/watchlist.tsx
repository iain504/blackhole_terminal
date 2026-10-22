"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, Loader2, Pencil, Plus, Trash2, TrendingDown, TrendingUp, X } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { usePoll } from "@/hooks/use-poll";
import { fetchMovers, fetchSnapshots } from "@/lib/client-api";
import { fmtNum, fmtPct, upDownClass } from "@/lib/format";
import { useTerminal } from "@/lib/store";
import { LIST_COLORS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SymbolSearch } from "./symbol-search";

/** Columns: symbol · price · daily change · daily % change (+ remove).
 *  Price/chg columns are wide enough for grouped 5-digit prices (BTC) and
 *  sub-cent changes (SHIB) rendered by fmtNum. */
const GRID =
  "grid grid-cols-[minmax(0,1fr)_68px_54px_52px_16px] items-center gap-1";
const GRID_MOVERS = "grid grid-cols-[minmax(0,1fr)_68px_54px_52px] items-center gap-1";

function QuoteCols({ change, changePct }: { change: number; changePct: number }) {
  return (
    <>
      <span className={cn("text-right font-mono text-[10px]", upDownClass(change))}>
        {change >= 0 ? "+" : ""}
        {fmtNum(change)}
      </span>
      <span className={cn("text-right font-mono text-[10px]", upDownClass(changePct))}>{fmtPct(changePct)}</span>
    </>
  );
}

function ColHeader({ extra }: { extra?: boolean }) {
  return (
    <div
      className={cn(
        "sticky top-0 z-[1] bg-[#131722] px-2 pb-1.5 pt-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#4a4f5c]",
        extra ? GRID : GRID_MOVERS
      )}
    >
      <span>Symbol</span>
      <span className="text-right">Price</span>
      <span className="text-right">Chg</span>
      <span className="text-right">Chg%</span>
      {extra && <span />}
    </div>
  );
}

function MoverRows({ direction }: { direction: "gainers" | "losers" }) {
  const setSymbol = useTerminal((s) => s.setSymbol);
  const symbol = useTerminal((s) => s.symbol);
  const { data, loading } = usePoll(() => fetchMovers(), 30000, []);
  const rows = data?.[direction] ?? [];

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-[#787b86]" />
      </div>
    );
  }
  if (!rows.length) {
    return <p className="px-3 py-6 text-center text-xs text-[#787b86]">No movers available</p>;
  }
  return (
    <div className="px-1.5 py-1">
      {rows.map((m) => (
        <button
          key={m.symbol}
          onClick={() => setSymbol(m.symbol)}
          className={cn(
            GRID_MOVERS,
            "w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-[#2a2e39]",
            symbol === m.symbol && "bg-[#2a2e39]/60"
          )}
        >
          {direction === "gainers" ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 shrink-0 text-[#26a69a]" />
              <span className="truncate font-mono text-xs font-semibold text-[#d1d4dc]">{m.symbol}</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              <TrendingDown className="h-3.5 w-3.5 shrink-0 text-[#ef5350]" />
              <span className="truncate font-mono text-xs font-semibold text-[#d1d4dc]">{m.symbol}</span>
            </span>
          )}
          <span className="text-right font-mono text-xs text-[#d1d4dc]">{fmtNum(m.price)}</span>
          <QuoteCols change={m.change} changePct={m.changePct} />
        </button>
      ))}
    </div>
  );
}

type ListDialogState = { mode: "create" } | { mode: "edit"; id: string } | null;

function ListDialog({ state, onClose }: { state: NonNullable<ListDialogState>; onClose: () => void }) {
  const watchlists = useTerminal((s) => s.watchlists);
  const editing = state.mode === "edit" ? watchlists.find((l) => l.id === state.id) ?? null : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [color, setColor] = useState(editing?.color ?? LIST_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length >= 1;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    if (state.mode === "create") {
      await useTerminal.getState().createList(name.trim(), color);
    } else {
      await useTerminal.getState().updateList(state.id, { name: name.trim(), color });
    }
    setBusy(false);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xs border-[#2a2e39] bg-[#1e222d] p-4">
        <DialogHeader>
          <DialogTitle className="text-sm">{editing ? "Edit watchlist" : "New watchlist"}</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="List name"
          maxLength={24}
          autoFocus
          className="border-[#2a2e39] bg-[#161a25] text-sm"
          aria-label="Watchlist name"
        />
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Tag color">
          {LIST_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={`Tag color ${c}`}
              onClick={() => setColor(c)}
              className={cn(
                "h-6 w-6 rounded-full border-2 transition-transform",
                color === c ? "scale-110 border-white" : "border-transparent hover:scale-105"
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            className="border-[#2a2e39] bg-transparent text-xs hover:bg-[#2a2e39] hover:text-white"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!valid || busy}
            onClick={() => void submit()}
            className="bg-[#26a69a] text-xs text-white hover:bg-[#26a69a]/85"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Active-list switcher: colored dot + name, with create / rename / recolor / delete. */
function ListPicker() {
  const watchlists = useTerminal((s) => s.watchlists);
  const activeListId = useTerminal((s) => s.activeListId);
  const setActiveList = useTerminal((s) => s.setActiveList);
  const [dialog, setDialog] = useState<ListDialogState>(null);
  const active = watchlists.find((l) => l.id === activeListId) ?? watchlists[0] ?? null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex h-7 min-w-0 items-center gap-1.5 rounded px-1.5 text-[11px] font-semibold text-[#d1d4dc] transition-colors hover:bg-[#2a2e39]"
            title="Switch watchlist"
            aria-label="Switch watchlist"
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: active?.color ?? "#26a69a" }} />
            <span className="max-w-[72px] truncate">{active?.name ?? "Watchlist"}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-[#787b86]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 border-[#2a2e39] bg-[#1e222d]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-[#787b86]">
            Watchlists
          </DropdownMenuLabel>
          {watchlists.map((l) => (
            <DropdownMenuItem key={l.id} onSelect={() => setActiveList(l.id)} className="gap-2 text-xs">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
              <span className="flex-1 truncate">{l.name}</span>
              <span className="font-mono text-[10px] text-[#787b86]">{l.symbols.length}</span>
              {l.id === activeListId && <Check className="h-3.5 w-3.5 text-[#26a69a]" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="bg-[#2a2e39]" />
          <DropdownMenuItem onSelect={() => setDialog({ mode: "create" })} className="gap-2 text-xs">
            <Plus className="h-3.5 w-3.5" /> New list…
          </DropdownMenuItem>
          {active && (
            <DropdownMenuItem
              onSelect={() => setDialog({ mode: "edit", id: active.id })}
              className="gap-2 text-xs"
            >
              <Pencil className="h-3.5 w-3.5" /> Rename / color…
            </DropdownMenuItem>
          )}
          {active && watchlists.length > 1 && (
            <DropdownMenuItem
              onSelect={() => void useTerminal.getState().removeList(active.id)}
              className="gap-2 text-xs text-[#ef5350] focus:text-[#ef5350]"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete “{active.name}”
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog && <ListDialog state={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

export function WatchlistContent({ controls }: { controls?: ReactNode }) {
  const watchlist = useTerminal((s) => s.watchlist);
  const watchlists = useTerminal((s) => s.watchlists);
  const activeListId = useTerminal((s) => s.activeListId);
  const watchlistLoaded = useTerminal((s) => s.watchlistLoaded);
  const loadWatchlist = useTerminal((s) => s.loadWatchlist);
  const removeSymbol = useTerminal((s) => s.removeSymbol);
  const setSymbol = useTerminal((s) => s.setSymbol);
  const symbol = useTerminal((s) => s.symbol);

  useEffect(() => {
    if (!watchlistLoaded) void loadWatchlist();
  }, [watchlistLoaded, loadWatchlist]);

  const listColor = watchlists.find((l) => l.id === activeListId)?.color ?? "#26a69a";

  const { data: snapData, loading } = usePoll(
    () => fetchSnapshots(watchlist),
    10000,
    [watchlist.join(",")],
    watchlist.length > 0
  );
  const snaps = snapData?.snapshots ?? {};

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#131722]">
      <Tabs defaultValue="list" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex shrink-0 items-center gap-1 border-b border-[#1c202b] pl-1 pr-1.5 pt-1">
          <ListPicker />
          <TabsList className="h-8 bg-transparent p-0">
            <TabsTrigger
              value="list"
              className="h-8 rounded-none border-b-2 border-transparent bg-transparent px-2.5 text-xs font-semibold text-[#787b86] data-[state=active]:border-[#26a69a] data-[state=active]:bg-transparent data-[state=active]:text-white"
            >
              List
            </TabsTrigger>
            <TabsTrigger
              value="movers"
              className="h-8 rounded-none border-b-2 border-transparent bg-transparent px-2.5 text-xs font-semibold text-[#787b86] data-[state=active]:border-[#26a69a] data-[state=active]:bg-transparent data-[state=active]:text-white"
            >
              Movers
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center gap-0.5">
            {controls}
            <SymbolSearch
              align="end"
              onSelect={(s) => void useTerminal.getState().addSymbol(s)}
              trigger={
                <button
                  className="flex h-6 w-6 items-center justify-center rounded text-[#787b86] transition-colors hover:bg-[#2a2e39] hover:text-white"
                  aria-label="Add symbol to watchlist"
                >
                  <Plus className="h-4 w-4" />
                </button>
              }
            />
          </div>
        </div>

        <TabsContent value="list" className="term-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
          <ColHeader extra />
          {loading && !snapData && watchlist.length > 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-[#787b86]" />
            </div>
          ) : watchlist.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-[#787b86]">
              Watchlist is empty — add symbols with +
            </p>
          ) : (
            watchlist.map((sym) => {
              const s = snaps[sym];
              return (
                <div
                  key={sym}
                  className={cn(
                    GRID,
                    "group relative w-full cursor-pointer rounded-md px-2 py-2 transition-colors hover:bg-[#2a2e39]",
                    symbol === sym && "bg-[#2a2e39]/60"
                  )}
                  onClick={() => setSymbol(sym)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") setSymbol(sym);
                  }}
                >
                  <span
                    className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full"
                    style={{ background: listColor }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate pl-1 font-mono text-xs font-semibold text-[#d1d4dc]">{sym}</span>
                  {s ? (
                    <>
                      <span className="text-right font-mono text-xs text-[#d1d4dc]">{fmtNum(s.price)}</span>
                      <QuoteCols change={s.change} changePct={s.changePct} />
                    </>
                  ) : (
                    <>
                      <span className="text-right font-mono text-xs text-[#787b86]">…</span>
                      <span />
                      <span />
                    </>
                  )}
                  <button
                    className="flex h-4 w-4 items-center justify-center rounded-full text-[#4a4f5c] opacity-50 transition-all hover:bg-[#ef5350]/15 hover:text-[#ef5350] focus-visible:opacity-100 hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeSymbol(sym);
                    }}
                    aria-label={`Remove ${sym} from watchlist`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="movers" className="term-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
          <ColHeader />
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#26a69a]">
            Top gainers
          </p>
          <MoverRows direction="gainers" />
          <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-[#ef5350]">
            Top losers
          </p>
          <MoverRows direction="losers" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
