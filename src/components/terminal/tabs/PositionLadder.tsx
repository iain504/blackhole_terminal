'use client'

// PositionLadder (v2.12.44) — a per-position price-ladder progress bar for the
// Positions tab. The track spans [lowest reference price .. highest reference
// price] (normally SL .. TP) and every reference point is placed at its TRUE
// price position, so the labels read left→right exactly in price order:
//
//   Long in profit :  SL | Entry | Current | TP
//   Long in loss   :  SL | Current | Entry | TP   (price fell back under entry)
//   Short in profit:  TP | Current | Entry | SL   (mirror — profit is downward)
//   Short in loss  :  TP | Entry | Current | SL
//
// Zones (under the markers):
//   entry ↔ SL  = planned RISK region  (faint rose)
//   entry ↔ TP  = planned REWARD region (faint emerald)
//   entry ↔ Current = LIVE fill (solid emerald when favorable, rose when adverse)
// A current price that has fallen THROUGH the stop (or spiked past the TP)
// stretches the scale and visibly crosses the SL/TP tick — the geometry tells
// the story without any special-casing.
//
// Missing exits simply omit their zone; a trailing stop that carries only a
// trailPercent (no working stop price yet) is ESTIMATED from the current
// price (long: cur × (1 − trail%), short: cur × (1 + trail%)) and its label
// carries a tooltip saying so. Degenerate input (no usable prices) renders
// nothing — the row falls back to the plain table cells.
import { fmtPrice } from '@/lib/market-types'
import { cn } from '@/lib/utils'

/** The pieces of an ExitInfo the ladder needs (structurally compatible with
 * both the positions-route ExitInfo and the chart trading-types one). */
export interface LadderExitInfo {
  stopPrice: number | null
  limitPrice: number | null
  trailPercent: number | null
  type: string
}

type LadderKind = 'sl' | 'entry' | 'cur' | 'tp'

interface LadderPoint {
  kind: LadderKind
  price: number
  /** 0..100 position on the track */
  pct: number
}

export interface LadderGeom {
  points: LadderPoint[]
  entryPct: number
  curPct: number
  slPct: number | null
  tpPct: number | null
  /** favorable side = current price on the profit side of entry */
  favorable: boolean
  /** SL price estimated from a trailPercent (no working stop price) */
  slEst: boolean
}

/** Effective SL price for the ladder: the working stop/limit price, or a
 * trailing estimate computed from the current price when only trailPercent
 * is known. Returns null when nothing usable is attached. */
function exitSlPrice(
  sl: LadderExitInfo | null | undefined,
  cur: number,
  side: string,
): { price: number; est: boolean } | null {
  if (!sl) return null
  const direct = sl.stopPrice ?? sl.limitPrice
  if (direct != null && Number.isFinite(direct) && direct > 0) return { price: direct, est: false }
  const trail = sl.trailPercent
  if (trail != null && Number.isFinite(trail) && trail > 0 && cur > 0) {
    const f = trail / 100
    return { price: side === 'long' ? cur * (1 - f) : cur * (1 + f), est: true }
  }
  return null
}

/** Pure geometry — exported for probe scripts (real incident numbers replay). */
export function ladderGeometry(
  side: string,
  entry: number,
  cur: number,
  sl: LadderExitInfo | null | undefined,
  tp: LadderExitInfo | null | undefined,
): LadderGeom | null {
  if (!(entry > 0) || !(cur > 0) || !Number.isFinite(entry) || !Number.isFinite(cur)) return null
  const slP = exitSlPrice(sl, cur, side)
  const tpRaw = tp ? (tp.limitPrice ?? tp.stopPrice) : null
  const tpP = tpRaw != null && Number.isFinite(tpRaw) && tpRaw > 0 ? tpRaw : null
  const prices = [entry, cur]
  if (slP) prices.push(slP.price)
  if (tpP != null) prices.push(tpP)
  let lo = Math.min(...prices)
  let hi = Math.max(...prices)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  // degenerate scale (entry === current with no exits): pad ±0.5% so the bar exists
  if (hi - lo < 1e-9) {
    lo *= 0.995
    hi *= 1.005
  }
  const pct = (p: number): number => ((p - lo) / (hi - lo)) * 100
  const points: LadderPoint[] = [
    { kind: 'entry', price: entry, pct: pct(entry) },
    { kind: 'cur', price: cur, pct: pct(cur) },
    ...(slP ? [{ kind: 'sl' as const, price: slP.price, pct: pct(slP.price) }] : []),
    ...(tpP != null ? [{ kind: 'tp' as const, price: tpP, pct: pct(tpP) }] : []),
  ]
  points.sort((a, b) => a.pct - b.pct)
  return {
    points,
    entryPct: pct(entry),
    curPct: pct(cur),
    slPct: slP ? pct(slP.price) : null,
    tpPct: tpP != null ? pct(tpP) : null,
    favorable: side === 'long' ? cur > entry : cur < entry,
    slEst: slP?.est ?? false,
  }
}

/** Label layout: nudge label CENTERS apart (order-preserving, two constraint
 * passes — push right, then push left) so nearby points like Entry 108.99 /
 * Current 109.02 stay readable while the on-track markers keep their true
 * positions. With ≤ 4 labels and a 13% minimum gap there is always room. */
const LBL_MIN_GAP = 13
const LBL_EDGE = 5
export function layoutLadderLabels(points: LadderPoint[]): Array<{ pt: LadderPoint; x: number }> {
  const xs = points.map((p) => Math.min(100 - LBL_EDGE, Math.max(LBL_EDGE, p.pct)))
  for (let i = 1; i < xs.length; i++) xs[i] = Math.min(100 - LBL_EDGE, Math.max(xs[i], xs[i - 1] + LBL_MIN_GAP))
  for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.max(LBL_EDGE, Math.min(xs[i], xs[i + 1] - LBL_MIN_GAP))
  return points.map((pt, i) => ({ pt, x: xs[i] }))
}

const LABEL_CLASS: Record<LadderKind, string> = {
  sl: 'text-rose-400',
  entry: 'text-zinc-400',
  cur: 'font-semibold',
  tp: 'text-emerald-400',
}

function labelFor(pt: LadderKind, price: number): string {
  switch (pt) {
    case 'sl': return `SL ${fmtPrice(price)}`
    case 'entry': return `Entry ${fmtPrice(price)}`
    case 'cur': return `Current ${fmtPrice(price)}`
    case 'tp': return `TP ${fmtPrice(price)}`
  }
}

/** A short segment between two pct positions (null when degenerate). */
function zone(from: number, to: number): { left: string; width: string } | null {
  const a = Math.min(from, to)
  const b = Math.max(from, to)
  const w = b - a
  if (w <= 0.05) return null
  return { left: `${a}%`, width: `${w}%` }
}

export default function PositionLadder({
  side,
  entry,
  current,
  sl,
  tp,
  symbol,
  uplPct,
  variant = 'full',
}: {
  side: string
  entry: number
  current: number
  sl?: LadderExitInfo | null
  tp?: LadderExitInfo | null
  /** symbol — aria label context only */
  symbol?: string
  /** live unrealized P&L % — aria label context only */
  uplPct?: number
  /** v2.12.46 — 'full' (default) renders the four nudged price labels above
   *  the track; 'compact' fits a TABLE CELL (a narrow Progress column before
   *  Close position): same track geometry, no price labels — just two micro
   *  endpoint tags (SL/TP, colored by kind) and the full ladder text as a
   *  hover title. */
  variant?: 'full' | 'compact'
}) {
  const geom = ladderGeometry(side, entry, current, sl, tp)
  if (!geom) return null
  const labels = layoutLadderLabels(geom.points)
  const fill = zone(geom.entryPct, geom.curPct)
  const risk = geom.slPct != null ? zone(geom.entryPct, geom.slPct) : null
  const reward = geom.tpPct != null ? zone(geom.entryPct, geom.tpPct) : null
  const pnlTxt =
    uplPct != null && Number.isFinite(uplPct)
      ? ` — ${uplPct >= 0 ? 'in profit' : 'in loss'} ${uplPct >= 0 ? '+' : '−'}${Math.abs(uplPct).toFixed(2)}%`
      : ''
  const aria =
    `${(symbol ? `${symbol} ` : '') + side.toUpperCase()} price ladder: ` +
    ['sl', 'entry', 'cur', 'tp']
      .map((k) => geom.points.find((p) => p.kind === k))
      .filter((p): p is LadderPoint => p != null)
      .map((p) => labelFor(p.kind, p.price))
      .join(', ') +
    pnlTxt
  const compact = variant === 'compact'
  // compact: micro endpoint tags — only the SL/TP endpoints get a tag
  // (Entry/Current are already carried by the tick + dot); a side whose
  // endpoint is entry/current shows no tag.
  const first = geom.points[0]
  const last = geom.points[geom.points.length - 1]
  const tagKind = (pt: LadderPoint | undefined): 'sl' | 'tp' | null =>
    pt && (pt.kind === 'sl' || pt.kind === 'tp') ? pt.kind : null
  const leftTag = tagKind(first)
  const rightTag = tagKind(last)
  const track = (
    <div className="relative h-2 rounded-full bg-zinc-800 ring-1 ring-inset ring-zinc-700/60">
      {/* planned RISK region: entry ↔ SL */}
      {risk && (
        <div className="absolute inset-y-0 rounded-full bg-rose-500/20" style={{ left: risk.left, width: risk.width }} />
      )}
      {/* planned REWARD region: entry ↔ TP */}
      {reward && (
        <div className="absolute inset-y-0 rounded-full bg-emerald-500/15" style={{ left: reward.left, width: reward.width }} />
      )}
      {/* LIVE fill: entry ↔ current (emerald favorable / rose adverse) */}
      {fill && (
        <div
          className={cn('absolute inset-y-0 rounded-full', geom.favorable ? 'bg-emerald-400/70' : 'bg-rose-500/70')}
          style={{ left: fill.left, width: fill.width }}
        />
      )}
      {/* SL / TP ticks */}
      {geom.slPct != null && (
        <div
          className="absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-400/90"
          style={{ left: `${geom.slPct}%` }}
        />
      )}
      {geom.tpPct != null && (
        <div
          className="absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/90"
          style={{ left: `${geom.tpPct}%` }}
        />
      )}
      {/* Entry tick (neutral) */}
      <div
        className="absolute top-1/2 h-3.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-300/80"
        style={{ left: `${geom.entryPct}%` }}
      />
      {/* Current price dot */}
      <div
        className={cn(
          'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-zinc-900',
          geom.favorable ? 'bg-emerald-400' : 'bg-rose-400',
        )}
        style={{ left: `${geom.curPct}%` }}
      />
    </div>
  )
  if (compact) {
    return (
      <div role="img" aria-label={aria} title={aria} className="select-none">
        {(leftTag || rightTag) && (
          <div className="mb-0.5 flex items-baseline justify-between text-[9px] font-semibold leading-[10px] tracking-wide">
            {/* missing endpoint renders EMPTY text (never the other kind's label) */}
            <span className={leftTag === 'sl' ? 'text-rose-400' : 'text-emerald-400'}>{leftTag === 'sl' ? 'SL' : leftTag === 'tp' ? 'TP' : ''}</span>
            <span className={rightTag === 'sl' ? 'text-rose-400' : 'text-emerald-400'}>{rightTag === 'sl' ? 'SL' : rightTag === 'tp' ? 'TP' : ''}</span>
          </div>
        )}
        {track}
      </div>
    )
  }
  return (
    <div role="img" aria-label={aria} className="select-none py-0.5">
      {/* label row — nudged so the four price tags never collide */}
      <div className="relative mb-1 h-[13px]">
        {labels.map(({ pt, x }) => (
          <span
            key={pt.kind}
            className={cn(
              'absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] leading-[13px] tabular-nums',
              LABEL_CLASS[pt.kind],
              pt.kind === 'cur' && (geom.favorable ? 'text-emerald-300' : 'text-rose-300'),
            )}
            style={{ left: `${x}%` }}
            title={
              pt.kind === 'sl' && geom.slEst
                ? `Trailing stop — estimated from the current price (${side === 'long' ? '−' : '+'}${sl?.trailPercent ?? ''}% trail)`
                : undefined
            }
          >
            {labelFor(pt.kind, pt.price)}
          </span>
        ))}
      </div>
      {track}
    </div>
  )
}
