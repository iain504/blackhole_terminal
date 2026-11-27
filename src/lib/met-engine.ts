// v2.12.61 — M.E.T. 多重優勢引擎 (MULTIPLE EDGE TRADING ENGINE)
//
// Source framework: J Law's "Multiple Edge Trading System" (M.E.T.) course —
// applied verbatim to the terminal. The chapters map to code like this:
//
//   Ch.5-6  單一信號不可靠（200天線一定有支持？）→ 不看到一個信號就入市；
//           先列做多與做空兩側的優勢，再比較數量與強弱。→ metVerdict()
//   Ch.7-9  五個做空優勢 vs 兩個做多優勢的例子 → 優勢分六大類
//           （趨勢 / 量能 / 均線 / 關鍵位 / 形態 / 位置），逐類檢測兩側。
//   Ch.8    M.E.T.A. = Multiple Edge Trading Area — 多項優勢在同一個價格區域
//           匯聚 → 回調買入區（做多）或阻力匯聚區（做空）。→ metaZone
//   Ch.10-11 回報風險比優先於勝率（5:1 為 A 級、2:1 為 B 級）→ rrTier()
//   Ch.12-14 賭場三原則 + Trader B 的 1% 風險帳本（本終端 sizing 已按
//           權益×riskPct%×信心/100 執行）+ 回撤回本數學 → recoveryGainPct()
//   Ch.16   實作功課：用全部已平倉交易計 勝率 / 均盈均虧 / 期望值 /
//           Profit Factor，判斷系統是否真的賺到錢 → computeExpectancy()
//
// v2.12.62 — the deep-dive course (Edge 1 動能與趨勢 + Edge 2 支持與阻力
// 八大秘訣) lands as deterministic detectors:
//
//   Edge 1  Ch.10-17  強勢趨勢 vs 一般趨勢的解剖（大漲小回 · follow-through
//           燭身少重疊 · 升量≫跌量 · 回調不破 20MA · 高週期同向）→
//           trendMomentum() — 強勢趨勢的順勢側是第一重優勢。
//   Edge 2  Ch.18-28  支持與阻力八大秘訣 → srZoneIntegrity()（秘訣1-2 區間
//           記憶 + 匯聚區成員；秘訣3 flip 由 priorLow15/priorHigh15 引用；
//           秘訣4 測試 ≥4 次力量衰竭）+ shakeoutRead()（秘訣5 洗盤/假突破
//           刺穿收回）+ setupRead()（Ch.13 constructive 整理：縮波動+量縮）
//           + chaseNote()（Ch.28 MRNA：不追離理想進場 >2% 的價）。
//
// All math is pure + client-safe (no fetch, no env) — same contract as
// strategy-library.ts. Detection reads ONLY ChartSnapshot fields, so a demo
// snapshot degrades honestly (fewer edges, never invented ones).

import type { ChartSnapshot } from '@/lib/ai-trade'

// ---- M.E.T. verdict (Ch.6-9: both-side edge enumeration + comparison) ------

export type MetCat = '趨勢' | '量能' | '均線' | '關鍵位' | '形態' | '位置'

export interface MetEdge {
  cat: MetCat
  /** ≤22 char 繁中 description — quoted verbatim in the prompt and tooltips */
  desc: string
  /** 1 = normal edge · 2 = strong edge (MA stack / tested-level confluence —
   *  the two signals the course treats as weight-bearing on their own) */
  w: 1 | 2
}

export interface MetContext {
  longEdges: MetEdge[]
  shortEdges: MetEdge[]
  /** weight sums — the comparison the course actually makes (not raw counts:
   *  a stacked-MA edge outweighs a positional one) */
  longW: number
  shortW: number
  leader: 'long' | 'short' | 'balanced'
  /** |longW − shortW| — 0 when balanced */
  dominance: number
  /** M.E.T.A. grade: the leader side carries ≥3 edges AND outweighs the other
   *  side by ≥2 — Ch.8's 「多項優勢在同一個價格區域匯聚」 bar */
  meta: boolean
  /** Ch.8 M.E.T.A. zone on the leader side (pullback-buy / rally-sell area):
   *  the tested level ± half ATR, enriched when SMA20 converges into it */
  zone: { lo: number; hi: number; basis: string } | null
  /** 繁中 one-liner for logs + prompt, e.g. 「多 5(w6) vs 空 1(w1) — 偏多 · M.E.T.A.」 */
  summary: string
  /** v2.12.62 — Edge 1: the symbol's 強勢/一般趨勢 anatomy (Ch.10-17) */
  tm: TrendMomentum
  /** v2.12.62 — Edge 2: per-side M.E.T.A. zone integrity (8 secrets) */
  zones: { long: SrZoneIntegrity | null; short: SrZoneIntegrity | null }
  /** v2.12.62 — Edge 2 secret 5: shakeout / failed-breakout trap read */
  shakeout: ShakeoutRead
  /** v2.12.62 — Ch.13: constructive 整理 (setup) maturity */
  setup: SetupRead
}

const fmtPx = (n: number) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4))

function summarize(longEdges: MetEdge[], shortEdges: MetEdge[], longW: number, shortW: number, meta: boolean, tm: TrendMomentum): { leader: MetContext['leader']; dominance: number; summary: string } {
  const dominance = Math.abs(longW - shortW)
  const leader: MetContext['leader'] = longW > shortW + 1 ? 'long' : shortW > longW + 1 ? 'short' : 'balanced'
  const side = leader === 'long' ? '偏多' : leader === 'short' ? '偏空' : '勢均力敵'
  const grade = TREND_GRADE_ZH[tm.grade]
  const summary = `${grade} · 多 ${longEdges.length}(w${longW}) vs 空 ${shortEdges.length}(w${shortW}) — ${side}${meta && leader !== 'balanced' ? ' · M.E.T.A.' : ''}`
  return { leader, dominance, summary }
}

/** The M.E.T. core: enumerate BOTH sides' edges from one snapshot (Ch.6:
 *  「入場前先問自己三條問題 — 我在這個位置有沒有優勢？有多少個？又有多少
 *  不利因素反對我的假設？」). Deterministic; every rule quotes the course. */
export function metVerdict(s: ChartSnapshot): MetContext {
  const tm = trendMomentum(s)
  const shakeout = shakeoutRead(s)
  const setup = setupRead(s)
  const px = s.lastClose
  const longEdges: MetEdge[] = []
  const shortEdges: MetEdge[] = []

  // --- 趨勢 (Ch.7: 「趨勢是你的朋友 — 短中期趨勢都指向下方」第一做空優勢) ---
  if (s.sma20 != null && s.sma50 != null) {
    if (s.sma20 > s.sma50) longEdges.push({ cat: '趨勢', desc: 'SMA20>SMA50 中期趨勢向上', w: 1 })
    else if (s.sma20 < s.sma50) shortEdges.push({ cat: '趨勢', desc: 'SMA20<SMA50 中期趨勢向下', w: 1 })
  }
  if (s.htf) {
    const up = (s.htf.sma20 != null && s.htf.sma50 != null && s.htf.sma20 > s.htf.sma50) || s.htf.changePct > 2
    const dn = (s.htf.sma20 != null && s.htf.sma50 != null && s.htf.sma20 < s.htf.sma50) || s.htf.changePct < -2
    if (up && !dn) longEdges.push({ cat: '趨勢', desc: `高週期同向（${s.htf.label} +${s.htf.changePct.toFixed(1)}%）`, w: 1 })
    else if (dn && !up) shortEdges.push({ cat: '趨勢', desc: `高週期同向（${s.htf.label} ${s.htf.changePct.toFixed(1)}%）`, w: 1 })
  }

  // --- 量能 (Ch.7: 「反彈量少 跌時量增 = 沽壓強」; Ch.8: 「升時量增 回調縮量」) ---
  if (s.upDownVolRatio != null && Number.isFinite(s.upDownVolRatio)) {
    if (s.upDownVolRatio >= 1.2) longEdges.push({ cat: '量能', desc: `上行棒量佔優（${s.upDownVolRatio.toFixed(2)}×）`, w: 1 })
    else if (s.upDownVolRatio <= 0.83) shortEdges.push({ cat: '量能', desc: `下行棒量佔優（${s.upDownVolRatio.toFixed(2)}×）`, w: 1 })
  }
  if (s.volRatio != null && s.volRatio >= 1.3) {
    if (s.changePct > 0) longEdges.push({ cat: '量能', desc: `放量上攻（${s.volRatio.toFixed(1)}× 均量）`, w: 1 })
    else if (s.changePct < 0) shortEdges.push({ cat: '量能', desc: `放量下殺（${s.volRatio.toFixed(1)}× 均量）`, w: 1 })
  }

  // --- 均線 (Ch.7/8: 10/20/50 全向上且在價下 = 支撐；全向下且在價上 = 阻力 —
  //     課堂中唯一一項自己就能承重的優勢，w=2) ---
  if (s.sma20 != null && s.sma50 != null) {
    if (px > s.sma20 && s.sma20 > s.sma50) longEdges.push({ cat: '均線', desc: '均線多頭排列在價下支撐', w: 2 })
    else if (px < s.sma20 && s.sma20 < s.sma50) shortEdges.push({ cat: '均線', desc: '均線空頭排列在價上壓制', w: 2 })
  }

  // --- 關鍵位 (Ch.7: 多次測試的水平位；破支撐轉阻力) ---
  const atr = s.atrPct != null && s.atrPct > 0 ? (px * s.atrPct) / 100 : null
  if (s.srSupport != null && (s.srSupportTouches ?? 0) >= 2 && atr != null && px - s.srSupport <= atr * 1.5) {
    longEdges.push({ cat: '關鍵位', desc: `測試支撐×${s.srSupportTouches} 貼近`, w: 1 })
  }
  if (s.srResistance != null && (s.srResistanceTouches ?? 0) >= 2 && atr != null && s.srResistance - px <= atr * 1.5) {
    shortEdges.push({ cat: '關鍵位', desc: `測試阻力×${s.srResistanceTouches} 貼近`, w: 1 })
  }

  // --- 形態 (Ch.8: 高窄旗形=高位縮波動；Ch.9: 上升楔形/通道頂=看淡；MACD 同向) ---
  if (s.macdHistRising === true && s.rsi14 != null && s.rsi14 >= 40 && s.rsi14 <= 68) {
    longEdges.push({ cat: '形態', desc: 'MACD 柱擴張 + RSI 健康區', w: 1 })
  } else if (s.macdHistRising === false && s.rsi14 != null && s.rsi14 >= 32 && s.rsi14 <= 60) {
    shortEdges.push({ cat: '形態', desc: 'MACD 柱收縮 + RSI 轉弱區', w: 1 })
  }
  if (s.atrPct != null && s.atrPct50 != null && s.rangePosPct != null && s.atrPct <= s.atrPct50 * 0.95) {
    // volatility contraction: near the highs = flag continuation (Ch.8 高窄旗形),
    // after an extended run at the lows = distribution/wedge risk (Ch.9 楔形)
    if (s.rangePosPct >= 65) longEdges.push({ cat: '形態', desc: '高位縮波動（旗形整理）', w: 1 })
    else if (s.rangePosPct <= 35) shortEdges.push({ cat: '形態', desc: '低位縮波動（動能轉弱）', w: 1 })
  }

  // --- 位置 (Ch.8: 回調到匯聚區買入優於追高 — 窗口內有運行空間) ---
  if (s.rangePosPct != null) {
    if (s.rangePosPct <= 45) longEdges.push({ cat: '位置', desc: `窗口位置偏低（${s.rangePosPct.toFixed(0)}%）有空間`, w: 1 })
    else if (s.rangePosPct >= 55) shortEdges.push({ cat: '位置', desc: `窗口位置偏高（${s.rangePosPct.toFixed(0)}%）近阻力`, w: 1 })
  }

  const longW = longEdges.reduce((a, e) => a + e.w, 0)
  const shortW = shortEdges.reduce((a, e) => a + e.w, 0)
  const { leader, dominance } = summarize(longEdges, shortEdges, longW, shortW, false, tm)
  const meta = (leader === 'long' ? longEdges.length : shortEdges.length) >= 3 && dominance >= 2 && leader !== 'balanced'

  // --- v2.12.62 — M.E.T.A. zones per side (Edge 2: 秘訣1-4 zone engine) ---
  const zones = {
    long: srZoneIntegrity(s, 'long'),
    short: srZoneIntegrity(s, 'short'),
  }
  // leader-side shorthand kept for metZoneText/back-compat
  const leaderZone = leader === 'short' ? zones.short : zones.long
  const zone: MetContext['zone'] = leaderZone
    ? { lo: leaderZone.lo, hi: leaderZone.hi, basis: leaderZone.members.join(' + ') || '測試位' }
    : null

  const sum3 = summarize(longEdges, shortEdges, longW, shortW, meta, tm)
  return { longEdges, shortEdges, longW, shortW, leader: sum3.leader, dominance: sum3.dominance, meta, zone, summary: sum3.summary, tm, zones, shakeout, setup }
}

/** zone line for the prompt/log — null when no M.E.T.A. zone */
export function metZoneText(m: MetContext): string | null {
  if (!m.zone) return null
  return `M.E.T.A. 匯聚區 ${fmtPx(m.zone.lo)}–${fmtPx(m.zone.hi)}（${m.zone.basis}）`
}

// ---- v2.12.62 — Edge 1: Momentum & Trend (Ch.10-17 強勢 vs 一般趨勢) --------

export type TrendGrade = 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN'

export const TREND_GRADE_ZH: Record<TrendGrade, string> = {
  STRONG_UP: '強勢升',
  UP: '溫和升',
  NEUTRAL: '無趨勢',
  DOWN: '溫和跌',
  STRONG_DOWN: '強勢跌',
}

export interface TrendMomentum {
  grade: TrendGrade
  /** 0-100 anatomy score of the leading side — ≥60 = 強勢 (Ch.17 checklist
   *  《動能趨勢交易秘訣》), 35-59 = 方向存在但不強勁, below = 一般/無趨勢 */
  score: number
  /** 繁中 checklist hits quoted verbatim in the prompt/log */
  signals: string[]
  /** 「強勢升 78 · 大漲小回 · 升量>跌量 · 高週期同向」 */
  summary: string
}

/** Edge 1 detector — the course's summary table (Ch.17 《動能與趨勢小總結》)
 *  rendered as a deterministic checklist over ChartSnapshot fields:
 *   · 大漲小回/大跌小升 → window change ≥5% + position in range ≥68%/≤32%
 *   · follow-through → MACD histogram expanding with the move
 *   · 量能 → up/down-bar volume ratio ≥1.3 (升量≫跌量) mirrored
 *   · 均線 → price above/below SMA20 with SMA20>SMA50 (多頭排列)
 *   · 波動 → ATR(14) expanding over ATR(50) = 趨勢發動
 *   · 高週期 → the 4×TF context agrees (±2%)
 * A STRONG grade means pullbacks held the 20MA and price rides the short
 * MAs — exactly the stock the course tells you to trade, and never against. */
export function trendMomentum(s: ChartSnapshot): TrendMomentum {
  const px = s.lastClose
  const up: string[] = []
  let upScore = 0
  const dn: string[] = []
  let dnScore = 0
  const bump = (side: 'up' | 'dn', pts: number, text: string) => {
    if (side === 'up') { upScore += pts; up.push(text) } else { dnScore += pts; dn.push(text) }
  }

  // 均線 (Ch.17: 強勢趨勢沿 10/20MA 上行，極少觸及 50MA — 多頭/空頭排列承重)
  if (s.sma20 != null && s.sma50 != null) {
    if (px > s.sma20 && s.sma20 > s.sma50) bump('up', 22, '均線多頭排列')
    else if (px < s.sma20 && s.sma20 < s.sma50) bump('dn', 22, '均線空頭排列')
  }
  // follow-through (Ch.11: 燭身少重疊 · 突破後繼續突破 — MACD 柱同步擴張/收縮)
  if (s.macdHistRising === true) bump('up', 14, 'MACD 柱擴張（跟進走勢）')
  else if (s.macdHistRising === false) bump('dn', 14, 'MACD 柱收縮（跟進走勢）')
  // 量能 (Ch.14: 「成交量是一切動能的燃料」— 升放量跌縮量 = 懸殊失衡)
  if (s.upDownVolRatio != null && Number.isFinite(s.upDownVolRatio)) {
    if (s.upDownVolRatio >= 1.3) bump('up', 14, `升量 ≫ 跌量（${s.upDownVolRatio.toFixed(1)}×）`)
    else if (s.upDownVolRatio <= 0.77) bump('dn', 14, `跌量 ≫ 升量（${(1 / s.upDownVolRatio).toFixed(1)}×）`)
  }
  if (s.volRatio != null && s.volRatio >= 1.3 && s.changePct >= 0.5) bump('up', 8, `放量發動 ${s.volRatio.toFixed(1)}×`)
  else if (s.volRatio != null && s.volRatio >= 1.3 && s.changePct <= -0.5) bump('dn', 8, `放量下殺 ${s.volRatio.toFixed(1)}×`)
  // 大漲小回 (Ch.17: 幅度大 · 需時極短 — 窗口漲跌 ≥5% 且收在高位/低位)
  if (s.changePct >= 5) bump('up', 8, `波段 +${s.changePct.toFixed(1)}%`)
  else if (s.changePct <= -5) bump('dn', 8, `波段 ${s.changePct.toFixed(1)}%`)
  if (s.rangePosPct != null) {
    if (s.rangePosPct >= 68) bump('up', 10, `收在窗口高位 ${s.rangePosPct.toFixed(0)}%`)
    else if (s.rangePosPct <= 32) bump('dn', 10, `收在窗口低位 ${s.rangePosPct.toFixed(0)}%`)
  }
  // 波動擴張 (強勢趨勢發動時 ATR(14) > ATR(50)；一般趨勢不相上下)
  if (s.atrPct != null && s.atrPct50 != null && s.atrPct > s.atrPct50) {
    if (s.changePct > 0) bump('up', 10, '波動擴張（趨勢發動）')
    else if (s.changePct < 0) bump('dn', 10, '波動擴張（趨勢發動）')
  }
  // 高週期同向 (Ch.26-28: higher time frame 支配 lower time frame)
  if (s.htf) {
    if (s.htf.changePct >= 2 || (s.htf.sma20 != null && s.htf.sma50 != null && s.htf.sma20 > s.htf.sma50)) bump('up', 10, `高週期同向（${s.htf.label} ${s.htf.changePct >= 0 ? '+' : ''}${s.htf.changePct.toFixed(1)}%）`)
    else if (s.htf.changePct <= -2 || (s.htf.sma20 != null && s.htf.sma50 != null && s.htf.sma20 < s.htf.sma50)) bump('dn', 10, `高週期同向（${s.htf.label} ${s.htf.changePct.toFixed(1)}%）`)
  }

  const strong = upScore >= dnScore ? up : dn
  const score = Math.max(upScore, dnScore)
  const grade: TrendGrade =
    score >= 60 ? (upScore >= dnScore ? 'STRONG_UP' : 'STRONG_DOWN')
    : score >= 35 ? (upScore >= dnScore ? 'UP' : 'DOWN')
    : 'NEUTRAL'
  const signals = strong.slice(0, 4)
  const zh = TREND_GRADE_ZH[grade]
  const summary = signals.length > 0 ? `${zh} ${score} · ${signals.join(' · ')}` : `${zh}（無趨勢解剖特徵）`
  return { grade, score, signals, summary }
}

// ---- v2.12.62 — Edge 2: Support & Resistance 8 secrets (Ch.18-28) ----------

export interface SrZoneIntegrity {
  side: 'long' | 'short'
  /** the zone (秘訣2: S/R is a ZONE, never a line) — level ± max(0.5 ATR, 0.4%) */
  lo: number
  hi: number
  /** M.E.T.A. members defending this zone (Ch.8: 越多種交易人同守一個位置越可靠) */
  members: string[]
  /** 秘訣2: the stop lives OUTSIDE the zone edge (long: lo−buf · short: hi+buf) */
  stop: number
  /** 秘訣4: tested ≥4 times → 力量衰竭 (a volume breakout through it wins) */
  decayed: boolean
  /** 「匯聚區 172.3–174.8（測試支撐×3+SMA20 在區內）· SL 171.9 區外」 */
  text: string
}

/** Edge 2 zone engine — assembles the M.E.T.A. zone for ONE side from the
 *  tested level + MA confluence + prior-swing flip reference, then derives
 *  the course's zone-external stop. Deterministic; null when the snapshot
 *  has no tested level on that side (never invent one). */
export function srZoneIntegrity(s: ChartSnapshot, side: 'long' | 'short'): SrZoneIntegrity | null {
  const px = s.lastClose
  const lvl = side === 'long' ? s.srSupport : s.srResistance
  const touches = side === 'long' ? s.srSupportTouches : s.srResistanceTouches
  if (lvl == null || !Number.isFinite(lvl) || lvl <= 0 || px <= 0) return null
  const atr = s.atrPct != null && s.atrPct > 0 ? (px * s.atrPct) / 100 : null
  const half = Math.max(atr != null ? atr * 0.5 : 0, lvl * 0.004)
  const lo = lvl - half
  const hi = lvl + half
  const members: string[] = []
  if ((touches ?? 0) >= 2) members.push(`測試${side === 'long' ? '支撐' : '阻力'}×${touches}`)
  if (s.sma20 != null && s.sma20 >= lo && s.sma20 <= hi) members.push('SMA20 在區內')
  if (s.sma50 != null && s.sma50 >= lo && s.sma50 <= hi) members.push('SMA50 在區內')
  // 秘訣3 flip: a prior swing extreme inside the zone = the flipped level's
  // memory (2022-10 S&P500 前浪底支持 → 2020 阻力變支持 examples)
  const prior = side === 'long' ? s.priorLow15 : s.priorHigh15
  if (prior != null && prior >= lo * 0.995 && prior <= hi * 1.005) members.push(side === 'long' ? '前浪底 flip 區' : '前浪頂 flip 區')
  const buf = Math.max(atr != null ? atr * 0.35 : 0, lvl * 0.003)
  const stop = side === 'long' ? lo - buf : hi + buf
  const decayed = (touches ?? 0) >= 4
  const decayTxt = decayed ? ' · 測試過多已衰竭' : ''
  const text = `匯聚區 ${fmtPx(lo)}–${fmtPx(hi)}${members.length ? `（${members.join('+')}）` : ''} · SL ${fmtPx(stop)} 區外${decayTxt}`
  return { side, lo, hi, members, stop, decayed, text }
}

export interface ShakeoutRead {
  /** the side the TRAP favours (洗盤→long · 假突破→short); null = no read */
  side: 'long' | 'short' | null
  text: string
}

/** Edge 2 secret 5 — overshoot / shakeout (洗盤): price pierces the level
 *  fast then reclaims it = trap; the trapped side becomes fuel for the
 *  180° reversal (AMD example). Read from the last-5-bar extreme vs the
 *  tested level and the close's side of it. */
export function shakeoutRead(s: ChartSnapshot): ShakeoutRead {
  if (s.srSupport != null && s.recentLow5 != null && s.recentLow5 < s.srSupport && s.lastClose > s.srSupport) {
    return { side: 'long', text: '洗盤：低點刺穿支撐已收回 — 回測買點，破位交易人成為燃料' }
  }
  if (s.srResistance != null && s.recentHigh5 != null && s.recentHigh5 > s.srResistance && s.lastClose < s.srResistance) {
    return { side: 'short', text: '假突破：高點破阻力已收回 — 回測沽點，追突破者成為燃料' }
  }
  return { side: null, text: '' }
}

export interface SetupRead {
  ready: boolean
  text: string
}

/** Ch.13 《什麼是 Setup》 — constructive 整理: volatility contracting
 *  (ATR14 < ATR50) AND volume drying up (5-bar vol below 20-bar avg).
 *  The course: don't chase the burst; wait for the tight, low-volume
 *  consolidation, THEN take the trigger. */
export function setupRead(s: ChartSnapshot): SetupRead {
  const squeeze = s.atrPct != null && s.atrPct50 != null && s.atrPct < s.atrPct50 * 0.92
  const dryUp = s.volTrendPct != null && s.volTrendPct < 0
  if (squeeze && dryUp) {
    return { ready: true, text: `整理成熟：縮波動 + 量縮 ${s.volTrendPct?.toFixed(0)}% — 等觸發不追` }
  }
  return { ready: false, text: '' }
}

/** Ch.28 MRNA lesson: the gap-down opened 3% below the ideal entry and the
 *  course DID NOT chase — it waited for the intraday pullback to ~211. A
 *  trigger >2% from the planning price is a high-chase plan: flag it. */
export function chaseNote(trigger: number, refPrice: number): string | null {
  if (!Number.isFinite(trigger) || !Number.isFinite(refPrice) || refPrice <= 0 || trigger <= 0) return null
  const dist = Math.abs(trigger - refPrice) / refPrice
  return dist > 0.02 ? `高追 ${(dist * 100).toFixed(1)}%（理想進場 ≤2% 距離）` : null
}

/** Compose the M.E.T. plan annotation persisted on the ledger row and shown
 *  on the plan card: trend grade + the adopted side's zone/stop + trap/setup
 *  reads + the chase flag. ≤160 chars; null when nothing applies. */
export function metPlanNote(m: MetContext, side: 'buy' | 'sell', trigger: number, refPrice: number): string | null {
  const bits: string[] = []
  if (m.tm.grade !== 'NEUTRAL') bits.push(m.tm.summary)
  const z = m.zones[side === 'buy' ? 'long' : 'short']
  if (z) bits.push(z.text)
  if (m.shakeout.side === (side === 'buy' ? 'long' : 'short') && m.shakeout.text) bits.push(m.shakeout.text)
  if (m.setup.ready) bits.push(m.setup.text)
  const chase = chaseNote(trigger, refPrice)
  if (chase) bits.push(chase)
  const joined = bits.join(' · ')
  return joined ? joined.slice(0, 160) : null
}

// ---- R:R tiers (Ch.10-11: 回報風險比優先於勝率) -----------------------------

/** Ch.11: 「我自己會找潛在回報風險比至少 5 比 1 的機會…2 比 1 配 40% 勝率
 *  一樣可以有正期望值」→ deterministic tier, quoted on plan cards + prompt. */
export function rrTier(rr: number | null | undefined): 'A' | 'B' | 'C' | '' {
  if (rr == null || !Number.isFinite(rr) || rr <= 0) return ''
  if (rr >= 5) return 'A'
  if (rr >= 2) return 'B'
  if (rr >= 1.2) return 'C'
  return ''
}

export const RR_TIER_LABEL: Record<'A' | 'B' | 'C', string> = {
  A: 'A 級 ≥5:1 優先',
  B: 'B 級 ≥2:1 可接受',
  C: 'C 級 達標但倉位保守',
}

// ---- Ch.12-14: drawdown recovery math ---------------------------------------

/** 蝕 X% 之後要賺回多少 % 才回本（Ch.13: 蝕 50% 要賺 100% — 非對稱） */
export function recoveryGainPct(lossPct: number): number {
  const l = lossPct / 100
  if (l <= 0 || l >= 1) return l >= 1 ? Infinity : 0
  return ((1 / (1 - l) - 1) * 100)
}

// ---- Ch.16: expectancy / profit-factor audit --------------------------------

export interface ExpectancyInput {
  pnl: number
  pnlPct: number
  /** realized P&L direction of the ENTRY leg */
  side?: string
  /** trade source filter payload ('ai' → the AI system's own sub-sample) */
  source?: string
  symbol?: string
  exitAt?: string
}

export interface ExpectancyStats {
  count: number
  wins: number
  losses: number
  winRate: number // %
  avgWin: number // $ (0 when no winners)
  avgLoss: number // $ magnitude (0 when no losers)
  /** realized payoff ratio avgWin/avgLoss — the trade's actual 回報風險比 */
  payoff: number | null
  /** Ch.16 公式：勝率×均盈 − 敗率×均虧（$/宗） */
  expectancyUsd: number
  expectancyPct: number
  /** gross profit ÷ gross loss — >1 = 系統賺的多過蝕的 */
  profitFactor: number | null
  /** at the realized payoff, the win rate that breaks even (%) */
  breakevenWinRate: number | null
  cumReturnPct: number // compounded equity curve over the sample
  maxDrawdownPct: number // peak-to-trough on the compounded curve
  longestLossStreak: number
}

export function computeExpectancy(trades: ExpectancyInput[]): ExpectancyStats {
  const n = trades.length
  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl < 0)
  const flats = n - wins.length - losses.length
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0))
  const winRate = n > 0 ? ((wins.length / n) * 100) : 0
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0
  const payoff = avgLoss > 0 && avgWin > 0 ? avgWin / avgLoss : null
  const lossRate = n > 0 ? ((losses.length + flats * 0) / n) * 100 : 0
  const expectancyUsd = n > 0 ? (winRate / 100) * avgWin - (lossRate / 100) * avgLoss : 0
  const avgWinPct = wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0
  const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length) : 0
  const expectancyPct = n > 0 ? (winRate / 100) * avgWinPct - (lossRate / 100) * avgLossPct : 0
  const breakevenWinRate = payoff != null ? (1 / (1 + payoff)) * 100 : null
  // compounded equity curve → max drawdown (Ch.12: 控制回撤決定複利結果)
  const sorted = [...trades].sort((a, b) => Date.parse(a.exitAt || '') - Date.parse(b.exitAt || ''))
  let eq = 1
  let peak = 1
  let maxDd = 0
  let streak = 0
  let worstStreak = 0
  for (const t of sorted) {
    eq *= 1 + t.pnlPct / 100
    if (eq > peak) peak = eq
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - eq) / peak) * 100)
    if (t.pnl < 0) { streak += 1; worstStreak = Math.max(worstStreak, streak) } else if (t.pnl > 0) streak = 0
  }
  return {
    count: n,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    payoff,
    expectancyUsd,
    expectancyPct,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    breakevenWinRate,
    cumReturnPct: (eq - 1) * 100,
    maxDrawdownPct: maxDd,
    longestLossStreak: worstStreak,
  }
}

/** Ch.16 verdict copy — honest, mirrors the course's homework rubric */
export function expectancyNote(s: ExpectancyStats): string {
  if (s.count === 0) return '樣本為零 — 先讓系統跑出已平倉交易'
  if (s.count < 30) return `樣本 ${s.count} 宗（<30）— 統計代表性不足，繼續累積`
  const pf = s.profitFactor
  if (s.expectancyPct > 0 && (pf == null || pf > 1)) return `正期望值 ✓ — 每宗平均 ${s.expectancyPct >= 0 ? '+' : ''}${s.expectancyPct.toFixed(2)}%，PF ${pf != null ? pf.toFixed(2) : '∞'}；重複執行讓優勢反映`
  if (pf != null && pf >= 1) return '期望值邊緣 — 接近打和，檢查 R:R 結構與止損邏輯'
  return `負期望值 — 每宗平均 ${s.expectancyPct.toFixed(2)}%（PF ${pf?.toFixed(2) ?? '—'}）：提升回報風險比（A 級 ≥5:1）比追求勝率更實際`
}
