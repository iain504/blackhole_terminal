// v2.12.11 — global ink-painting backdrop (Chinese dark-grey & white theme).
// Hand-drawn SVG, no raster assets: layered misty mountain ridges rising from
// the bottom, a faint moon and a cinnabar seal stamp (the classical painter's
// signature). Fixed behind the whole app at z-0; page roots sit at z-10 with
// translucent backgrounds so the painting shows through without hurting text
// readability. Pure static SVG — zero client JS, scales crisply on every
// screen. Hidden under the light "day" skin (globals.css).
// v2.12.15 — 道家 pass: the eagle (雕) becomes a CRANE (仙鶴) — the Taoist
// immortal's mount, a 長生/仙遊 symbol that fits the new Taoist landing — and
// the seal re-stamps 雕 → 鶴. Class names unchanged (CSS untouched).

export function InkBackdrop() {
  return (
    <div aria-hidden className="ink-backdrop">
      {/* moon wash — balances the eagle on the opposite side */}
      <div className="ink-moon" />

      {/* the crane, high above the ridgeline, gliding toward the frame */}
      <svg
        className="ink-eagle"
        viewBox="0 0 300 170"
        role="presentation"
        focusable="false"
      >
        {/* the far wing — a faint sliver behind the raised one */}
        <path
          d="M158,74 C196,52 228,40 252,32 C230,46 198,62 170,80 Z"
          fill="currentColor"
          opacity="0.4"
        />
        {/* near wing — soft wash under-stroke, then the ink body */}
        <path d={INK_CRANE_WING} fill="currentColor" className="ink-eagle-wash" />
        <path d={INK_CRANE_WING} fill="currentColor" />
        {/* body with the fanned tail tuft */}
        <path d={INK_CRANE_BODY} fill="currentColor" />
        {/* extended neck (cranes fly neck-forward) + trailing legs */}
        <path d="M84,100 C66,98 54,94 46,90" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M148,108 L212,120 l10,3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M158,105 L220,112 l9,2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {/* head + straight beak */}
        <path d="M28,84 L46,78 L49,92 L37,93 Z" fill="currentColor" />
      </svg>

      {/* layered ridges with drifting mist */}
      <svg
        className="ink-mountains"
        viewBox="0 0 1440 420"
        preserveAspectRatio="none"
        role="presentation"
        focusable="false"
      >
        <defs>
          <linearGradient id="ink-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#b7b7c0" stopOpacity="0.34" />
            <stop offset="0.7" stopColor="#b7b7c0" stopOpacity="0.10" />
            <stop offset="1" stopColor="#b7b7c0" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ink-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8e8e98" stopOpacity="0.30" />
            <stop offset="0.75" stopColor="#8e8e98" stopOpacity="0.07" />
            <stop offset="1" stopColor="#8e8e98" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ink-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4b4b55" stopOpacity="0.55" />
            <stop offset="0.55" stopColor="#3a3a43" stopOpacity="0.28" />
            <stop offset="1" stopColor="#26262c" stopOpacity="0.05" />
          </linearGradient>
          <filter id="ink-rough-far" x="-5%" y="-30%" width="110%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.05" numOctaves="2" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="16" />
          </filter>
          <filter id="ink-rough-mid" x="-5%" y="-30%" width="110%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.016 0.06" numOctaves="2" seed="23" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="20" />
          </filter>
          <filter id="ink-rough-near" x="-5%" y="-30%" width="110%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02 0.07" numOctaves="2" seed="41" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="24" />
          </filter>
          <filter id="ink-mist" x="-40%" y="-120%" width="180%" height="340%">
            <feGaussianBlur stdDeviation="22" />
          </filter>
        </defs>

        {/* far ridge — palest wash */}
        <path
          d="M0,238 L110,206 L235,236 L360,178 L505,224 L640,164 L795,226 L930,182 L1085,232 L1230,196 L1350,232 L1440,206 L1440,420 L0,420 Z"
          fill="url(#ink-far)"
          filter="url(#ink-rough-far)"
        />
        {/* mist bands */}
        <ellipse cx="430" cy="252" rx="330" ry="34" fill="#dcdce2" opacity="0.055" filter="url(#ink-mist)" />
        <ellipse cx="1080" cy="244" rx="300" ry="30" fill="#dcdce2" opacity="0.05" filter="url(#ink-mist)" />

        {/* mid ridge */}
        <path
          d="M0,296 L165,254 L330,294 L505,240 L690,288 L870,244 L1055,292 L1245,250 L1440,284 L1440,420 L0,420 Z"
          fill="url(#ink-mid)"
          filter="url(#ink-rough-mid)"
        />
        <ellipse cx="720" cy="316" rx="420" ry="36" fill="#d4d4da" opacity="0.06" filter="url(#ink-mist)" />

        {/* near ridge — heaviest ink */}
        <path
          d="M0,356 L215,320 L440,354 L660,314 L895,358 L1120,324 L1320,358 L1440,338 L1440,420 L0,420 Z"
          fill="url(#ink-near)"
          filter="url(#ink-rough-near)"
        />
      </svg>

      {/* the painter's seal (印章) */}
      <span className="ink-seal">鶴</span>
    </div>
  )
}

/**
 * Gliding CRANE (仙鶴) — SIDE PROFILE, flying left like the old eagle: long
 * straight neck extended forward, small head with a straight beak, one broad
 * wing raised with scalloped primaries, second wing hinted behind, tail tuft
 * and long thin legs trailing straight back (the classic immortal-crane
 * flight read). Hand-tuned against the render.
 */
const INK_CRANE_WING = [
  // shoulder at the body's top → leading edge up to the wingtip
  'M108,94',
  'C140,72 182,46 224,32',
  'C242,26 258,23 270,23',
  'L270,23',
  // trailing edge with primary-feather scallops coming back down
  'L264,34 L272,39 L254,46 L260,54 L242,57 L246,66 L228,61 L230,71 L214,64',
  // trailing edge back to the body
  'C198,74 178,84 160,91',
  'C144,97 126,100 112,100',
  'Z',
].join(' ')

const INK_CRANE_BODY = [
  // chest → back → tail tuft (jagged feathers trailing right) → belly
  'M74,98',
  'C86,94 104,92 124,93',
  'C142,94 158,97 170,101',
  'L194,114 L172,111 L180,122 L160,112',
  'C138,108 112,107 94,106',
  'C84,105 76,102 74,98',
  'Z',
].join(' ')
