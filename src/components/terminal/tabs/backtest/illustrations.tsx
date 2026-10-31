'use client'

// v2.2.0 — Backtest Studio inline SVG illustrations (spec §2.3).
//
// Hand-drawn, decorative, themeable: strokes use the ambient `currentColor`
// where the drawing is neutral, accents come from the existing terminal
// palette (sky #38bdf8 · green #22c55e · amber #f59e0b · pink #f472b6 ·
// purple #a855f7 · teal #2dd4bf · rose #fb7185). Every SVG is aria-hidden —
// the meaning is always duplicated in adjacent text.

const GREEN = '#22c55e'
const ROSE = '#fb7185'
const AMBER = '#f59e0b'
const SKY = '#38bdf8'
const PURPLE = '#a855f7'
const TEAL = '#2dd4bf'

/** Candle drawing shared by the lane illustrations. */
function Candle({ x, y, w, h, wickH, up }: { x: number; y: number; w: number; h: number; wickH: number; up: boolean }) {
  const c = up ? GREEN : ROSE
  return (
    <g stroke={c} strokeWidth={1.6} strokeLinecap="round">
      <line x1={x + w / 2} y1={y - wickH} x2={x + w / 2} y2={y + h + wickH} />
      <rect x={x} y={y} width={w} height={h} rx={1.2} fill={c} fillOpacity={0.28} />
    </g>
  )
}

/** ① Day-trading lane: sun + a dense tape of small candles inside a session box. */
export function DayLaneIllo({ className }: { className?: string }) {
  const candles = [
    { x: 16, y: 42, h: 9, w: 6, wickH: 4, up: true },
    { x: 29, y: 38, h: 7, w: 6, wickH: 4, up: false },
    { x: 42, y: 40, h: 11, w: 6, wickH: 5, up: true },
    { x: 55, y: 45, h: 8, w: 6, wickH: 4, up: false },
    { x: 68, y: 41, h: 6, w: 6, wickH: 3, up: true },
    { x: 81, y: 36, h: 9, w: 6, wickH: 5, up: true },
    { x: 94, y: 44, h: 10, w: 6, wickH: 4, up: false },
    { x: 107, y: 39, h: 7, w: 6, wickH: 4, up: true },
  ]
  return (
    <svg viewBox="0 0 132 76" className={className} aria-hidden="true" focusable="false">
      {/* session box */}
      <rect x={6} y={10} width={120} height={60} rx={8} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.4} />
      <line x1={6} y1={30} x2={126} y2={30} stroke="currentColor" strokeOpacity={0.18} strokeWidth={1} />
      {/* sun + 8 rays (4 crossing lines) */}
      <g stroke={AMBER} strokeWidth={1.6} strokeLinecap="round">
        <circle cx={104} cy={22} r={6} fill={AMBER} fillOpacity={0.25} />
        <line x1={104} y1={12} x2={104} y2={32} />
        <line x1={94} y1={22} x2={114} y2={22} />
        <line x1={97} y1={15} x2={111} y2={29} />
        <line x1={111} y1={15} x2={97} y2={29} />
      </g>
      {/* dense intraday tape */}
      {candles.map((c, i) => (
        <Candle key={i} {...c} />
      ))}
      {/* session open/close ticks */}
      <g stroke={SKY} strokeWidth={1.4} strokeLinecap="round">
        <line x1={10} y1={62} x2={16} y2={62} />
        <line x1={116} y1={62} x2={122} y2={62} />
      </g>
    </svg>
  )
}

/** ① Swing lane: crescent moon + tall candles spanning dashed S/R over day gridlines. */
export function SwingLaneIllo({ className }: { className?: string }) {
  const candles = [
    { x: 20, y: 34, h: 22, w: 8, wickH: 7, up: true },
    { x: 45, y: 26, h: 18, w: 8, wickH: 6, up: false },
    { x: 70, y: 30, h: 26, w: 8, wickH: 8, up: true },
    { x: 95, y: 22, h: 20, w: 8, wickH: 7, up: true },
    { x: 116, y: 32, h: 16, w: 8, wickH: 6, up: false },
  ]
  return (
    <svg viewBox="0 0 132 76" className={className} aria-hidden="true" focusable="false">
      {/* 3 faint day gridlines */}
      <g stroke="currentColor" strokeOpacity={0.22} strokeWidth={1} strokeDasharray="2 4">
        <line x1={38} y1={8} x2={38} y2={70} />
        <line x1={66} y1={8} x2={66} y2={70} />
        <line x1={94} y1={8} x2={94} y2={70} />
      </g>
      {/* dashed S/R lines */}
      <line x1={10} y1={18} x2={122} y2={18} stroke={AMBER} strokeWidth={1.4} strokeDasharray="5 4" strokeLinecap="round" />
      <line x1={10} y1={60} x2={122} y2={60} stroke={TEAL} strokeWidth={1.4} strokeDasharray="5 4" strokeLinecap="round" />
      {/* crescent moon */}
      <path d="M22 12a7.5 7.5 0 1 0 6.5 11.2A8.5 8.5 0 1 1 22 12Z" fill={PURPLE} fillOpacity={0.75} />
      {/* tall multi-day candles */}
      {candles.map((c, i) => (
        <Candle key={i} {...c} />
      ))}
    </svg>
  )
}

/** ②/③ MTF ladder — trend → confirm → trigger, labels from the FROZEN maps. */
export function MtfLadderIllo({ trendTf, midTf, entryTf, className }: { trendTf: string; midTf: string; entryTf: string; className?: string }) {
  const box = { x: 25, w: 120, h: 30, rx: 8 }
  return (
    <svg viewBox="0 0 170 136" className={className} aria-hidden="true" focusable="false">
      <rect x={box.x} y={4} width={box.w} height={box.h} rx={box.rx} fill={PURPLE} fillOpacity={0.1} stroke={PURPLE} strokeWidth={1.5} />
      <text x={85} y={23} textAnchor="middle" fontSize={11} fontWeight={700} fill="#d8b4fe">{trendTf} · trend</text>
      <g stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <line x1={85} y1={36} x2={85} y2={50} />
        <polyline points="80,45 85,51 90,45" fill="none" />
      </g>
      <rect x={box.x} y={52} width={box.w} height={box.h} rx={box.rx} fill={AMBER} fillOpacity={0.1} stroke={AMBER} strokeWidth={1.5} />
      <text x={85} y={66} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fcd34d">{midTf} · confirm</text>
      <text x={85} y={77} textAnchor="middle" fontSize={8} fill="#fcd34d" fillOpacity={0.85}>S/R + RSI band</text>
      <g stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <line x1={85} y1={84} x2={85} y2={98} />
        <polyline points="80,93 85,99 90,93" fill="none" />
      </g>
      <rect x={box.x} y={100} width={box.w} height={box.h} rx={box.rx} fill={SKY} fillOpacity={0.1} stroke={SKY} strokeWidth={1.5} />
      <text x={85} y={119} textAnchor="middle" fontSize={11} fontWeight={700} fill="#7dd3fc">{entryTf} · trigger</text>
    </svg>
  )
}

/**
 * ③ Three-screen diagram (swing strategy cards) — the Elder-style ladder with
 * tiny per-screen annotations: SMA ✓ · RSI 40–70 ✓ · RSI < 40 trigger ●.
 */
export function ThreeScreenIllo({ trendTf, midTf, entryTf, className }: { trendTf: string; midTf: string; entryTf: string; className?: string }) {
  const rows = [
    { y: 4, tf: trendTf, stage: 'trend', note: 'SMA ✓', c: PURPLE, nc: '#86efac' },
    { y: 38, tf: midTf, stage: 'confirm', note: 'RSI 40–70 ✓', c: AMBER, nc: '#86efac' },
    { y: 72, tf: entryTf, stage: 'trigger', note: 'RSI < 40 ●', c: SKY, nc: '#7dd3fc' },
  ]
  return (
    <svg viewBox="0 0 216 110" className={className} aria-hidden="true" focusable="false">
      {/* connector rail with dots */}
      <line x1={14} y1={18} x2={14} y2={92} stroke="currentColor" strokeOpacity={0.4} strokeWidth={1.4} strokeLinecap="round" />
      {rows.map((r) => (
        <g key={r.stage}>
          <circle cx={14} cy={r.y + 14} r={3.4} fill={r.c} />
          <rect x={24} y={r.y} width={188} height={28} rx={7} fill="none" stroke={r.c} strokeOpacity={0.75} strokeWidth={1.3} />
          <text x={34} y={r.y + 18} fontSize={10.5} fontWeight={700} fill={r.c}>
            {r.tf} · {r.stage}
          </text>
          <text x={204} y={r.y + 18} textAnchor="end" fontSize={9.5} fill={r.nc}>
            {r.note}
          </text>
        </g>
      ))}
    </svg>
  )
}

/** ④ Risk bracket — price axis, entry, green TP above, rose SL below, R:R. */
export function RiskBracketIllo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 150 132" className={className} aria-hidden="true" focusable="false">
      {/* price axis with up arrow */}
      <g stroke="currentColor" strokeOpacity={0.5} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        <line x1={30} y1={122} x2={30} y2={14} />
        <polyline points="25,20 30,12 35,20" fill="none" />
        <line x1={26} y1={112} x2={30} y2={112} />
        <line x1={26} y1={66} x2={30} y2={66} />
        <line x1={26} y1={20} x2={30} y2={20} />
      </g>
      {/* TP line */}
      <line x1={42} y1={28} x2={104} y2={28} stroke={GREEN} strokeWidth={1.8} strokeLinecap="round" />
      <text x={44} y={22} fontSize={9} fontWeight={700} fill={GREEN}>TP</text>
      {/* entry line + candle */}
      <line x1={38} y1={70} x2={104} y2={70} stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.3} strokeDasharray="4 3" />
      <text x={40} y={82} fontSize={9} fill="currentColor" fillOpacity={0.65}>entry</text>
      <g stroke={GREEN} strokeWidth={1.5} strokeLinecap="round">
        <line x1={62} y1={60} x2={62} y2={80} />
        <rect x={58} y={64} width={8} height={11} rx={1.2} fill={GREEN} fillOpacity={0.3} />
      </g>
      {/* SL line */}
      <line x1={42} y1={108} x2={104} y2={108} stroke={ROSE} strokeWidth={1.8} strokeLinecap="round" />
      <text x={44} y={122} fontSize={9} fontWeight={700} fill={ROSE}>SL</text>
      {/* R:R measure brackets */}
      <g strokeWidth={1.3} strokeLinecap="round">
        <line x1={122} y1={30} x2={122} y2={68} stroke={GREEN} />
        <line x1={118} y1={30} x2={126} y2={30} stroke={GREEN} />
        <line x1={118} y1={68} x2={126} y2={68} stroke={GREEN} />
        <line x1={122} y1={72} x2={122} y2={106} stroke={ROSE} />
        <line x1={118} y1={72} x2={126} y2={72} stroke={ROSE} />
        <line x1={118} y1={106} x2={126} y2={106} stroke={ROSE} />
      </g>
      <text x={134} y={73} textAnchor="middle" fontSize={8.5} fill="currentColor" fillOpacity={0.7} transform="rotate(90 134 73)">R:R</text>
    </svg>
  )
}
