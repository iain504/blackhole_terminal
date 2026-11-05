// Taoist loading set (v2.12.16) — 道家 loading 動畫.
//
// Replaces the lucide Loader2 whirr across the whole terminal with ink-wash
// Taoist imagery, per the ask "所有loading 畫面/風格/動畫都加入道家元素":
//
//  • TaijiSpinner    — an ink 太極 (yin-yang) turning at an unhurried 1.8 s
//    (道法自然: loading should breathe, not panic). The dark half takes the
//    host text color (currentColor) so the spinner stays legible on every
//    surface — emerald chart loading, zinc panels, cinnabar buttons — while
//    the light half stays 宣紙 paper. Rotation lives on an INNER <g> (not the
//    svg) so host positioning classes like `-translate-y-1/2` survive — the
//    old `Loader2 + animate-spin + translate` combo silently fought over the
//    same `transform` property.
//  • TaoistBootLoader — the full boot 畫面 loader: 太極 center turning
//    slowly, encircled by the 先天八卦 trigram ring (乾 at top, clockwise
//    乾兌離震巽坎艮坤) counter-rotating over 46 s. Reads as a環 of 爻 around
//    the still point — 「靜為躁君」.
//
// Both are pure SVG — zero deps, crisp at any size, respects
// prefers-reduced-motion (falls back to a static emblem).

const TAIJI_PAPER = 'var(--taiji-paper, #ece7dc)'

// Shared taiji geometry (viewBox 0 0 48 48, circle r=22 centered 24,24):
// light paper base + the ink S-fish + the two 相反 dots + a faint ink rim.
function TaijiPaths() {
  return (
    <>
      <circle cx="24" cy="24" r="22" fill={TAIJI_PAPER} />
      <path
        d="M24 2 A22 22 0 0 1 24 46 A11 11 0 0 1 24 24 A11 11 0 0 0 24 2 Z"
        fill="currentColor"
      />
      <circle cx="24" cy="13" r="3.4" fill={TAIJI_PAPER} />
      <circle cx="24" cy="35" r="3.4" fill="currentColor" />
      <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity="0.3" />
    </>
  )
}

/**
 * Ink 太極 spinner. Drop-in for `<Loader2 className="h-4 w-4 animate-spin" />`:
 * accepts the same className (size/text-color utilities apply; any passed
 * `animate-spin` is stripped — the taiji brings its own calmer rotation).
 */
export function TaijiSpinner({ className }: { className?: string }) {
  const cls = typeof className === 'string' ? className.replace(/\banimate-spin\b/g, '').trimEnd() : undefined
  return (
    <svg viewBox="0 0 48 48" className={cls} aria-hidden="true">
      <g className="tt-taiji-rot" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
        <TaijiPaths />
      </g>
    </svg>
  )
}

// 先天八卦 (Fu Xi) arrangement, drawn top-line-first; the trigram's BOTTOM
// line sits innermost (faces the taiji). 乾☰ 兌☱ 離☲ 震☳ 巽☴ 坎☵ 艮☶ 坤☷.
// true = solid (陽) line, false = broken (陰) line.
const TRIGRAMS: boolean[][] = [
  [true, true, true], // 乾
  [false, true, true], // 兌
  [true, false, true], // 離
  [false, false, true], // 震
  [true, true, false], // 巽
  [false, true, false], // 坎
  [true, false, false], // 艮
  [false, false, false], // 坤
]

/**
 * The full boot 畫面 emblem: taiji at the still point, 八卦 ring slowly
 * wheeling the other way. Give it an explicit square size, e.g.
 * `<TaoistBootLoader className="h-28 w-28 text-zinc-300" />`.
 */
export function TaoistBootLoader({ className }: { className?: string }) {
  const cls = typeof className === 'string' ? className.replace(/\banimate-spin\b/g, '').trimEnd() : undefined
  return (
    <svg viewBox="0 0 100 100" className={cls} aria-hidden="true">
      {/* heaven wheel + inner boundary of the 爻 band */}
      <circle cx="50" cy="50" r="48.5" fill="none" stroke="currentColor" strokeWidth="0.7" strokeOpacity="0.4" />
      <circle cx="50" cy="50" r="33" fill="none" stroke="currentColor" strokeWidth="0.7" strokeOpacity="0.28" />
      {/* trigram ring — counter-rotates, 46 s per revolution */}
      <g className="tt-bagua-rot" fill="currentColor" opacity="0.62" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
        {TRIGRAMS.map((pattern, i) => (
          <g key={i} transform={`rotate(${i * 45} 50 50)`}>
            {pattern.map((solid, k) => {
              // k=0 is the trigram's top line → outermost ring radius
              const r = 45 - k * 4
              const y = 50 - r - 1.2
              return solid ? (
                <rect key={k} x="43.5" y={y} width="13" height="2.4" rx="1.2" />
              ) : (
                <g key={k}>
                  <rect x="43.5" y={y} width="5.4" height="2.4" rx="1.2" />
                  <rect x="51.1" y={y} width="5.4" height="2.4" rx="1.2" />
                </g>
              )
            })}
          </g>
        ))}
      </g>
      {/* the still point — taiji scaled into the 100-box center */}
      <g className="tt-taiji-rot-slow" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
        <g transform="translate(21.68 21.68) scale(1.18)">
          <TaijiPaths />
        </g>
      </g>
    </svg>
  )
}
