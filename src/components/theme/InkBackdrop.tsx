// v2.12.11 — global ink-painting backdrop (Chinese dark-grey & white theme).
// Hand-drawn SVG, no raster assets: layered misty mountain ridges rising from
// the bottom, one eagle (雕) soaring in the sky above the peaks, a faint moon
// and a cinnabar seal stamp (the classical painter's signature). Fixed behind
// the whole app at z-0; page roots sit at z-10 with translucent backgrounds so
// the painting shows through without hurting text readability. Pure static
// SVG — zero client JS, scales crisply on every screen. Hidden under the
// light "day" skin (globals.css).

const EAGLE_VIEW = '0 0 300 170'

export function InkBackdrop() {
  return (
    <div aria-hidden className="ink-backdrop">
      {/* moon wash — balances the eagle on the opposite side */}
      <div className="ink-moon" />

      {/* the eagle, high above the ridgeline, gliding toward the frame */}
      <svg
        className="ink-eagle"
        viewBox="0 0 300 170"
        role="presentation"
        focusable="false"
      >
        {/* soft wash under-stroke (the ink bleeding into the paper) */}
        <path d={INK_EAGLE_PATH} fill="currentColor" fillRule="evenodd" />
        <path d={INK_EAGLE_PATH} fill="currentColor" fillRule="evenodd" className="ink-eagle-wash" />
        {/* the far wing — a thinner sliver beneath the raised one */}
        <path
          d="M150,104 C182,88 222,72 256,64 C224,78 188,92 158,106 Z"
          fill="currentColor"
          opacity="0.55"
        />
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
      <span className="ink-seal">雕</span>
    </div>
  )
}

/**
 * Soaring eagle silhouette — SIDE PROFILE, gliding toward the left with one
 * large wing raised and swept back, second wing hinted beneath, hooked beak,
 * fanned tail. (The symmetric V-wing version read as a moth — side profile is
 * the classic, unambiguous eagle read.) Hand-tuned against the render.
 */
const INK_EAGLE_PATH = [
  // hooked beak + head (facing left)
  'M40,104',
  'C46,96 56,92 68,92', // beak underside → crown
  'C86,90 102,93 116,98', // nape → shoulder
  // raised wing — leading edge sweeping up to the wingtip
  'C152,62 214,36 272,26',
  'L288,22', // wingtip
  // trailing edge with primary-feather scallops coming back down
  'L274,40 L282,44 L264,52 L270,58 L252,62 L256,70 L240,68 L243,76 L226,70 L228,78 L212,70',
  // trailing edge to the body
  'C198,78 184,84 172,87',
  // back down to the tail base
  'C176,96 178,104 176,112',
  // fanned tail
  'L198,140 L179,133 L185,152 L166,139 L165,156 L151,137',
  // belly back to the chest
  'C136,131 120,125 106,119',
  'C92,125 76,123 64,115',
  // throat back to the beak
  'C54,118 46,112 40,104',
  'Z',
].join(' ')
