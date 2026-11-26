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
}

const fmtPx = (n: number) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4))

function summarize(longEdges: MetEdge[], shortEdges: MetEdge[], longW: number, shortW: number, meta: boolean): { leader: MetContext['leader']; dominance: number; summary: string } {
  const dominance = Math.abs(longW - shortW)
  const leader: MetContext['leader'] = longW > shortW + 1 ? 'long' : shortW > longW + 1 ? 'short' : 'balanced'
  const side = leader === 'long' ? '偏多' : leader === 'short' ? '偏空' : '勢均力敵'
  const summary = `多 ${longEdges.length}(w${longW}) vs 空 ${shortEdges.length}(w${shortW}) — ${side}${meta && leader !== 'balanced' ? ' · M.E.T.A.' : ''}`
  return { leader, dominance, summary }
}

/** The M.E.T. core: enumerate BOTH sides' edges from one snapshot (Ch.6:
 *  「入場前先問自己三條問題 — 我在這個位置有沒有優勢？有多少個？又有多少
 *  不利因素反對我的假設？」). Deterministic; every rule quotes the course. */
export function metVerdict(s: ChartSnapshot): MetContext {
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
  const { leader, dominance, summary } = summarize(longEdges, shortEdges, longW, shortW, false)
  const meta = (leader === 'long' ? longEdges.length : shortEdges.length) >= 3 && dominance >= 2 && leader !== 'balanced'
  const sum2 = summarize(longEdges, shortEdges, longW, shortW, meta)

  // --- M.E.T.A. zone (Ch.8: 「多項技術優勢匯聚、沽壓逐漸減弱的區域」) ---
  let zone: MetContext['zone'] = null
  if (leader !== 'balanced' && atr != null) {
    const lvl = leader === 'long' ? s.srSupport : s.srResistance
    const touches = leader === 'long' ? s.srSupportTouches : s.srResistanceTouches
    const ref = leader === 'long' ? s.sma20 : s.sma20
    if (lvl != null) {
      const basisParts: string[] = [`測試${leader === 'long' ? '支撐' : '阻力'}${touches ? `×${touches}` : ''}`]
      // SMA20 confluence (Ch.8 example 2: pullback INTO the 200/20MA cluster)
      if (ref != null && Math.abs(ref - lvl) <= atr) basisParts.push('SMA20 匯聚')
      zone = { lo: lvl - atr * 0.5, hi: lvl + atr * 0.5, basis: basisParts.join(' + ') }
    }
  }

  return { longEdges, shortEdges, longW, shortW, leader: sum2.leader, dominance: sum2.dominance, meta, zone, summary: sum2.summary }
}

/** zone line for the prompt/log — null when no M.E.T.A. zone */
export function metZoneText(m: MetContext): string | null {
  if (!m.zone) return null
  return `M.E.T.A. 匯聚區 ${fmtPx(m.zone.lo)}–${fmtPx(m.zone.hi)}（${m.zone.basis}）`
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
