'use client'

// Task 10-l — "Import all" dialog: paste or choose a grid-setups bundle (or a
// single Task 10-f setup file, or a raw JSON array) → per-item validity preview
// → one POST /api/grid/bulk creates every valid grid → per-item results.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Upload, FileJson, Check, X, LayoutGrid } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmtPrice } from '@/lib/market-types'
import { parseGridSetupBundle, type ParsedBundleItem } from '@/lib/grid-setup'

interface ImportResultItem {
  index: number
  symbol: string
  ok: boolean
  id?: string
  error?: string
}

const trimNum = (n: number) => String(Number(n.toFixed(2)))

export default function GridBundleImportDialog({
  open, onOpenChange, onImported,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}) {
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [results, setResults] = useState<ImportResultItem[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // reset when (re)opened
  useEffect(() => {
    if (open) { setText(''); setFileName(null); setResults(null); setImporting(false) }
  }, [open])

  const parsed = useMemo(() => (text.trim() ? parseGridSetupBundle(text) : null), [text])
  const items: ParsedBundleItem[] | null = parsed?.ok ? parsed.items : null
  const validSetups = items?.filter((i): i is Extract<ParsedBundleItem, { ok: true }> => i.ok) ?? []
  const invalid = items?.filter((i) => !i.ok) ?? []

  const pickFile = (f: File | null) => {
    if (!f) return
    setFileName(f.name)
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result ?? ''))
    reader.onerror = () => toast({ title: 'Could not read file', variant: 'destructive' })
    reader.readAsText(f)
  }

  const runImport = async () => {
    if (!items || validSetups.length === 0 || importing) return
    setImporting(true)
    try {
      const res = await fetch('/api/grid/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setups: validSetups.map((i) => i.setup) }),
      })
      const json = (await res.json().catch(() => null)) as
        | { results?: ImportResultItem[]; created?: number; failed?: number; error?: string }
        | null
      if (!res.ok && !json?.results) {
        toast({ title: 'Import failed', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
        return
      }
      const rows = json?.results ?? []
      setResults(rows)
      const created = json?.created ?? rows.filter((r) => r.ok).length
      const failed = json?.failed ?? rows.filter((r) => !r.ok).length
      if (created > 0) {
        onImported()
        toast({
          title: `Imported ${created} grid${created === 1 ? '' : 's'}`,
          description: failed > 0 ? `${failed} setup${failed === 1 ? '' : 's'} failed — see the list` : undefined,
        })
      } else {
        toast({ title: 'No grids created', description: json?.error || 'Every setup failed — see the list', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Import failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!importing) onOpenChange(v) }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg gap-3 border-zinc-800 bg-zinc-900 p-5 text-zinc-100">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <LayoutGrid className="h-4 w-4 text-emerald-400" aria-hidden />
            Import grid setups
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-400">
            Choose a bundle exported with <span className="text-zinc-200">Export all</span> — a single setup file or a raw JSON array works too. Every setup starts immediately as its own grid.
          </DialogDescription>
        </DialogHeader>

        {results == null && (
          <>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="outline" size="sm"
                className="h-8 gap-1.5 border-zinc-700 bg-zinc-950 text-xs text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden /> Choose file…
              </Button>
              {fileName && (
                <span className="flex min-w-0 items-center gap-1 text-[11px] text-zinc-400">
                  <FileJson className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                  <span className="truncate">{fileName}</span>
                </span>
              )}
            </div>

            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setFileName(null) }}
              placeholder='…or paste bundle JSON here — { "kind": "blackhole-grid-setups-bundle", … }'
              rows={5}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
            />

            {/* per-item preview */}
            {parsed && !parsed.ok && (
              <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300">{parsed.error}</p>
            )}
            {items && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                  <span className="font-semibold text-emerald-400">{validSetups.length} valid</span>
                  {invalid.length > 0 && <span className="text-rose-400">{invalid.length} invalid</span>}
                  <span className="text-zinc-600">·</span>
                  <span>only valid setups are imported</span>
                </div>
                <div className="terminal-scroll max-h-52 space-y-1 overflow-y-auto pr-0.5">
                  {items.map((it, i) => (
                    <div
                      key={i}
                      className={cn(
                        'flex items-center gap-2 rounded border px-2 py-1.5 text-[11px]',
                        it.ok ? 'border-zinc-800 bg-zinc-950/60' : 'border-rose-500/30 bg-rose-500/5',
                      )}
                    >
                      {it.ok ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                      ) : (
                        <X className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                      )}
                      {it.ok ? (
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-zinc-300">
                          <span className="font-semibold text-zinc-100">{it.setup.symbol}</span>
                          <span className="tabular-nums text-zinc-400">
                            {fmtPrice(it.setup.lowerPrice)}–{fmtPrice(it.setup.upperPrice)} · {it.setup.gridCount}× {it.setup.qtyPerGrid}
                          </span>
                          {it.setup.direction === 'buy' && <span className="text-sky-400/90">BUY ONLY</span>}
                          {it.setup.direction === 'sell' && <span className="text-violet-400/90">SELL ONLY</span>}
                        </span>
                      ) : (
                        <span className="min-w-0 truncate text-rose-300">{it.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* per-item results after the bulk POST */}
        {results != null && (
          <div className="terminal-scroll max-h-64 space-y-1 overflow-y-auto pr-0.5">
            {results.map((r) => (
              <div
                key={r.index}
                className={cn(
                  'flex items-center gap-2 rounded border px-2 py-1.5 text-[11px]',
                  r.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5',
                )}
              >
                {r.ok ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <X className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                )}
                <span className={cn('font-semibold', r.ok ? 'text-zinc-100' : 'text-zinc-200')}>{r.symbol}</span>
                {r.ok ? (
                  <span className="text-emerald-400/90">grid started</span>
                ) : (
                  <span className="min-w-0 truncate text-rose-300">{r.error}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800/60 pt-3">
          <Button
            variant="ghost" size="sm"
            className="h-8 px-3 text-xs text-zinc-400 hover:text-zinc-100"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            {results != null ? 'Close' : 'Cancel'}
          </Button>
          {results == null && (
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
              disabled={importing || validSetups.length === 0}
              onClick={() => void runImport()}
            >
              {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Import {validSetups.length} setup{validSetups.length === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
