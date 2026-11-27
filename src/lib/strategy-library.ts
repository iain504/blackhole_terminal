// v2.12.57 — 戰略庫 (STRATEGY LIBRARY) — deterministic pre-screening engine.
//
// WHY THIS EXISTS: the planner used to invent trades from raw indicator text —
// the model both found the setup AND derived the geometry, and it was bad at
// both ("never win"). The fix is division of labor:
//
//   TERMINAL (this file, pure math): runs every ENABLED strategy over each
//     symbol's snapshot and emits at most one buy + one sell CANDIDATE with
//     geometry derived from STRUCTURE (recent swings, window high/low, tested
//     S/R, ATR buffers) — never invented. Each candidate carries a
//     deterministic 0-100 edge score + the named evidence classes that
//     produced it. Candidates that cannot produce structure-true geometry
//     (trigger outside the confirmation band, TP with no structural space)
//     die HERE — no fantasy targets.
//
//   MODEL (the prompt): receives the candidates and ADJUDICATES — which side
//     has the larger edge, whether the environment deserves the trade at all,
//     and whether the geometry needs tightening. It cannot invent levels that
//     contradict the structure it was handed, and the terminal still re-checks
//     every number (validatePlanSide + R:R gate) — with the TP-repair crutch
//     removed, an unfixable plan is REJECTED, not inflated.
//
// All math is pure + client-safe (no fetch, no env). The Settings → AI 自動交易
// → 戰略庫 UI renders STRATEGY_LIBRARY directly and persists per-strategy
// enable/params through AiAutoConfig.strategies.

import type { ChartSnapshot } from '@/lib/ai-trade'
import { PLAN_BAND } from '@/lib/ai-trade-gates'
// v2.12.61 — M.E.T. 多重優勢對比 (J Law's Multiple Edge Trading System):
// every symbol gets a both-side edge enumeration (Ch.6-9) and the comparison
// adjusts the candidates' deterministic edge — a setup aligned with the
// symbol-level edge majority is worth more than one fighting it.
import { metVerdict, metZoneText, chaseNote, type MetContext, type TrendGrade } from '@/lib/met-engine'

export interface StrategyParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

export interface StrategyCandidate {
  strategyId: string
  strategyName: string
  side: 'buy' | 'sell'
  /** confirmation level — market must move THROUGH it before a follow */
  trigger: number
  /** structural stop (beyond the referenced level, ATR-buffered) */
  sl: number
  /** structural target (at/before the referenced S/R — never past it) */
  tp: number
  /** terminal-computed R:R at plan time */
  rr: number
  /** deterministic 0-100 edge from the aligned evidence classes */
  edge: number
  /** 繁中 evidence class names that aligned */
  evidence: string[]
  /** ≤30 char 繁中 rationale */
  note: string
  /** v2.12.62 — the snapshot's last close when screened (the no-chase %
   *  anchor from the MRNA lesson — 觸發距現價 >2% = 高追）. Set by screenSymbol
   *  for every surviving candidate. */
  refPrice?: number
  /** v2.12.61 — the symbol-level M.E.T. both-side edge comparison this
   *  candidate rides on (identical for all candidates of one snapshot) */
  met?: MetContext
}

export interface StrategyTuning {
  enabled: boolean
  params: Record<string, number>
}

export interface StrategyDef {
  id: string
  name: string
  /** one-line rule — shown in the UI and quoted in the prompt */
  desc: string
  params: StrategyParam[]
  detect: (s: ChartSnapshot, p: Record<string, number>) => StrategyCandidate | StrategyCandidate[] | null
}

// ---- shared math ------------------------------------------------------------

const num = (v: unknown, d: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clampN = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const px = (s: ChartSnapshot) => s.lastClose
const fmtPx = (n: number) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4))

/** absolute ATR proxy (ATR% of price × price) — null when the snapshot lacks it */
function atrAbs(s: ChartSnapshot): number | null {
  if (s.atrPct == null || !Number.isFinite(s.atrPct) || s.atrPct <= 0) return null
  return (px(s) * s.atrPct) / 100
}

/** Confirmation-band clamps matching validatePlanSide (0.05% hard floor is the
 *  validator's; we plan at 0.12%+ so a live re-check never grazes the floor).
 *  Returns null when the structural level sits OUTSIDE the band — the setup
 *  is too far from reality to plan honestly, so there is no candidate. */
function buyTriggerFrom(level: number, ref: number): number | null {
  const hi = ref * (1 + PLAN_BAND.up * 0.8) // 4% — inside the 5% validator band
  if (!(level > ref)) return null
  if (level > hi) return null
  return Math.max(level, ref * 1.0012)
}
function sellTriggerFrom(level: number, ref: number): number | null {
  const lo = ref * (1 - PLAN_BAND.down * 0.8)
  if (!(level < ref)) return null
  if (level < lo) return null
  return Math.min(level, ref * 0.9988)
}

function rrOf(side: 'buy' | 'sell', trigger: number, tp: number, sl: number): number {
  const r = side === 'buy' ? (tp - trigger) / (trigger - sl) : (trigger - tp) / (sl - trigger)
  return Number.isFinite(r) && r > 0 ? r : 0
}

/** Assemble one candidate; refuses geometry that validatePlanSide would kill. */
function cand(
  s: ChartSnapshot,
  strategyId: string,
  strategyName: string,
  side: 'buy' | 'sell',
  trigger: number | null,
  sl: number,
  tp: number,
  evidence: Evidence[],
  note: string,
): StrategyCandidate | null {
  const ref = px(s)
  if (trigger == null || !Number.isFinite(trigger) || !Number.isFinite(sl) || !Number.isFinite(tp)) return null
  if (sl <= 0 || tp <= 0) return null
  if (side === 'buy' ? !(sl < trigger && trigger < tp) : !(tp < trigger && trigger < sl)) return null
  const rr = rrOf(side, trigger, tp, sl)
  // degeneracy floor ONLY — the terminal's real min-R:R gate runs later (and
  // the prompt tells the model it may tighten the trigger inside the band to
  // clear it). Filtering at the terminal floor here would silently delete
  // exactly the pullback setups where the swing high sits near a clustered
  // wall — the model never gets to adjudicate them at all.
  if (rr < 0.2) return null
  const edge = edgeScore(evidence)
  return { strategyId, strategyName, side, trigger, sl, tp, rr, edge, evidence, note }
}

// ---- evidence classes (deterministic edge scoring) ---------------------------

type Evidence = '趨勢' | '高週期' | '動量' | '量能' | '結構' | '位置'
const EDGE_BASE = 30
const EDGE_W: Record<Evidence, number> = { 趨勢: 14, 高週期: 14, 動量: 12, 量能: 12, 結構: 12, 位置: 8 }

function edgeScore(evs: Evidence[]): number {
  const raw = EDGE_BASE + evs.reduce((a, e) => a + EDGE_W[e], 0)
  return Math.round(clampN(raw, 20, 95))
}

/** daily-frame trend: SMA20 vs SMA50 order matches the side */
function trendAligned(s: ChartSnapshot, side: 'buy' | 'sell'): boolean {
  if (s.sma20 == null || s.sma50 == null) return false
  return side === 'buy' ? s.sma20 > s.sma50 : s.sma20 < s.sma50
}
/** higher-TF context agrees (not opposing) */
function htfAligned(s: ChartSnapshot, side: 'buy' | 'sell'): boolean {
  const h = s.htf
  if (!h) return false
  const flip = h.sma20 != null && h.sma50 != null && (side === 'buy' ? h.sma20 < h.sma50 : h.sma20 > h.sma50)
  const wind = side === 'buy' ? h.changePct < -2 : h.changePct > 2
  return !flip && !wind
}
/** volume supports the side (expansion, or up/down-bar balance) */
function volumeSide(s: ChartSnapshot, side: 'buy' | 'sell'): boolean {
  if (s.volRatio != null && s.volRatio >= 1.3) return true
  const r = s.upDownVolRatio
  if (r == null || !Number.isFinite(r)) return false
  return side === 'buy' ? r >= 1.2 : r <= 0.83
}
/** price sits in the favorable half of the window range */
function positionSide(s: ChartSnapshot, side: 'buy' | 'sell'): boolean {
  if (s.rangePosPct == null) return false
  return side === 'buy' ? s.rangePosPct <= 55 : s.rangePosPct >= 45
}

// ---- the 7 built-in playbooks ------------------------------------------------

/**
 * 1. 趨勢回調 (Trend Pullback) — daily trend intact (SMA20>SMA50 for longs),
 *    price pulled back onto SMA20, RSI mid-zone (not oversold-chasing):
 *    buy the RECLAIM above the pullback swing high. SL below the pullback
 *    low, TP at the tested resistance.
 */
const trendPullback: StrategyDef = {
  id: 'trend-pullback',
  name: '趨勢回調',
  desc: '順勢趨勢中價格回踩 SMA20 後回升 — 突破回調高點確認進場，SL 藏回調低點下、TP 到測試阻力前',
  params: [
    { key: 'maxPullbackPct', label: '回調深度上限（距 SMA20 %）', min: 1, max: 8, step: 0.5, default: 3 },
    { key: 'stopBufAtr', label: 'SL 緩衝（×ATR）', min: 0.2, max: 2, step: 0.1, default: 0.4 },
  ],
  detect(s, p) {
    const ref = px(s)
    const atr = atrAbs(s)
    if (atr == null || s.sma20 == null) return null
    const out: StrategyCandidate[] = []
    const distPct = Math.abs(((ref - s.sma20) / s.sma20) * 100)
    if (distPct > p.maxPullbackPct) return null
    const rsi = s.rsi14
    for (const side of ['buy', 'sell'] as const) {
      if (!trendAligned(s, side)) continue
      const rsiOk = side === 'buy' ? rsi != null && rsi >= 35 && rsi <= 62 : rsi != null && rsi >= 38 && rsi <= 65
      if (!rsiOk) continue
      const swing = side === 'buy' ? s.recentHigh5 : s.recentLow5
      const stopBase = side === 'buy' ? s.recentLow5 : s.recentHigh5
      const tpStruct = side === 'buy' ? s.srResistance : s.srSupport
      if (swing == null || stopBase == null) continue
      const trigger = side === 'buy' ? buyTriggerFrom(swing * 1.001, ref) : sellTriggerFrom(swing * 0.999, ref)
      const buf = atr * p.stopBufAtr
      const sl = side === 'buy' ? stopBase - buf : stopBase + buf
      const tp = tpStruct ?? (side === 'buy' ? ref + atr * 2.5 : ref - atr * 2.5)
      const evs: Evidence[] = ['趨勢']
      if (htfAligned(s, side)) evs.push('高週期')
      if (side === 'buy' ? (s.macdHistRising === true) : (s.macdHistRising === false)) evs.push('動量')
      if (volumeSide(s, side)) evs.push('量能')
      evs.push('位置')
      const c = cand(s, this.id, this.name, side, trigger, sl, tp, evs,
        side === 'buy' ? '站穩SMA20回升 突破回調高點' : '反彈受制SMA20 跌破回調低點')
      if (c) out.push(c)
    }
    return out.length > 0 ? out : null
  },
}

/**
 * 2. 區間突破 (Range Breakout) — volatility contraction (ATR14 ≤ ATR50×ratio)
 *    with price pinned at the window edge: buy the break of the window high.
 *    SL back inside the range (mid-line), TP = measured move (range height).
 */
const rangeBreakout: StrategyDef = {
  id: 'range-breakout',
  name: '區間突破',
  desc: '波動緊縮後價格貼近區間邊緣 — 突破窗口高/低點確認，SL 退回區間中線、TP 按箱體高度投射',
  params: [
    { key: 'maxAtrRatio', label: 'ATR14/ATR50 上限', min: 0.7, max: 1.3, step: 0.05, default: 0.95 },
    { key: 'measuredPct', label: 'TP 投射（箱體高度 %）', min: 40, max: 120, step: 5, default: 75 },
  ],
  detect(s, p) {
    const ref = px(s)
    if (s.atrPct == null || s.atrPct50 == null || s.rangePosPct == null) return null
    if (!(s.atrPct <= s.atrPct50 * p.maxAtrRatio)) return null
    if (!s.high || !s.low || s.high <= s.low) return null
    const rangeH = s.high - s.low
    const mid = (s.high + s.low) / 2
    const out: StrategyCandidate[] = []
    for (const side of ['buy', 'sell'] as const) {
      const edgePos = side === 'buy' ? s.rangePosPct >= 80 : s.rangePosPct <= 20
      if (!edgePos) continue
      const level = side === 'buy' ? s.high : s.low
      const trigger = side === 'buy' ? buyTriggerFrom(level * 1.0005, ref) : sellTriggerFrom(level * 0.9995, ref)
      if (trigger == null) continue // the breakout level sits outside the confirmation band — no honest entry
      const sl = side === 'buy' ? mid - atrAbsSafe(s, 0.2) : mid + atrAbsSafe(s, 0.2)
      const tp = side === 'buy' ? trigger + rangeH * (p.measuredPct / 100) : trigger - rangeH * (p.measuredPct / 100)
      const evs: Evidence[] = []
      if (trendAligned(s, side)) evs.push('趨勢')
      if (htfAligned(s, side)) evs.push('高週期')
      if (side === 'buy' ? (s.macdHistRising === true) : (s.macdHistRising === false)) evs.push('動量')
      if (volumeSide(s, side)) evs.push('量能')
      evs.push('位置')
      const c = cand(s, this.id, this.name, side, trigger, sl, tp, evs,
        side === 'buy' ? '緊縮後貼上緣 突破量度移動' : '緊縮後貼下緣 跌破量度移動')
      if (c) out.push(c)
    }
    return out.length > 0 ? out : null
  },
}

/** local helper — ATR buffer with null fallback */
function atrAbsSafe(s: ChartSnapshot, mult: number): number {
  const atr = atrAbs(s)
  return atr != null ? atr * mult : px(s) * 0.005
}

/**
 * 3. 均值回歸 (Mean Reversion) — NON-trending tape (SMA20≈SMA50), RSI at the
 *    configured extreme and price pinned at the window edge: fade back to
 *    SMA20. SL beyond the window extreme, TP = the mean itself.
 */
const meanReversion: StrategyDef = {
  id: 'mean-reversion',
  name: '均值回歸',
  desc: '無趨勢盤整中 RSI 極端 + 價格貼窗口邊緣 — 反向 Fade 回 SMA20，SL 藏窗口極值外、TP 就是均線',
  params: [
    { key: 'maxTrendSpreadPct', label: 'SMA20/50 離散上限（%）', min: 0.3, max: 3, step: 0.1, default: 1.2 },
    { key: 'rsiExtreme', label: 'RSI 極值', min: 15, max: 40, step: 1, default: 30 },
  ],
  detect(s, p) {
    const ref = px(s)
    if (s.sma20 == null || s.sma50 == null || s.rsi14 == null || s.rangePosPct == null) return null
    const spread = (Math.abs(s.sma20 - s.sma50) / s.sma50) * 100
    if (spread > p.maxTrendSpreadPct) return null
    const out: StrategyCandidate[] = []
    for (const side of ['buy', 'sell'] as const) {
      const extreme = side === 'buy' ? s.rsi14 <= p.rsiExtreme && s.rangePosPct <= 12 : s.rsi14 >= 100 - p.rsiExtreme && s.rangePosPct >= 88
      if (!extreme) continue
      const trigger = side === 'buy' ? buyTriggerFrom(ref * 1.0015, ref) : sellTriggerFrom(ref * 0.9985, ref)
      const buf = atrAbsSafe(s, 0.3)
      const sl = side === 'buy' ? (s.low ?? ref * 0.97) - buf : (s.high ?? ref * 1.03) + buf
      const tp = s.sma20
      const evs: Evidence[] = ['動量']
      if (trendAligned(s, side)) evs.push('趨勢')
      if (htfAligned(s, side)) evs.push('高週期')
      if (volumeSide(s, side)) evs.push('量能')
      evs.push('位置')
      const c = cand(s, this.id, this.name, side, trigger, sl, tp, evs,
        side === 'buy' ? '超賣貼下緣 回歸均線' : '超買貼上緣 回歸均線')
      if (c) out.push(c)
    }
    return out.length > 0 ? out : null
  },
}

/**
 * 4. 動能延續 (Momentum Ignition) — volume expansion + close pinned at the
 *    window edge + MACD histogram expanding in the side's direction: buy the
 *    break of the recent 5-bar high. SL below the 5-bar low, TP at the tested
 *    S/R (or an ATR extension when no wall is mapped).
 */
const momentumIgnition: StrategyDef = {
  id: 'momentum-ignition',
  name: '動能延續',
  desc: '爆量 + 收盤貼窗口邊緣 + MACD 柱同向擴張 — 突破近 5 根高/低點延續，SL 藏 5 根極值外、TP 到測試 S/R',
  params: [
    { key: 'volMult', label: '量比下限（×20均量）', min: 1.2, max: 3, step: 0.1, default: 1.6 },
    { key: 'stopBufAtr', label: 'SL 緩衝（×ATR）', min: 0.2, max: 2, step: 0.1, default: 0.5 },
  ],
  detect(s, p) {
    const ref = px(s)
    if (s.volRatio == null || s.volRatio < p.volMult || s.rangePosPct == null) return null
    const out: StrategyCandidate[] = []
    for (const side of ['buy', 'sell'] as const) {
      const pinned = side === 'buy' ? s.rangePosPct >= 75 : s.rangePosPct <= 25
      const histDir = side === 'buy' ? s.macdHistRising === true : s.macdHistRising === false
      if (!pinned || !histDir) continue
      if (!htfAligned(s, side)) continue
      const swing = side === 'buy' ? s.recentHigh5 : s.recentLow5
      const stopBase = side === 'buy' ? s.recentLow5 : s.recentHigh5
      if (swing == null || stopBase == null) continue
      const trigger = side === 'buy' ? buyTriggerFrom(swing * 1.001, ref) : sellTriggerFrom(swing * 0.999, ref)
      const buf = atrAbsSafe(s, p.stopBufAtr)
      const sl = side === 'buy' ? stopBase - buf : stopBase + buf
      const tpStruct = side === 'buy' ? s.srResistance : s.srSupport
      const tp = tpStruct ?? (side === 'buy' ? ref + atrAbsSafe(s, 2.5) : ref - atrAbsSafe(s, 2.5))
      const evs: Evidence[] = ['量能', '動量']
      if (trendAligned(s, side)) evs.push('趨勢')
      if (positionSide(s, side)) evs.push('位置')
      const c = cand(s, this.id, this.name, side, trigger, sl, tp, evs,
        side === 'buy' ? '爆量上攻收高 突破延續' : '爆量下殺收低 跌破延續')
      if (c) out.push(c)
    }
    return out.length > 0 ? out : null
  },
}

/**
 * 5. 關鍵位反彈 (S/R Bounce) — price within a fraction of an ATR of a TESTED
 *    support (touches ≥ min) with momentum turning: buy the reclaim. SL just
 *    beyond the level, TP at the opposite tested wall.
 */
const srBounce: StrategyDef = {
  id: 'sr-bounce',
  name: '關鍵位反彈',
  desc: '價格貼近多次測試的支撐/阻力且動能反轉 — 確認反彈/回落進場，SL 藏關鍵位外側、TP 到對面牆前',
  params: [
    { key: 'minTouches', label: '最少觸及次數', min: 2, max: 4, step: 1, default: 2 },
    { key: 'maxDistAtr', label: '最大距離（×ATR%）', min: 0.5, max: 2, step: 0.1, default: 1 },
  ],
  detect(s, p) {
    const ref = px(s)
    if (s.atrPct == null || s.rsi14 == null) return null
    const out: StrategyCandidate[] = []
    for (const side of ['buy', 'sell'] as const) {
      const level = side === 'buy' ? s.srSupport : s.srResistance
      const touches = side === 'buy' ? s.srSupportTouches : s.srResistanceTouches
      const dist = side === 'buy' ? s.srSupportPct : s.srResistancePct
      if (level == null || touches == null || dist == null) continue
      if (touches < p.minTouches) continue
      if (dist > s.atrPct * p.maxDistAtr) continue
      const rsiOk = side === 'buy' ? s.rsi14 <= 48 : s.rsi14 >= 52
      if (!rsiOk) continue
      const trigger = side === 'buy' ? buyTriggerFrom(ref * 1.002, ref) : sellTriggerFrom(ref * 0.998, ref)
      const buf = atrAbsSafe(s, 0.4)
      const sl = side === 'buy' ? level - buf : level + buf
      const tpStruct = side === 'buy' ? s.srResistance : s.srSupport
      const tp = tpStruct ?? (side === 'buy' ? ref + (ref - level) * 1.6 : ref - (level - ref) * 1.6)
      const evs: Evidence[] = ['結構']
      if (trendAligned(s, side)) evs.push('趨勢')
      if (htfAligned(s, side)) evs.push('高週期')
      if (side === 'buy' ? (s.macdHistRising === true) : (s.macdHistRising === false)) evs.push('動量')
      if (volumeSide(s, side)) evs.push('量能')
      const c = cand(s, this.id, this.name, side, trigger, sl, tp, evs,
        side === 'buy' ? `支撐${touches}次測試貼近 反彈確認` : `阻力${touches}次測試貼近 回落確認`)
      if (c) out.push(c)
    }
    return out.length > 0 ? out : null
  },
}

/**
 * 6. 流動性掃蕩 (Liquidity Sweep Reversal) — a bar swept the PRIOR range's
 *    extreme on volume, then CLOSED back inside (stop-run reclaim): buy the
 *    break of the sweep bar's high. SL beyond the sweep wick, TP at the
 *    opposite side of the range.
 */
const liquiditySweep: StrategyDef = {
  id: 'liquidity-sweep',
  name: '流動性掃蕩',
  desc: '爆量掃破前段極值後收回（假突破/止損獵殺）— 突破掃蕩棒高低點反轉，SL 藏掃蕩極值外、TP 到區間對側',
  params: [
    { key: 'volMult', label: '量比下限（×20均量）', min: 1.1, max: 3, step: 0.1, default: 1.3 },
    { key: 'stopBufAtr', label: 'SL 緩衝（×ATR）', min: 0.2, max: 2, step: 0.1, default: 0.4 },
  ],
  detect(s, p) {
    const ref = px(s)
    if (s.volRatio == null || s.volRatio < p.volMult) return null
    if (s.recentHigh5 == null || s.recentLow5 == null || s.priorHigh15 == null || s.priorLow15 == null) return null
    const out: StrategyCandidate[] = []
    for (const side of ['buy', 'sell'] as const) {
      // swept the prior extreme, then reclaimed back inside it
      const swept = side === 'buy' ? s.recentLow5 < s.priorLow15 && ref > s.priorLow15 : s.recentHigh5 > s.priorHigh15 && ref < s.priorHigh15
      if (!swept) continue
      const swing = side === 'buy' ? s.recentHigh5 : s.recentLow5
      const stopBase = side === 'buy' ? s.recentLow5 : s.recentHigh5
      const trigger = side === 'buy' ? buyTriggerFrom(swing * 1.001, ref) : sellTriggerFrom(swing * 0.999, ref)
      const buf = atrAbsSafe(s, p.stopBufAtr)
      const sl = side === 'buy' ? stopBase - buf : stopBase + buf
      const tpStruct = side === 'buy' ? s.srResistance : s.srSupport
      const tp = tpStruct ?? (side === 'buy' ? s.priorHigh15 * 0.995 : s.priorLow15 * 1.005)
      const evs: Evidence[] = ['量能', '結構']
      if (trendAligned(s, side)) evs.push('趨勢')
      if (htfAligned(s, side)) evs.push('高週期')
      if (positionSide(s, side)) evs.push('位置')
      const c = cand(s, this.id, this.name, side, trigger, sl, tp, evs,
        side === 'buy' ? '掃蕩下緣後收回 假跌破反轉' : '掃蕩上緣後收回 假突破反轉')
      if (c) out.push(c)
    }
    return out.length > 0 ? out : null
  },
}

/**
 * 7. 箱體雙向 (Regime Range, both sides) — a TESTED double-walled range
 *    (support AND resistance, both ≥2 touches, sane height) with price
 *    inside: emits a BUY candidate near support AND a SELL candidate near
 *    resistance. This is the strategy that legitimately produces two-sided
 *    plans — a regime-defined range where the market picks the direction.
 */
const rangeFade: StrategyDef = {
  id: 'range-fade',
  name: '箱體雙向',
  desc: '雙牆測試箱體（支撐+阻力各 ≥2 次觸及、高度合理）— 支撐側買、阻力側賣；與對側 edge 相當時可雙向計劃',
  params: [
    { key: 'minRangePct', label: '箱體最小高度（%）', min: 1.5, max: 8, step: 0.5, default: 3 },
    { key: 'maxRangePct', label: '箱體最大高度（%）', min: 8, max: 25, step: 1, default: 18 },
  ],
  detect(s, p) {
    const ref = px(s)
    if (s.srSupport == null || s.srResistance == null || s.rangePosPct == null) return null
    if ((s.srSupportTouches ?? 0) < 2 || (s.srResistanceTouches ?? 0) < 2) return null
    const rangePct = ((s.srResistance - s.srSupport) / ref) * 100
    if (rangePct < p.minRangePct || rangePct > p.maxRangePct) return null
    const inRange = s.rangePosPct >= 12 && s.rangePosPct <= 88
    if (!inRange) return null
    const out: StrategyCandidate[] = []
    // BUY off support when price sits in the lower half
    if (s.rangePosPct <= 50) {
      const trigger = buyTriggerFrom(ref * 1.0015, ref)
      const buf = atrAbsSafe(s, 0.4)
      const sl = s.srSupport - buf
      const tp = s.srResistance * 0.998
      const evs: Evidence[] = ['結構', '位置']
      if (trendAligned(s, 'buy')) evs.push('趨勢')
      if (htfAligned(s, 'buy')) evs.push('高週期')
      if (s.rsi14 != null && s.rsi14 <= 45) evs.push('動量')
      if (volumeSide(s, 'buy')) evs.push('量能')
      const c = cand(s, this.id, this.name, 'buy', trigger, sl, tp, evs,
        `箱體下沿支撐(${s.srSupportTouches}測試) 買向目標上牆`)
      if (c) out.push(c)
    }
    // SELL off resistance when price sits in the upper half
    if (s.rangePosPct >= 50) {
      const trigger = sellTriggerFrom(ref * 0.9985, ref)
      const buf = atrAbsSafe(s, 0.4)
      const sl = s.srResistance + buf
      const tp = s.srSupport * 1.002
      const evs: Evidence[] = ['結構', '位置']
      if (trendAligned(s, 'sell')) evs.push('趨勢')
      if (htfAligned(s, 'sell')) evs.push('高週期')
      if (s.rsi14 != null && s.rsi14 >= 55) evs.push('動量')
      if (volumeSide(s, 'sell')) evs.push('量能')
      const c = cand(s, this.id, this.name, 'sell', trigger, sl, tp, evs,
        `箱體上沿阻力(${s.srResistanceTouches}測試) 賣向目標下牆`)
      if (c) out.push(c)
    }
    return out.length > 0 ? out : null
  },
}

/** The built-in playbook, in prompt/UI order. */
export const STRATEGY_LIBRARY: StrategyDef[] = [
  trendPullback,
  rangeBreakout,
  meanReversion,
  momentumIgnition,
  srBounce,
  liquiditySweep,
  rangeFade,
]

export const STRATEGY_BY_ID = new Map(STRATEGY_LIBRARY.map((d) => [d.id, d]))

// ---- config plumbing ---------------------------------------------------------

export function defaultStrategyConfig(): Record<string, StrategyTuning> {
  const out: Record<string, StrategyTuning> = {}
  for (const d of STRATEGY_LIBRARY) {
    out[d.id] = { enabled: true, params: Object.fromEntries(d.params.map((p) => [p.key, p.default])) }
  }
  return out
}

/** Sanitize untrusted strategy config: unknown ids dropped, missing entries
 *  default to ENABLED with stock params (an upgrade must never silently
 *  disable a playbook), params clamped to their declared ranges. */
export function sanitizeStrategyConfig(raw: unknown): Record<string, StrategyTuning> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, StrategyTuning> = {}
  for (const d of STRATEGY_LIBRARY) {
    const t = src[d.id]
    const enabled = t && typeof t === 'object' ? (t as StrategyTuning).enabled !== false : true
    const params: Record<string, number> = {}
    for (const p of d.params) {
      const rawP = t && typeof t === 'object' ? (t as StrategyTuning).params?.[p.key] : undefined
      params[p.key] = clampN(num(rawP, p.default), p.min, p.max)
    }
    out[d.id] = { enabled, params }
  }
  return out
}

/** Merge one strategy's partial param edit over its current tuning (clamped). */
export function mergeStrategyParams(
  cur: Record<string, StrategyTuning>,
  id: string,
  patch: Partial<StrategyTuning>,
): Record<string, StrategyTuning> {
  const d = STRATEGY_BY_ID.get(id)
  const base = cur[id] ?? { enabled: true, params: Object.fromEntries((d?.params ?? []).map((p) => [p.key, p.default])) }
  const merged: Record<string, StrategyTuning> = { ...cur }
  merged[id] = {
    enabled: patch.enabled ?? base.enabled,
    params: { ...base.params, ...(patch.params ?? {}) },
  }
  return merged
}

// ---- the screener --------------------------------------------------------------

/**
 * Run every ENABLED playbook over one snapshot. Emits at most ONE buy + ONE
 * sell candidate (the strongest by edge) — the prompt stays bounded and the
 * adjudication question stays sharp: which side has the larger edge?
 */
export function screenSymbol(s: ChartSnapshot, cfg: Record<string, StrategyTuning>): StrategyCandidate[] {
  const all: StrategyCandidate[] = []
  for (const d of STRATEGY_LIBRARY) {
    const t = cfg[d.id]
    if (!t || t.enabled === false) continue
    const params: Record<string, number> = {}
    for (const p of d.params) params[p.key] = clampN(num(t.params?.[p.key], p.default), p.min, p.max)
    try {
      const res = d.detect(s, params)
      if (Array.isArray(res)) all.push(...res)
      else if (res) all.push(res)
    } catch {
      // a broken detector must never kill the scan — skip it
    }
  }
  // v2.12.61 — M.E.T. OVERLAY (Ch.9: 「比較做多和做空優勢…判斷現在這個價位
  // 買家還是賣家較強」): the evidence-class edge measures the SETUP; the
  // both-side comparison measures the SYMBOL. A setup that fights the
  // symbol-level edge majority is downgraded (−3 per dominance point, cap
  // 15) — Ch.7's 200MA-support example that lost to five short edges — and
  // one aligned with it is upgraded. Clamped to the same 20-95 band.
  for (const c of all) c.refPrice = s.lastClose
  let met: MetContext | null = null
  try {
    met = metVerdict(s)
  } catch {
    met = null // M.E.T. must never kill the screener
  }
  if (met) {
    const delta = met.leader === 'balanced' ? 0 : Math.min(15, met.dominance * 3)
    for (const c of all) {
      const aligned = met.leader === 'long' ? c.side === 'buy' : met.leader === 'short' ? c.side === 'sell' : false
      c.edge = clampN(c.edge + (met.leader === 'balanced' ? 0 : aligned ? delta : -delta), 20, 95)
      c.met = met
    }
    // v2.12.62 — Edge 1 (Ch.10-17): 趨勢是第一重優勢。A STRONG trend grade is
    // the course's own first filter — 「當你懂得判斷趨勢…你就會獲得第一重
    // 重要的優勢」— so strong-trend-ALIGNED candidates gain +4 and candidates
    // fighting a strong trend lose −6 (強勢升只做多側、強勢跌只做空側).
    // UP/DOWN grades adjust nothing (the evidence classes already scored them).
    const g: TrendGrade = met.tm.grade
    if (g === 'STRONG_UP' || g === 'STRONG_DOWN') {
      const strongSide: 'buy' | 'sell' = g === 'STRONG_UP' ? 'buy' : 'sell'
      for (const c of all) {
        c.edge = clampN(c.edge + (c.side === strongSide ? 4 : -6), 20, 95)
      }
    }
    // v2.12.63 — EP4 thrust→reaction texture (Ch.10 APP 5-edge example):
    // a high-volume thrust + low-volume pullback/bounce is a real entry
    // advantage for the read's side — aligned candidates +2, the counter
    // side −2 (bouncing into resistance ON LOW VOLUME is the CAR 沽點).
    if (met.pullback.side != null) {
      const pbSide: 'buy' | 'sell' = met.pullback.side === 'long' ? 'buy' : 'sell'
      for (const c of all) {
        c.edge = clampN(c.edge + (c.side === pbSide ? 2 : -2), 20, 95)
      }
    }
  }
  const best = (side: 'buy' | 'sell') =>
    all.filter((c) => c.side === side).sort((a, b) => b.edge - a.edge)[0] ?? null
  const out: StrategyCandidate[] = []
  const b = best('buy')
  const sl = best('sell')
  if (b) out.push(b)
  if (sl) out.push(sl)
  return out
}

/** The per-symbol 戰略候選 block injected into the planner prompt. */
export function strategyBlockText(cands: StrategyCandidate[]): string {
  if (cands.length === 0) {
    return '[戰略候選] 無合格策略候選 — 依紀律觀望（無設置即空倉）'
  }
  const lines = cands.map((c) => {
    const trig = `觸發 ${fmtPx(c.trigger)} · SL ${fmtPx(c.sl)} · TP ${fmtPx(c.tp)}`
    const met = c.met
    const metBits = met
      ? ` | M.E.T. ${met.summary}${metZoneText(met) ? ` · ${metZoneText(met)}` : ''}${met.zones[c.side === 'buy' ? 'long' : 'short']?.text ? ` · ${met.zones[c.side === 'buy' ? 'long' : 'short']!.text}` : ''}${met.layers[c.side === 'buy' ? 'long' : 'short']?.text ? ` · ${met.layers[c.side === 'buy' ? 'long' : 'short']!.text}` : ''}${met.exit[c.side === 'buy' ? 'long' : 'short'].text ? ` · ${met.exit[c.side === 'buy' ? 'long' : 'short'].text}` : ''}${met.shakeout.side === (c.side === 'buy' ? 'long' : 'short') && met.shakeout.text ? ` · ${met.shakeout.text}` : ''}${met.pullback.side === (c.side === 'buy' ? 'long' : 'short') && met.pullback.text ? ` · ${met.pullback.text}` : ''}${met.setup.ready ? ` · ${met.setup.text}` : ''}${c.refPrice ? ` · ${chaseNote(c.trigger, c.refPrice)}` : ''}`
      : ''
    return `${c.side === 'buy' ? '▲' : '▼'} ${c.strategyName}(${c.strategyId}) | ${trig} | R:R 1:${c.rr.toFixed(2)} | edge ${c.edge} | 證據: ${c.evidence.join('+')}${metBits} | ${c.note}`
  })
  const met = cands.find((c) => c.met)?.met
  const head = ['[戰略候選 · 終端預篩 — 幾何由結構推導，可採用或微調，不可杜撰]']
  if (met) {
    head.push(
      `[M.E.T. 優勢對比] ${met.summary}${met.zone ? ` · ${metZoneText(met)}` : ''} — 兩側證據逐類對比後，優勢偏向 ${met.leader === 'long' ? '買方' : met.leader === 'short' ? '賣方' : '不明（觀望）'}；edge 已含 ±對比調整。逆優勢側候選應降級或棄用（等優勢匯聚，不見單一信號就入市）。`,
    )
    // v2.12.62 — Edge 1 anatomy + Edge 2 trap/setup reads ride the header once
    const trap = met.shakeout.side != null ? ` · ${met.shakeout.text}` : ''
    const setup = met.setup.ready ? ` · ${met.setup.text}` : ''
    head.push(
      `[M.E.T. 趨勢動能] ${met.tm.summary}${trap}${setup} — Edge 1（Ch.10-17）：強勢趨勢只做順勢側，逆強勢趨勢候選必須棄用；SL 藏匯聚區外側（各候選行附建議 SL 位，跌出區間 = 假設失效）。`,
    )
    // v2.12.63 — EP4 均線 pack rides the header once: stack + TSLA gate + the
    // SMA20/EMA20 band + the SL/re-entry discipline (傻豬豬 rule)
    const maLine = met.ma.summary
    if (maLine) {
      head.push(
        `[M.E.T. 均線] ${maLine} — EP4：均線不可單獨作為進場理由（需疊 ≥1 個其他優勢）；「閘門生效」側不得以均線當支撐/阻力依據（TSLA 200MA 教訓）；止損絕不放支撐面上，有第二層時藏第二層外側，第二層即跌破後的再進場計劃（每個計劃必須附再進場劇本）。`,
      )
    }
  }
  return [...head, ...lines].join('\n')
}

/** 繁中 names for the log/panel — resolved through the library. */
export function strategyName(id: string | null | undefined): string | null {
  if (!id) return null
  return STRATEGY_BY_ID.get(id)?.name ?? null
}
