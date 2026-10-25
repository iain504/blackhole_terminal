'use client'

// Grid trade configuration dialog (Task 9-q, extended by Task 10-b/10-f) —
// opened from the chart's two-click "Grid" range tool with the picked
// lower/upper prices pre-filled, from the Grid tab's "Edit" action on a flat
// active grid (editGrid prop → PUT /api/grid/<id>), or from the Grid tab's
// "Import setup" action (openWithImport → empty form + the import panel
// expanded so a saved setup JSON can be pasted/uploaded).
// Everything is editable before the grid starts: level count, spacing model,
// per-grid size, optional whole-grid SL/TP circuit breakers (absolute price OR
// percent of the range bounds — resolved exactly like the server:
// SL trigger = lower × (1 − pct/100), TP trigger = upper × (1 + pct/100)) and
// whether a stop market-closes the open lots. A live preview line shows the
// resulting step/ratio + capital commitment so mistakes are visible BEFORE
// real orders. An in-dialog backtester (POST /api/grid/backtest) simulates the
// config over 7/30/90/365 days and renders stat tiles + a P/L sparkline +
// a collapsible fills table. The dialog is draggable by its header (Task 10-b).
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutGrid, TriangleAlert, GripHorizontal, FlaskConical, Loader2, ChevronDown, CircleAlert,
  FileUp, Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
// Task 10-c: DialogContent is capped at 92vh with its own scroll (the header is
// sticky so the drag handle never scrolls away) — the backtest results previously
// pushed the header above the viewport on short screens.
import { cn } from '@/lib/utils'
import { fmtPrice } from '@/lib/market-types'
import { parseGridSetup, type GridSetup, type GridSetupDirection } from '@/lib/grid-setup'

export type DialogDirection = GridSetupDirection

/** Full config of a grid being edited (edit-when-flat, Task 10-b).
 * slBasis/tpBasis are optional API strings ('price' | 'percent') — rows created
 * before Task 10-a landed simply lack them (treated as 'price'). direction —
 * pre-10-g rows lack it (treated as 'both'). */
export interface GridEditTarget {
  id: string
  symbol: string
  lowerPrice: number
  upperPrice: number
  gridCount: number
  spacing: string
  qtyPerGrid: number
  maxSL: number | null
  maxTP: number | null
  slBasis?: string | null
  tpBasis?: string | null
  direction?: string | null
  closeOnStop: boolean
}

export interface GridTradeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  symbol: string
  lowerPrice: number
  upperPrice: number
  /** When set, the dialog edits this grid instead of creating one
   * (submit → PUT /api/grid/<id> with the same body shape as create). */
  editGrid?: GridEditTarget | null
  /** Called after a successful save (create OR edit) so parents can refresh. */
  onSaved?: () => void
  /** Grid tab "Import setup" flow: open with an EMPTY range and the import
   * panel expanded, so a saved setup JSON can be pasted or uploaded to fill
   * the form (create mode). The grid still runs on this dialog's symbol. */
  openWithImport?: boolean
  /** Called when an applied setup names a DIFFERENT symbol than this dialog's
   * (create mode only). The parent can retarget the new grid to the setup's
   * own symbol. Absent (chart two-click flow): the config applies to this
   * dialog's symbol and the mismatch is flagged with a note instead. */
  onApplySymbol?: (symbol: string) => void
}

type Basis = 'price' | 'percent'

// ---- backtest response (contract guaranteed by the backend, Task 10-a) ----
interface BacktestStats {
  realizedPnl: number
  openPnl: number
  totalPnl: number
  fillsCount: number
  buys: number
  sells: number
  winRate: number | null
  maxDrawdown: number
  bestTrade: number | null
  worstTrade: number | null
  openLots: number
  openQty: number
}
interface BacktestResult {
  symbol: string
  days: number
  timeframe: string
  bars: number
  started: string
  ended: string
  stopped: boolean
  stopReason: string | null
  stats: BacktestStats
  // NOTE: the landed backend (Task 10-a) returns t as an ISO timestamp STRING
  curve: { t: string; totalPnl: number }[]
  fills: { t: string; side: string; reason: string; price: number; qty: number; pnl: number | null }[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Setters bag so the setup→form fill can live at module level (stable — no
 * exhaustive-deps churn in the init effect). */
type FormSetters = {
  setLower: (v: string) => void
  setUpper: (v: string) => void
  setGridCount: (v: string) => void
  setSpacing: (v: 'arithmetic' | 'geometric') => void
  setQty: (v: string) => void
  setDirection: (v: DialogDirection) => void
  setSlOn: (v: boolean) => void
  setSlBasis: (v: Basis) => void
  setSlPrice: (v: string) => void
  setSlPct: (v: string) => void
  setTpOn: (v: boolean) => void
  setTpBasis: (v: Basis) => void
  setTpPrice: (v: string) => void
  setTpPct: (v: string) => void
  setCloseOnStop: (v: boolean) => void
}

/** Fill every form field from a parsed grid setup (Task 10-f import path). */
function applySetupToForm(s: GridSetup, st: FormSetters) {
  const slIsPct = s.slBasis === 'percent'
  const tpIsPct = s.tpBasis === 'percent'
  st.setLower(String(s.lowerPrice))
  st.setUpper(String(s.upperPrice))
  st.setGridCount(String(s.gridCount))
  st.setSpacing(s.spacing)
  st.setQty(String(s.qtyPerGrid))
  st.setDirection(s.direction)
  st.setSlOn(s.maxSL != null)
  st.setSlBasis(slIsPct ? 'percent' : 'price')
  st.setSlPrice(s.maxSL != null && !slIsPct ? String(s.maxSL) : '')
  st.setSlPct(s.maxSL != null && slIsPct ? String(s.maxSL) : '')
  st.setTpOn(s.maxTP != null)
  st.setTpBasis(tpIsPct ? 'percent' : 'price')
  st.setTpPrice(s.maxTP != null && !tpIsPct ? String(s.maxTP) : '')
  st.setTpPct(s.maxTP != null && tpIsPct ? String(s.maxTP) : '')
  st.setCloseOnStop(s.closeOnStop)
}

/** "75999.995" → "76000", "100.1" → "100.1", "abc" → "abc" (leave junk alone). */
const to2dpStr = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : v
}

/** 5 → "5", 5.25 → "5.25" (percent display without trailing zeros). */
const trimNum = (n: number) => String(Number(n.toFixed(2)))

const BT_DAYS = ['7', '30', '90', '365']

const DIRECTION_LABEL: Record<DialogDirection, string> = {
  both: 'Both sides',
  buy: 'Buy only',
  sell: 'Sell only',
}
const DIRECTION_HINT: Record<DialogDirection, string> = {
  both: 'buys each dip to a level, sells the lot at the next level up (classic grid)',
  buy: 'ladder-buys every level as price falls — no auto-sells (exits: Max TP, guard, or stop)',
  sell: 'sells every level as price rises — short ladder marked inverted; a close buys the lots back (stocks: nets against held shares or shorts)',
}

/** One-sided grid selector (Task 10-g) — module-level so it never remounts. */
function DirectionToggle({ value, onChange, disabled }: {
  value: DialogDirection
  onChange: (d: DialogDirection) => void
  disabled: boolean
}) {
  return (
    <div role="group" aria-label="Grid direction" className="flex shrink-0 overflow-hidden rounded border border-zinc-800">
      {(['both', 'buy', 'sell'] as const).map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={value === d}
          disabled={disabled}
          onClick={() => onChange(d)}
          title={DIRECTION_HINT[d]}
          className={cn(
            'h-7 px-2.5 text-[11px] leading-none transition-colors disabled:opacity-40',
            value === d
              ? d === 'sell'
                ? 'bg-violet-500/20 text-violet-300'
                : d === 'buy'
                  ? 'bg-sky-500/20 text-sky-300'
                  : 'bg-emerald-500/20 text-emerald-400'
              : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300',
          )}
        >
          {DIRECTION_LABEL[d]}
        </button>
      ))}
    </div>
  )
}

/** Dependency-free inline sparkline of the backtest's total-P/L curve.
 * Green above zero, red below; dashed zinc zero-baseline when the curve
 * straddles 0. */
function PnlSparkline({ curve, finalPnl }: { curve: { t: string; totalPnl: number }[]; finalPnl: number }) {
  const W = 300
  const H = 56
  const PAD = 3
  const pts = curve.filter((p) => Number.isFinite(p.totalPnl))
  if (pts.length < 2) {
    return <div className="py-3 text-center text-[10px] text-zinc-600">Not enough curve data to plot</div>
  }
  let min = 0
  let max = 0
  for (const p of pts) {
    min = Math.min(min, p.totalPnl)
    max = Math.max(max, p.totalPnl)
  }
  if (max - min < 1e-9) max = min + 1 // perfectly flat curve still renders
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD)
  const y = (v: number) => PAD + (1 - (v - min) / (max - min)) * (H - 2 * PAD)
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.totalPnl).toFixed(1)}`).join(' ')
  const color = finalPnl >= 0 ? '#10b981' : '#f43f5e'
  const showZero = min < 0 && max > 0
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 h-14 w-full" role="img" aria-label="Backtest total P/L curve">
      {showZero && <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} stroke="#3f3f46" strokeWidth="1" strokeDasharray="3 3" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

const BT_TILE = 'rounded border border-zinc-800/70 bg-zinc-900/60 px-2 py-1.5'

/** ISO timestamp → short "12 Jan, 14:30" (never "Invalid Date"). */
const fmtIso = (iso: string) => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—'
}
const BT_TILE_LABEL = 'text-[10px] uppercase tracking-wider text-zinc-500'
const BT_TILE_VALUE = 'text-sm font-semibold tabular-nums'
const pnlCls = (v: number | null | undefined) =>
  v == null ? 'text-zinc-400' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-300'
const signed = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`

/** Basis segmented toggle (Price | %) for the SL/TP rows — module-level so it
 * never remounts (a component defined inside the dialog body would get a new
 * identity on every keystroke). */
function BasisToggle({ which, value, onChange, disabled }: {
  which: 'sl' | 'tp'
  value: Basis
  onChange: (b: Basis) => void
  disabled: boolean
}) {
  return (
    <div role="group" aria-label={`${which === 'sl' ? 'Stop loss' : 'Take profit'} basis`} className="flex shrink-0 overflow-hidden rounded border border-zinc-800">
      {(['price', 'percent'] as const).map((b) => (
        <button
          key={b}
          type="button"
          aria-pressed={value === b}
          disabled={disabled}
          onClick={() => onChange(b)}
          title={b === 'price' ? 'Absolute price' : 'Percent of the range bound'}
          className={cn(
            'h-6 px-1.5 text-[10px] leading-none transition-colors disabled:opacity-40',
            value === b ? 'bg-emerald-500/20 text-emerald-400' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300',
          )}
        >
          {b === 'price' ? 'Price' : '%'}
        </button>
      ))}
    </div>
  )
}

export default function GridTradeDialog({
  open, onOpenChange, symbol, lowerPrice, upperPrice, editGrid = null, onSaved,
  openWithImport = false, onApplySymbol,
}: GridTradeDialogProps) {
  const { toast } = useToast()
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [gridCount, setGridCount] = useState('8')
  const [spacing, setSpacing] = useState<'arithmetic' | 'geometric'>('arithmetic')
  const [qty, setQty] = useState('1')
  const [direction, setDirection] = useState<DialogDirection>('both')
  const [slOn, setSlOn] = useState(false)
  const [slBasis, setSlBasis] = useState<Basis>('price')
  const [slPrice, setSlPrice] = useState('')
  const [slPct, setSlPct] = useState('')
  const [tpOn, setTpOn] = useState(false)
  const [tpBasis, setTpBasis] = useState<Basis>('price')
  const [tpPrice, setTpPrice] = useState('')
  const [tpPct, setTpPct] = useState('')
  const [closeOnStop, setCloseOnStop] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  // ---- setup import (Task 10-f) ----
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  /** Symbol the imported setup was saved for — when it differs from this
   * dialog's symbol, a persistent amber note stays visible after applying. */
  const [importedFrom, setImportedFrom] = useState<string | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  // ---- draggable header state (Task 10-b) ----
  const contentRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState({ dx: 0, dy: 0 })
  const dragRef = useRef({ dx: 0, dy: 0 })
  const [dragging, setDragging] = useState(false)
  const dragSession = useRef<{
    pointerId: number
    startX: number
    startY: number
    baseDx: number
    baseDy: number
    w: number
    h: number
  } | null>(null)

  // Keep ≥24px of the dialog visible inside the viewport on every axis.
  // The content is fixed at left/top 50% with a -50% translate; dx/dy shift it
  // from there, so: left = vw/2 − w/2 + dx (and the vertical twin).
  const clampOffset = (dx: number, dy: number, w: number, h: number) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const cx = vw / 2
    const cy = vh / 2
    const minDx = 24 - cx - w / 2
    const maxDx = cx - 24 + w / 2
    const minDy = 24 - cy - h / 2
    const maxDy = cy - 24 + h / 2
    return { dx: Math.min(maxDx, Math.max(minDx, dx)), dy: Math.min(maxDy, Math.max(minDy, dy)) }
  }

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // never hijack interactive elements that happen to live in the header
    const t = e.target as HTMLElement | null
    if (t && t.closest('button, input, select, textarea, a, [role="switch"]')) return
    const el = contentRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragSession.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseDx: dragRef.current.dx,
      baseDy: dragRef.current.dy,
      w: rect.width,
      h: rect.height,
    }
    setDragging(true)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* already released */ }
  }
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragSession.current
    if (!s || s.pointerId !== e.pointerId) return
    const next = clampOffset(s.baseDx + (e.clientX - s.startX), s.baseDy + (e.clientY - s.startY), s.w, s.h)
    dragRef.current = next
    setDrag(next)
  }
  const endHeaderDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragSession.current) return
    dragSession.current = null
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
  }

  // ---- backtest state (Task 10-b) ----
  const [btDays, setBtDays] = useState('30')
  const [btRunning, setBtRunning] = useState(false)
  const [bt, setBt] = useState<BacktestResult | null>(null)
  const [btError, setBtError] = useState<string | null>(null)
  const [btRanConfig, setBtRanConfig] = useState<string | null>(null)
  const [btFillsOpen, setBtFillsOpen] = useState(false)

  // ---- auto-optimize state (Task 10-g) ----
  const [optRunning, setOptRunning] = useState(false)
  const [optError, setOptError] = useState<string | null>(null)
  const [optNote, setOptNote] = useState<string | null>(null)

  // (re)initialize every time the dialog opens — from the edit target when
  // editing, otherwise from the picked range. editGrid is read through a ref so
  // a parent re-creating the object per render can never reset the user's edits.
  const editRef = useRef(editGrid)
  editRef.current = editGrid
  const editId = editGrid?.id ?? ''
  const symbolRef = useRef(symbol)
  symbolRef.current = symbol
  const openImportRef = useRef(openWithImport)
  openImportRef.current = openWithImport
  useEffect(() => {
    if (!open) return
    const eg = editRef.current
    setDrag({ dx: 0, dy: 0 }) // movable dialog: reset the offset on (re)open
    dragRef.current = { dx: 0, dy: 0 }
    setBt(null)
    setBtError(null)
    setBtRanConfig(null)
    setBtFillsOpen(false)
    setImportError(null)
    setImportedFrom(null)
    setImportOpen(!eg && !!openImportRef.current)
    setOptError(null)
    setOptNote(null)
    if (eg) {
      setLower(to2dpStr(String(eg.lowerPrice)))
      setUpper(to2dpStr(String(eg.upperPrice)))
      setGridCount(String(eg.gridCount))
      setSpacing(eg.spacing === 'geometric' ? 'geometric' : 'arithmetic')
      setQty(String(eg.qtyPerGrid))
      setDirection(eg.direction === 'buy' || eg.direction === 'sell' ? eg.direction : 'both')
      const slIsPct = eg.slBasis === 'percent'
      setSlOn(eg.maxSL != null)
      setSlBasis(slIsPct ? 'percent' : 'price')
      setSlPrice(eg.maxSL != null && !slIsPct ? String(eg.maxSL) : '')
      setSlPct(eg.maxSL != null && slIsPct ? String(eg.maxSL) : '')
      const tpIsPct = eg.tpBasis === 'percent'
      setTpOn(eg.maxTP != null)
      setTpBasis(tpIsPct ? 'percent' : 'price')
      setTpPrice(eg.maxTP != null && !tpIsPct ? String(eg.maxTP) : '')
      setTpPct(eg.maxTP != null && tpIsPct ? String(eg.maxTP) : '')
      setCloseOnStop(eg.closeOnStop)
    } else if (lowerPrice > 0 && upperPrice > 0) {
      setLower(String(Number(lowerPrice.toFixed(6))))
      setUpper(String(Number(upperPrice.toFixed(6))))
      setGridCount('8')
      setSpacing('arithmetic')
      setQty('1')
      setDirection('both')
      setSlOn(false)
      setSlBasis('price')
      setSlPrice('')
      setSlPct('')
      setTpOn(false)
      setTpBasis('price')
      setTpPrice('')
      setTpPct('')
      setCloseOnStop(true)
    } else {
      // import-first flow (Grid tab "Import setup"): no picked range — start
      // with empty price fields so Start stays disabled until a setup is
      // applied or a range is typed
      setLower('')
      setUpper('')
      setGridCount('8')
      setSpacing('arithmetic')
      setQty('1')
      setDirection('both')
      setSlOn(false)
      setSlBasis('price')
      setSlPrice('')
      setSlPct('')
      setTpOn(false)
      setTpBasis('price')
      setTpPrice('')
      setTpPct('')
      setCloseOnStop(true)
    }
  }, [open, editId, lowerPrice, upperPrice])

  // prices normalized to 2 decimal places (both here and defensively on submit)
  const lowerRaw = Number(lower)
  const upperRaw = Number(upper)
  const lowerN = Number.isFinite(lowerRaw) ? round2(lowerRaw) : NaN
  const upperN = Number.isFinite(upperRaw) ? round2(upperRaw) : NaN
  const countN = Math.round(Number(gridCount))
  const qtyN = Number(qty)
  const rangeOk = Number.isFinite(lowerN) && lowerN > 0 && Number.isFinite(upperN) && upperN > lowerN
  const countOk = Number.isInteger(countN) && countN >= 2 && countN <= 100
  const qtyOk = Number.isFinite(qtyN) && qtyN > 0
  const isCrypto = symbol.includes('/')
  const mid = rangeOk ? (lowerN + upperN) / 2 : 0

  // SL/TP — price mode keeps the strict ordering rules; percent mode mirrors
  // the server bounds (SL% 0<p≤90 below the lower bound, TP% 0<p≤1000 above
  // the upper bound) and resolves the ABSOLUTE trigger with the same formulas
  // the engine uses: lower × (1 − pct/100) / upper × (1 + pct/100).
  // Task 10-g: sell-only grids MIRROR — SL% sits ABOVE the upper bound,
  // TP% BELOW the lower bound (short-side circuit breakers).
  const sellGrid = direction === 'sell'
  const slN = Number(slPrice)
  const slPctN = Number(slPct)
  const tpN = Number(tpPrice)
  const tpPctN = Number(tpPct)
  const slPctValid = Number.isFinite(slPctN) && slPctN > 0 && slPctN <= 90
  const tpPctValid = Number.isFinite(tpPctN) && tpPctN > 0 && tpPctN <= 1000
  const slResolved = slBasis === 'percent' && rangeOk && slPctValid
    ? round2(sellGrid ? upperN * (1 + slPctN / 100) : lowerN * (1 - slPctN / 100))
    : slN
  const tpResolved = tpBasis === 'percent' && rangeOk && tpPctValid
    ? round2(sellGrid ? lowerN * (1 - tpPctN / 100) : upperN * (1 + tpPctN / 100))
    : tpN
  const slInvalid = slOn && (slBasis === 'price'
    ? (!Number.isFinite(slN) || slN <= 0 || (rangeOk && (sellGrid ? slN <= upperN : slN >= lowerN)))
    : !slPctValid)
  const tpInvalid = tpOn && (tpBasis === 'price'
    ? (!Number.isFinite(tpN) || tpN <= 0 || (rangeOk && (sellGrid ? tpN >= lowerN : tpN <= upperN)))
    : !tpPctValid)

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

  // identical body shape for create (POST) and edit (PUT) — the server fills
  // whatever is unspecified; basis flags tell it how to read maxSL/maxTP
  const buildBody = () => ({
    symbol,
    lowerPrice: round2(lowerN),
    upperPrice: round2(upperN),
    gridCount: countN,
    spacing,
    qtyPerGrid: qtyN,
    direction,
    maxSL: slOn ? (slBasis === 'percent' ? round2(slPctN) : slN) : null,
    slBasis: slOn ? slBasis : 'price',
    maxTP: tpOn ? (tpBasis === 'percent' ? round2(tpPctN) : tpN) : null,
    tpBasis: tpOn ? tpBasis : 'price',
    closeOnStop,
  })

  // snapshot of everything that affects the outcome — a backtest result is
  // only "fresh" while this string is unchanged
  const configSnapshot = () =>
    JSON.stringify([lowerN, upperN, countN, spacing, qtyN, direction, slOn, slBasis, slPrice, slPct, tpOn, tpBasis, tpPrice, tpPct, closeOnStop])
  const btStale = bt != null && btRanConfig != null && btRanConfig !== configSnapshot()

  const runBacktest = async () => {
    setBtRunning(true)
    setBtError(null)
    try {
      const res = await fetch('/api/grid/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...buildBody(), days: Number(btDays) }),
      })
      const json = (await res.json().catch(() => null)) as (BacktestResult & { error?: string }) | null
      if (!res.ok) {
        const msg = json?.error || (res.status === 429 ? 'Rate limited — try again shortly' : `HTTP ${res.status}`)
        setBtError(msg)
        toast({ title: 'Backtest failed', description: msg, variant: 'destructive' })
      } else if (json && json.stats && Array.isArray(json.curve)) {
        setBt(json)
        setBtRanConfig(configSnapshot())
        setBtFillsOpen(false)
      } else {
        setBtError('Unexpected backtest response')
      }
    } catch {
      setBtError('Network error')
      toast({ title: 'Backtest failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setBtRunning(false)
    }
  }

  const btBlockReason = !rangeOk
    ? 'enter a valid range first'
    : !countOk
      ? 'valid level count required'
      : !qtyOk
        ? 'valid quantity required'
        : null

  // ---- auto-optimize (Task 10-g): sweep width × count around the live
  // price server-side, fill the winning range + count into the form. Sizing
  // and the SL/TP guards are NOT touched — they stay the user's decision.
  const runOptimize = async () => {
    setOptRunning(true)
    setOptError(null)
    setOptNote(null)
    try {
      const res = await fetch('/api/grid/optimize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol,
          qtyPerGrid: qtyN,
          direction,
          spacing,
          days: Number(btDays),
        }),
      })
      const json = (await res.json().catch(() => null)) as
        | {
            error?: string
            days?: number
            tried?: number
            best?: {
              lowerPrice: number
              upperPrice: number
              gridCount: number
              totalPnl: number
              maxDrawdown: number
              fillsCount: number
              winRate: number
            }
          }
        | null
      if (!res.ok || !json?.best) {
        const msg = json?.error || (res.status === 429 ? 'Rate limited — try again shortly' : `HTTP ${res.status}`)
        setOptError(msg)
        toast({ title: 'Auto optimize failed', description: msg, variant: 'destructive' })
        return
      }
      const b = json.best
      setLower(to2dpStr(String(b.lowerPrice)))
      setUpper(to2dpStr(String(b.upperPrice)))
      setGridCount(String(b.gridCount))
      setBt(null)
      setBtRanConfig(null)
      setBtFillsOpen(false)
      setOptNote(
        `Optimized on ${json.days ?? btDays}d · ${json.tried ?? 0} configs · range ${fmtPrice(round2(b.lowerPrice))}–${fmtPrice(round2(b.upperPrice))} · ${b.gridCount} levels · P/L ${signed(b.totalPnl)} · max DD ${Number(b.maxDrawdown ?? 0).toFixed(2)} · ${b.fillsCount} fills`,
      )
      toast({ title: 'Range optimized', description: `${symbol} · ${b.gridCount} levels · ${fmtPrice(round2(b.lowerPrice))}–${fmtPrice(round2(b.upperPrice))}` })
    } catch {
      setOptError('Network error')
      toast({ title: 'Auto optimize failed', description: 'Network error', variant: 'destructive' })
    } finally {
      setOptRunning(false)
    }
  }

  // ---- setup import (Task 10-f) ----
  // Parse the pasted/uploaded JSON and fill the whole form. The server ALWAYS
  // re-validates on submit — parseGridSetup just fails early and honestly.
  const applyImport = (text: string) => {
    const r = parseGridSetup(text)
    if (!r.ok) {
      setImportError(r.error)
      return
    }
    applySetupToForm(r.setup, {
      setLower, setUpper, setGridCount, setSpacing, setQty, setDirection,
      setSlOn, setSlBasis, setSlPrice, setSlPct,
      setTpOn, setTpBasis, setTpPrice, setTpPct, setCloseOnStop,
    })
    setImportError(null)
    setBt(null)
    setBtRanConfig(null)
    setBtFillsOpen(false)
    const mismatch = r.setup.symbol !== '' && r.setup.symbol !== symbolRef.current
    if (mismatch && !editGrid && onApplySymbol) {
      // import-first flow: the setup's own symbol IS the intent — retarget the
      // new grid to it (parent swaps the symbol prop; fields stay untouched)
      onApplySymbol(r.setup.symbol)
      setImportedFrom(null)
    } else {
      setImportedFrom(mismatch ? r.setup.symbol : null)
    }
    setImportOpen(false)
    toast({
      title: 'Setup imported',
      description: `${r.setup.symbol || symbolRef.current} · ${r.setup.gridCount} levels`,
    })
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file later
    if (!f) return
    const text = await f.text().catch(() => '')
    if (!text) {
      setImportError('Could not read the file')
      return
    }
    setImportText(text)
    applyImport(text)
  }

  const submit = async () => {
    setSubmitting(true)
    try {
      const res = editGrid
        ? await fetch(`/api/grid/${editGrid.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildBody()),
          })
        : await fetch('/api/grid', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildBody()),
          })
      const json = await res.json().catch(() => null)
      if (res.ok) {
        if (editGrid) {
          toast({ title: 'Grid updated', description: `${symbol} · config saved` })
        } else {
          toast({ title: 'Grid started — see the Grid tab', description: `${symbol} · ${countN} levels · ${fmtPrice(lowerN)}–${fmtPrice(upperN)}` })
          window.dispatchEvent(new CustomEvent('tt:open-grid'))
        }
        onSaved?.()
        onOpenChange(false)
      } else {
        toast({ title: editGrid ? 'Could not update grid' : 'Could not start grid', description: json?.error || `HTTP ${res.status}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: editGrid ? 'Could not update grid' : 'Could not start grid', description: 'Network error', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  // basis toggle now lives at module level (see BasisToggle above)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!submitting) onOpenChange(v) }}>
      <DialogContent
        ref={contentRef}
        // Drag offset composes with shadcn's centering: Tailwind 4 compiles the
        // dialog's `translate-x/y-[-50%]` classes to the CSS `translate`
        // property, and individual transform properties apply BEFORE
        // `transform` — so translate(-50%,-50%) + transform translate(dx,dy)
        // lands exactly at translate(calc(-50% + dx), calc(-50% + dy)) without
        // fighting the open animation (which animates `transform`).
        style={{ transform: `translate(${drag.dx}px, ${drag.dy}px)` }}
        className="terminal-scroll max-h-[92vh] w-[calc(100vw-2rem)] max-w-md gap-3 overflow-y-auto overscroll-contain border-zinc-800 bg-zinc-900 p-5 text-zinc-100"
      >
        <DialogHeader
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={endHeaderDrag}
          onPointerCancel={endHeaderDrag}
          className={cn('sticky top-0 z-10 -mx-5 cursor-grab touch-none select-none space-y-1 bg-zinc-900 px-5 pb-1 pt-1', dragging && 'cursor-grabbing')}
          data-drag-handle
        >
          <span className="sr-only">Dialog header — drag to move the dialog</span>
          <DialogTitle className="flex items-center gap-2 text-base">
            <LayoutGrid className="h-4 w-4 text-emerald-400" aria-hidden />
            {editGrid ? (
              <>Edit grid <span className="text-emerald-400">#{editId.slice(0, 8)}</span> <span className="text-xs font-normal text-zinc-500">{symbol}</span></>
            ) : (
              <>Grid trade <span className="text-emerald-400">{symbol}</span></>
            )}
            <GripHorizontal className="ml-auto mr-6 h-4 w-4 shrink-0 text-zinc-600" aria-hidden />
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-400">
            {editGrid
              ? 'Editing a flat active grid — saved changes reconfigure the running engine (levels, size, circuit breakers).'
              : 'Spot grid — buy dips, sell rallies, or run one-sided ladders. Paper orders every 5s engine tick.'}
          </DialogDescription>
        </DialogHeader>

        {/* import setup (Task 10-f) — available in create AND edit modes; a
            file or pasted JSON fills the whole form (server re-validates on
            submit). The Grid tab's "Import setup" button opens the dialog with
            this panel already expanded. */}
        <div className="rounded border border-zinc-800/70 bg-zinc-950/60">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => setImportOpen((v) => !v)}
            aria-expanded={importOpen}
          >
            <FileUp className="h-3 w-3 shrink-0" aria-hidden />
            Import setup <span className="text-zinc-600">(JSON)</span>
            <ChevronDown className={cn('ml-auto h-3 w-3 transition-transform', importOpen && 'rotate-180')} aria-hidden />
          </button>
          {importOpen && (
            <div className="space-y-2 border-t border-zinc-800/60 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 border-zinc-800 bg-zinc-950 px-2 text-[11px] text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
                  onClick={() => importFileRef.current?.click()}
                >
                  <FileUp className="h-3 w-3" aria-hidden />
                  Choose file…
                </Button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  aria-hidden
                  tabIndex={-1}
                  onChange={(e) => void onImportFile(e)}
                />
                <span className="text-[10px] text-zinc-600">or paste setup JSON below</span>
              </div>
              <textarea
                value={importText}
                onChange={(e) => { setImportText(e.target.value); if (importError) setImportError(null) }}
                rows={4}
                spellCheck={false}
                placeholder='{"kind":"blackhole-grid-setup","symbol":"BTC/USD","lowerPrice":78000,…}'
                aria-label="Grid setup JSON"
                className="terminal-scroll w-full resize-y rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1.5 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-500"
                  disabled={!importText.trim()}
                  onClick={() => applyImport(importText)}
                >
                  <FileUp className="h-3 w-3" aria-hidden />
                  Apply to form
                </Button>
                {importError && (
                  <span className="flex items-center gap-1 text-[11px] text-rose-400">
                    <CircleAlert className="h-3 w-3 shrink-0" aria-hidden />
                    {importError}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
        {importedFrom && (
          <p className="flex items-start gap-1 text-[10px] text-amber-400/90">
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            Imported setup was saved for {importedFrom} — this grid runs on {symbol}. Adjust the range if needed.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          {/* Direction (Task 10-g) — both sides / buy-only ladder / sell-only ladder */}
          <div className="col-span-2 rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="grid-direction" className="text-[11px] text-zinc-300">Direction</Label>
              <span id="grid-direction">
                <DirectionToggle value={direction} onChange={setDirection} disabled={false} />
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-snug text-zinc-500">{DIRECTION_HINT[direction]}</p>
          </div>
          <div>
            <Label htmlFor="grid-lower" className="text-[10px] text-zinc-500">
              Lower price <span className="text-zinc-600">2 d.p.</span>
            </Label>
            <Input
              id="grid-lower"
              value={lower}
              onChange={(e) => setLower(e.target.value)}
              onBlur={() => setLower((v) => to2dpStr(v))}
              inputMode="decimal"
              step="0.01"
              className="mt-1 h-8 border-zinc-800 bg-zinc-950 text-xs tabular-nums"
              aria-invalid={rangeOk ? undefined : true}
            />
          </div>
          <div>
            <Label htmlFor="grid-upper" className="text-[10px] text-zinc-500">
              Upper price <span className="text-zinc-600">2 d.p.</span>
            </Label>
            <Input
              id="grid-upper"
              value={upper}
              onChange={(e) => setUpper(e.target.value)}
              onBlur={() => setUpper((v) => to2dpStr(v))}
              inputMode="decimal"
              step="0.01"
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

          {/* Max SL — price OR percent below the lower bound */}
          <div className={cn('col-span-2 rounded border px-2 py-1.5', slInvalid ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800/70 bg-zinc-950/60')}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Switch id="grid-sl" checked={slOn} onCheckedChange={setSlOn} className="scale-90" />
                <Label htmlFor="grid-sl" className="text-[11px] text-zinc-300">Max stop loss</Label>
              </div>
              <div className="flex items-center gap-1.5">
                <BasisToggle which="sl" value={slBasis} onChange={setSlBasis} disabled={!slOn} />
                <Input
                  value={slBasis === 'percent' ? slPct : slPrice}
                  onChange={(e) => { if (slBasis === 'percent') setSlPct(e.target.value); else setSlPrice(e.target.value) }}
                  inputMode="decimal"
                  disabled={!slOn}
                  placeholder={slBasis === 'percent' ? '5' : 'price'}
                  aria-label={slBasis === 'percent'
                    ? (sellGrid
                        ? 'Max stop loss percent (0–90) above the upper price'
                        : 'Max stop loss percent (0–90) below the lower price')
                    : (sellGrid
                        ? 'Max stop loss price — whole-grid hard ceiling above the upper price'
                        : 'Max stop loss price — whole-grid hard floor below the lower price')}
                  className="h-7 w-20 border-zinc-800 bg-zinc-950 text-right text-xs tabular-nums"
                />
              </div>
            </div>
            {slOn && slBasis === 'percent' && rangeOk && slPctValid && (
              <p className="mt-1 text-right text-[10px] tabular-nums text-zinc-500">
                ≈ trigger {fmtPrice(slResolved)}{' '}
                <span className="text-zinc-600">{sellGrid ? <>above upper {fmtPrice(upperN)}</> : <>below lower {fmtPrice(lowerN)}</>}</span>
              </p>
            )}
          </div>

          {/* Max TP — price OR percent above the upper bound */}
          <div className={cn('col-span-2 rounded border px-2 py-1.5', tpInvalid ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800/70 bg-zinc-950/60')}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Switch id="grid-tp" checked={tpOn} onCheckedChange={setTpOn} className="scale-90" />
                <Label htmlFor="grid-tp" className="text-[11px] text-zinc-300">Max take profit</Label>
              </div>
              <div className="flex items-center gap-1.5">
                <BasisToggle which="tp" value={tpBasis} onChange={setTpBasis} disabled={!tpOn} />
                <Input
                  value={tpBasis === 'percent' ? tpPct : tpPrice}
                  onChange={(e) => { if (tpBasis === 'percent') setTpPct(e.target.value); else setTpPrice(e.target.value) }}
                  inputMode="decimal"
                  disabled={!tpOn}
                  placeholder={tpBasis === 'percent' ? '5' : 'price'}
                  aria-label={tpBasis === 'percent'
                    ? (sellGrid
                        ? 'Max take profit percent (0–1000) below the lower price'
                        : 'Max take profit percent (0–1000) above the upper price')
                    : (sellGrid
                        ? 'Max take profit price — whole-grid profit floor below the lower price'
                        : 'Max take profit price — whole-grid profit ceiling above the upper price')}
                  className="h-7 w-20 border-zinc-800 bg-zinc-950 text-right text-xs tabular-nums"
                />
              </div>
            </div>
            {tpOn && tpBasis === 'percent' && rangeOk && tpPctValid && (
              <p className="mt-1 text-right text-[10px] tabular-nums text-zinc-500">
                ≈ trigger {fmtPrice(tpResolved)}{' '}
                <span className="text-zinc-600">{sellGrid ? <>below lower {fmtPrice(lowerN)}</> : <>above upper {fmtPrice(upperN)}</>}</span>
              </p>
            )}
          </div>

          <div className="col-span-2 flex items-center justify-between rounded border border-zinc-800/70 bg-zinc-950/60 px-2 py-1.5">
            <div>
              <p className="text-[11px] text-zinc-300">Close when grid stops</p>
              <p className="text-[10px] leading-snug text-zinc-500">
                {sellGrid
                  ? 'market-BUY back all open lots when the grid stops (guard hit or manual stop)'
                  : 'market-sell all open lots when the grid stops (guard hit or manual stop)'}
              </p>
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
              {slOn && (slBasis === 'percent'
                ? (rangeOk && slPctValid
                    ? <div>Max SL {trimNum(slPctN)}% → <span className="font-semibold text-rose-300">{fmtPrice(slResolved)}</span></div>
                    : null)
                : (Number.isFinite(slN) && slN > 0
                    ? <div>Max SL <span className="font-semibold text-rose-300">{fmtPrice(slN)}</span></div>
                    : null))}
              {tpOn && (tpBasis === 'percent'
                ? (rangeOk && tpPctValid
                    ? <div>Max TP {trimNum(tpPctN)}% → <span className="font-semibold text-emerald-300">{fmtPrice(tpResolved)}</span></div>
                    : null)
                : (Number.isFinite(tpN) && tpN > 0
                    ? <div>Max TP <span className="font-semibold text-emerald-300">{fmtPrice(tpN)}</span></div>
                    : null))}
            </div>
          ) : (
            <span className="text-zinc-600">Enter a valid range (upper &gt; lower &gt; 0) and level count to see the preview</span>
          )}
          {(slInvalid || tpInvalid) && (
            <p className="mt-1 flex items-start gap-1 text-amber-400">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {slInvalid
                ? (slBasis === 'percent'
                    ? (sellGrid ? 'Max SL % must be within 0–90 (it sits above the upper price).' : 'Max SL % must be within 0–90 (it sits below the lower price).')
                    : (sellGrid ? 'Max SL must be a positive price ABOVE the upper price (short-grid hard ceiling).' : 'Max SL must be a positive price BELOW the lower price.'))
                : (tpBasis === 'percent'
                    ? (sellGrid ? 'Max TP % must be within 0–1000 (it sits below the lower price).' : 'Max TP % must be within 0–1000 (it sits above the upper price).')
                    : (sellGrid ? 'Max TP must be a positive price BELOW the lower price (short-grid profit floor).' : 'Max TP must be a positive price ABOVE the upper price.'))}
            </p>
          )}
        </div>

        {/* auto-optimize (Task 10-g) — sweeps range width × level count around
            the live price over the backtest window and fills the winner into
            the form. Quantity + SL/TP guards are left untouched. */}
        <div className="rounded border border-zinc-800/70 bg-zinc-950/60">
          <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden />
            <span className="text-[11px] font-medium text-zinc-300">Auto optimize</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px] text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
              disabled={optRunning || !qtyOk}
              onClick={() => void runOptimize()}
            >
              {optRunning ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Sparkles className="h-3 w-3" aria-hidden />}
              Optimize range
            </Button>
            {!qtyOk && <span className="text-[10px] text-zinc-600">valid quantity required</span>}
            {qtyOk && <span className="text-[10px] text-zinc-600">on {btDays}d · keeps qty + SL/TP</span>}
          </div>
          {optError && (
            <p className="flex items-start gap-1 px-2.5 pb-2 text-[11px] text-rose-400">
              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {optError}
            </p>
          )}
          {optNote && (
            <p className="border-t border-zinc-800/60 px-2.5 py-2 text-[10px] leading-relaxed text-amber-300/90">{optNote}</p>
          )}
        </div>

        {/* backtest (Task 10-b) — simulated over historical bars with the CURRENT form values */}
        <div className="rounded border border-zinc-800/70 bg-zinc-950/60">
          <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
            <FlaskConical className="h-3.5 w-3.5 shrink-0 text-violet-400" aria-hidden />
            <span className="text-[11px] font-medium text-zinc-300">Backtest</span>
            <Select value={btDays} onValueChange={(v) => { if (BT_DAYS.includes(v)) setBtDays(v) }}>
              <SelectTrigger className="h-7 w-[86px] border-zinc-800 bg-zinc-950 text-[11px]" aria-label="Backtest period in days">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 text-xs">
                {BT_DAYS.map((d) => <SelectItem key={d} value={d}>{d} days</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px] text-violet-300 hover:bg-violet-500/10 hover:text-violet-200"
              disabled={btRunning || btBlockReason != null}
              onClick={() => void runBacktest()}
            >
              {btRunning ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FlaskConical className="h-3 w-3" aria-hidden />}
              Run backtest
            </Button>
            {btBlockReason && <span className="text-[10px] text-zinc-600">{btBlockReason}</span>}
          </div>

          {!isCrypto && (
            <p className="border-t border-zinc-800/60 px-2.5 py-2 text-[10px] leading-relaxed text-zinc-500">
              Stock grids submit orders in RTH only (09:30–16:00 ET, Mon–Fri) —
              the engine skips orders outside regular hours (Alpaca rejects them)
              and this backtest mirrors that. Crypto grids trade 24/7.
            </p>
          )}

          {btError && (
            <p className="flex items-start gap-1 px-2.5 pb-2 text-[11px] text-rose-400">
              <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {btError}
            </p>
          )}
          {btStale && (
            <p className="px-2.5 pb-2 text-[10px] text-amber-400/90">config changed — re-run</p>
          )}

          {bt && (
            <div className="terminal-scroll max-h-[40vh] overflow-y-auto border-t border-zinc-800/60 px-2.5 py-2">
              {bt.stopped && bt.stopReason && (
                <p className="mb-1.5 flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-400">
                  <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  Stopped: {bt.stopReason}
                </p>
              )}
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Total P/L</p>
                  <p className={cn(BT_TILE_VALUE, pnlCls(bt.stats.totalPnl))}>{signed(bt.stats.totalPnl)}</p>
                </div>
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Realized</p>
                  <p className={cn(BT_TILE_VALUE, pnlCls(bt.stats.realizedPnl))}>{signed(bt.stats.realizedPnl)}</p>
                </div>
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Open</p>
                  <p className={cn(BT_TILE_VALUE, pnlCls(bt.stats.openPnl))}>{signed(bt.stats.openPnl)}</p>
                </div>
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Fills</p>
                  <p className={cn(BT_TILE_VALUE, 'text-zinc-200')}>
                    {bt.stats.fillsCount}
                    <span className="ml-1 text-[10px] font-normal text-zinc-500">{bt.stats.buys}B/{bt.stats.sells}S</span>
                  </p>
                </div>
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Win rate</p>
                  <p className={cn(BT_TILE_VALUE, 'text-zinc-200')}>{bt.stats.winRate != null ? `${bt.stats.winRate.toFixed(0)}%` : '—'}</p>
                </div>
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Max drawdown</p>
                  <p className={cn(BT_TILE_VALUE, 'text-rose-400')}>{Number(bt.stats.maxDrawdown ?? 0).toFixed(2)}</p>
                </div>
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Bars</p>
                  <p className={cn(BT_TILE_VALUE, 'text-zinc-200')}>
                    {bt.bars}
                    <span className="ml-1 text-[10px] font-normal text-zinc-500">{bt.timeframe}</span>
                  </p>
                </div>
                <div className={BT_TILE}>
                  <p className={BT_TILE_LABEL}>Period</p>
                  <p className="text-[11px] font-medium tabular-nums text-zinc-300">
                    {new Date(bt.started).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    {' → '}
                    {new Date(bt.ended).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                  </p>
                </div>
              </div>

              <p className="mt-2 text-[10px] uppercase tracking-wider text-zinc-500">Total P/L curve</p>
              <PnlSparkline curve={bt.curve} finalPnl={bt.stats.totalPnl} />

              <Collapsible open={btFillsOpen} onOpenChange={setBtFillsOpen} className="mt-1.5">
                <CollapsibleTrigger className="flex w-full items-center gap-1 rounded px-0.5 py-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300">
                  <ChevronDown className={cn('h-3 w-3 transition-transform', btFillsOpen && 'rotate-180')} aria-hidden />
                  Fills ({bt.fills.length})
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-1 max-h-48 overflow-y-auto rounded border border-zinc-800/70 terminal-scroll">
                    <table className="w-full text-left text-[11px] tabular-nums">
                      <thead className="sticky top-0 bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                        <tr>
                          <th className="px-2 py-1.5 font-medium">Time</th>
                          <th className="px-2 py-1.5 font-medium">Side</th>
                          <th className="px-2 py-1.5 font-medium">Reason</th>
                          <th className="px-2 py-1.5 text-right font-medium">Price</th>
                          <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                          <th className="px-2 py-1.5 text-right font-medium">P/L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bt.fills.length === 0 && (
                          <tr><td colSpan={6} className="px-2 py-3 text-center text-zinc-500">No fills in this backtest</td></tr>
                        )}
                        {bt.fills.slice(0, 20).map((f, i) => (
                          <tr key={`${f.t}-${i}`} className="border-t border-zinc-800/60 text-zinc-300">
                            <td className="px-2 py-1.5 text-zinc-500">{fmtIso(f.t)}</td>
                            <td className={cn('px-2 py-1.5 font-semibold', f.side === 'buy' ? 'text-sky-400' : 'text-violet-400')}>{String(f.side).toUpperCase()}</td>
                            <td className="px-2 py-1.5 text-zinc-400">{f.reason}</td>
                            <td className="px-2 py-1.5 text-right">{fmtPrice(f.price)}</td>
                            <td className="px-2 py-1.5 text-right">{f.qty}</td>
                            <td className={cn('px-2 py-1.5 text-right', f.pnl != null ? pnlCls(f.pnl) : 'text-zinc-600')}>{f.pnl != null ? signed(f.pnl) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {bt.fills.length > 20 && (
                    <p className="mt-1 text-[10px] text-zinc-600">Showing the 20 most recent of {bt.fills.length} fills</p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
          <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">
            paper mode · {direction === 'both' ? 'both sides' : direction === 'buy' ? 'buy-only ladder' : 'sell-only ladder'}
          </Badge>
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
              {editGrid ? 'Save changes' : 'Start grid'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
