'use client'

// Grid trade configuration dialog (Task 9-q) — opened from the chart's
// two-click "Grid" range tool with the picked lower/upper prices pre-filled.
// Everything is editable before the grid starts: level count, spacing model,
// per-grid size, optional whole-grid SL/TP circuit breakers and whether a
// stop market-closes the open lots. A live preview line shows the resulting
// step/ratio + capital commitment so mistakes are visible BEFORE real orders.
import { useEffect, useMemo, useState } from 'react'
import { LayoutGrid, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { fmtPrice } from '@/lib/market-types'

export interface GridTradeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  symbol: string
  lowerPrice: number
  upperPrice: number
}

export default function GridTradeDialog({ open, onOpenChange, symbol, lowerPrice, upperPrice }: GridTradeDialogProps) {
  const { toast } = useToast()
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [gridCount, setGridCount] = useState('8')
  const [spacing, setSpacing] = useState<'arithmetic' | 'geometric'>('arithmetic')
  const [qty, setQty] = useState('1')
  const [slOn, setSlOn] = useState(false)
  const [slPrice, setSlPrice] = useState('')
  const [tpOn, setTpOn] = useState(false)
  const [tpPrice, setTpPrice] = useState('')
  const [closeOnStop, setCloseOnStop] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // (re)initialize from the picked range every time the dialog opens
  useEffect(() => {
    if (!open) return
    setLower(String(Number(lowerPrice.toFixed(6))))
    setUpper(String(Number(upperPrice.toFixed(6))))
    setGridCount('8')
    setSpacing('arithmetic')
    setQty('1')
    setSlOn(false)
    setSlPrice('')
    setTpOn(false)
    setTpPrice('')
    setCloseOnStop(true)
  }, [open, lowerPrice, upperPrice])

  const lowerN = Number(lower)
  const upperN = Number(upper)
  const countN = Math.round(Number(gridCount))
  const qtyN = Number(qty)
  const rangeOk = Number.isFinite(lowerN) && lowerN > 0 && Number.isFinite(upperN) && upperN > lowerN
  const countOk = Number.isInteger(countN) && countN >= 2 && countN <= 100
  const qtyOk = Number.isFinite(qtyN) && qtyN > 0
  const isCrypto = symbol.includes('/')
  const mid = rangeOk ? (lowerN + upperN) / 2 : 0

  // sl/tp ordering vs the range (validated again server-side)
  const slN = Number(slPrice)
  const tpN = Number(tpPrice)
  const slInvalid = slOn && (!Number.isFinite(slN) || slN <= 0 || (rangeOk && slN >= lowerN))
  const tpInvalid = tpOn && (!Number.isFinite(tpN) || tpN <= 0 || (rangeOk && tpN <= upperN))

  const preview = useMemo(() => {
    if (!rangeOk || !countOk) return null
    if (spacing === 'geometric') {
      const ratio = Math.pow(upperN / lowerN, 1 / (countN - 1))
      return { kind: 'ratio' as const, value: ratio }
    }
    return { kind: 'step' as const, value: (upperN - lowerN) / (countN - 1) }
  }, [rangeOk, countOk, spacing, lowerN, upperN, countN])

  const notionalPerGrid = rangeOk && qtyOk && mid > 0 ? qtyN * mid : null
  const maxNotional = notionalPerGrid != null && countOk ? notionalPerGrid * countN : null

  const canSubmit = rangeOk && countOk && qtyOk && !slInvalid && !tpInvalid && !submitting

  const submit = async () => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/grid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol,
          lowerPrice: lowerN,
          upperPrice: upperN,
          gridCount: countN,
          spacing,
          qtyPerGrid: qtyN,
          maxSL: slOn && Number.isFinite(slN) ? slN : null,
          maxTP: tpOn && Number.isFinite(tpN) ? tpN : null,
          closeOnStop,
        }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        toast({ title: 'Grid started — see the Grid tab', description: `${symbol} · ${countN} levels · ${fmtPrice(lowerN)}–${fmtPrice(upperN)}` })
        window.dispatchEvent(new CustomEvent('tt:open-grid'))
        onOpenChange(false)
      } else {
        toast({ title: 'Could not start grid', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Could not start grid', description: 'Network error', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) onOpenChange(v) }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md gap-3 border-zinc-800 bg-zinc-900 p-5 text-zinc-100">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <LayoutGrid className="h-4 w-4 text-emerald-400" aria-hidden />
            Grid trade <span className="text-emerald-400">{symbol}</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-400">
            Long-only spot grid — buys each dip to a level, sells the lot at the next level up. Paper orders every 5s engine tick.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="grid-lower" className="text-[10px] text-zinc-500">Lower price</Label>
            <Input
              id="grid-lower"
              value={lower}
              onChange={(e) => setLower(e.target.value)}
              inputMode="decimal"
              className="mt-1 h-8 border-zinc-800 bg-zinc-950 text-xs tabular-nums"
              aria-invalid={rangeOk ? undefined : true}
            />
          </div>
          <div>
            <Label htmlFor="grid-upper" className="text-[10px] text-zinc-500">Upper price</Label>
            <Input
              id="grid-upper"
              value={upper}
              onChange={(e) => setUpper(e.target.value)}
              inputMode="decimal"
              className="mt-1 h-8 border-zinc-800 bg-zinc-950 text-xs tabular-nums"
              aria-invalid={rangeOk ? undefined : true}
            />
          </div>
          <div>
            <Label htmlFor="grid-count" className="text-[10px] text-zinc-500">Grid levels (2–100)</Label>
            <Input
              id="grid-count"
              value={gridCount}
              onChange={(e) => setGridCount(e.target.value)}
              inputMode="numeric"
              className="mt-1 h-8 border-zinc-800 bg-zinc-950 text-xs tabular-nums"
              aria-invalid={countOk ? undefined : true}
            />
          </div>
          <div>
            <Label htmlFor="grid-spacing" className="text-[10px] text-zinc-500">Spacing</Label>
            <Select value={spacing} onValueChange={(v) => { if (v === 'arithmetic' || v === 'geometric') setSpacing(v) }}>
              <SelectTrigger id="grid-spacing" className="mt-1 h-8 border-zinc-800 bg-zinc-950 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 text-xs">
                <SelectItem value="arithmetic">Arithmetic (even step)</SelectItem>
                <SelectItem value="geometric">Geometric (equal ratio)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label htmlFor="grid-qty" className="text-[10px] text-zinc-500">
              Quantity per grid {isCrypto ? <span className="text-zinc-600">— fractional OK for crypto</span> : <span className="text-zinc-600">— whole shares for stocks</span>}
            </Label>
            <Input
              id="grid-qty"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="decimal"
              step="any"
              className="mt-1 h-8 w-28 border-zinc-800 bg-zinc-950 text-xs tabular-nums"
              aria-invalid={qtyOk ? undefined : true}
            />
          </div>
          <div className={cn('col-span-2 flex items-center justify-between rounded border px-2 py-1.5', slInvalid ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800/70 bg-zinc-950/60')}>
            <div className="flex items-center gap-2">
              <Switch id="grid-sl" checked={slOn} onCheckedChange={setSlOn} className="scale-90" />
              <Label htmlFor="grid-sl" className="text-[11px] text-zinc-300">Max stop loss</Label>
            </div>
            <Input
              value={slPrice}
              onChange={(e) => setSlPrice(e.target.value)}
              inputMode="decimal"
              disabled={!slOn}
              placeholder="price"
              aria-label="Max stop loss price — whole-grid hard floor below the lower price"
              className="h-7 w-24 border-zinc-800 bg-zinc-950 text-right text-xs tabular-nums"
            />
          </div>
          <div className={cn('col-span-2 flex items-center justify-between rounded border px-2 py-1.5', tpInvalid ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800/70 bg-zinc-950/60')}>
            <div className="flex items-center gap-2">
              <Switch id="grid-tp" checked={tpOn} onCheckedChange={setTpOn} className="scale-90" />
              <Label htmlFor="grid-tp" className="text-[11px] text-zinc-300">Max take profit</Label>
            </div>
            <Input
              value={tpPrice}
              onChange={(e) => setTpPrice(e.target.value)}
              inputMode="decimal"
              disabled={!tpOn}
              placeholder="price"
              aria-label="Max take profit price — whole-grid profit ceiling above the upper price"
              className="h-7 w-24 border-zinc-800 bg-zinc-950 text-right text-xs tabular-nums"
            />
          </div>
          <div className="col-span-2 flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <div>
              <p className="text-[11px] text-zinc-300">Close when grid stops</p>
              <p className="text-[10px] leading-snug text-zinc-500">market-sell all open lots when the grid stops (guard hit or manual stop)</p>
            </div>
            <Switch checked={closeOnStop} onCheckedChange={setCloseOnStop} className="scale-90" aria-label="Close open positions when the grid stops" />
          </div>
        </div>

        {/* live preview */}
        <div className="rounded border border-zinc-800/70 bg-zinc-950/70 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-400">
          {rangeOk && countOk && preview ? (
            <div className="space-y-0.5 tabular-nums">
              <div>
                Level {preview.kind === 'step' ? 'step' : 'ratio'}:{' '}
                <span className="font-semibold text-zinc-200">
                  {preview.kind === 'step' ? fmtPrice(preview.value) : `×${preview.value.toFixed(4)}`}
                </span>
                <span className="text-zinc-600"> · {countN} levels · {fmtPrice(lowerN)} → {fmtPrice(upperN)}</span>
              </div>
              {notionalPerGrid != null && (
                <div>
                  Notional per grid: <span className="font-semibold text-zinc-200">{fmtPrice(notionalPerGrid)}</span>
                  {maxNotional != null && (
                    <> · max committed: <span className="font-semibold text-zinc-200">{fmtPrice(maxNotional)}</span></>
                  )}
                </div>
              )}
            </div>
          ) : (
            <span className="text-zinc-600">Enter a valid range (upper &gt; lower &gt; 0) and level count to see the preview</span>
          )}
          {(slInvalid || tpInvalid) && (
            <p className="mt-1 flex items-start gap-1 text-amber-400">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {slInvalid ? 'Max SL must be a positive price BELOW the lower price.' : 'Max TP must be a positive price ABOVE the upper price.'}
            </p>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
          <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">paper mode · long-only</Badge>
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs text-zinc-300 hover:bg-zinc-800" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-500"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
              Start grid
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
