"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SearchItem } from "@/lib/types";

interface SymbolSearchProps {
  onSelect: (symbol: string) => void;
  trigger: React.ReactNode;
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SymbolSearch({ onSelect, trigger, align = "start", open: controlledOpen, onOpenChange }: SymbolSearchProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ac.signal, cache: "no-store" });
        const json = (await res.json()) as { results?: SearchItem[] };
        if (!cancelled) setResults(json.results ?? []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[320px] border-[#2a2e39] bg-[#1e222d] p-0 shadow-2xl"
        sideOffset={6}
      >
        <Command shouldFilter={false} className="rounded-lg">
          <div className="flex items-center gap-2 border-b border-[#2a2e39] px-3">
            <Search className="h-4 w-4 shrink-0 text-[#787b86]" />
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search symbol or company…"
              className="h-10 border-0 bg-transparent focus:ring-0"
            />
            {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#787b86]" />}
          </div>
          <CommandList className="term-scroll max-h-[320px]">
            <CommandEmpty className="py-6 text-center text-xs text-[#787b86]">
              No symbols found
            </CommandEmpty>
            <CommandGroup>
              {results.map((r) => (
                <CommandItem
                  key={r.symbol}
                  value={r.symbol}
                  onSelect={() => {
                    onSelect(r.symbol);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="cursor-pointer gap-2 rounded px-2 py-2 aria-selected:bg-[#2a2e39]"
                >
                  <span className="min-w-[52px] font-semibold tracking-wide text-[#d1d4dc]">{r.symbol}</span>
                  <span className="flex-1 truncate text-xs text-[#787b86]">{r.name}</span>
                  <span className="rounded bg-[#2a2e39] px-1.5 py-0.5 text-[10px] font-medium text-[#787b86]">
                    {r.exchange}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="border-t border-[#2a2e39] px-3 py-1.5 text-[10px] text-[#787b86]">
            US equities · data via Alpaca
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
