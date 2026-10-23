// Day-trade plan engine (Task 83) — pure functions, no dependencies.
//
// The Trade Advisor's DAY mode is built on the tools the day-trading community
// consistently ranks highest (research round 2025-11):
//   1. VWAP            — the #1 intraday indicator: trend filter (long above /
//                        short below) and dynamic support/resistance.
//   2. Opening Range   — the first 5/15/30 minutes define the day's battle
//                        lines; breakout/breakdown/retest entries (ORB).
//   3. Prior day H/L   — PDH/PDL are the levels every day trader marks before
//                        the open; breakout magnets and rejection zones.
//   4. Relative volume — participation filter: sub-1 RVOL = chop warning.
//   5. ATR-sized stops — day-trade stops live in the 0.5–2.5 ATR(5m) band.
//   6. R:R discipline  — targets aim for ≥1.5R (community floor 1.5–2).
//
// All inputs come from ordinary bars (5m intraday), everything is
// deterministic and explainable — every row in the advisor's checklist maps
// to one rule here.

export interface DayBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// ------------------------------ session grouping ----------------------------

export interface SessionInfo {
  /** UTC date key ('2025-11-14') — one RTH session for stocks, one UTC day for crypto */
  key: string
  /** bars of the session, chronological */
  bars: DayBar[]
  high: number
  low: number
  volume: number
}

/**
 * Group bars into sessions by UTC calendar day. Alpaca stock bars are
 * regular-hours only, so each UTC date IS one session; crypto trades a UTC
 * day. Sessions chronological; sessions with no bars are absent.
 */
export function groupSessions(bars: DayBar[]): SessionInfo[] {
  const out: SessionInfo[] = []
  let cur: SessionInfo | null = null
  for (const b of bars) {
    const key = new Date(b.time * 1000).toISOString().slice(0, 10)
    if (!cur || cur.key !== key) {
      cur = { key, bars: [], high: b.high, low: b.low, volume: 0 }
      out.push(cur)
    }
    cur.bars.push(b)
    if (b.high > cur.high) cur.high = b.high
    if (b.low < cur.low) cur.low = b.low
    cur.volume += b.volume > 0 ? b.volume : 0
  }
  return out
}

// ------------------------------ opening range -------------------------------

export interface OpeningRange {
  high: number
  low: number
  /** session minutes the OR window spans */
  minutes: number
  /** false while the session is younger than the window */
  complete: boolean
  /** how many minutes of the window have actually printed */
  builtMinutes: number
}

/** Opening range = high/low of the session's FIRST `minutes` minutes. */
export function openingRange(sess: SessionInfo, minutes: number, tfSec: number): OpeningRange {
  const need = Math.max(1, Math.round(minutes * 60 / tfSec))
  let high = -Infinity
  let low = Infinity
  let built = 0
  for (let i = 0; i < sess.bars.length && built < need; i++, built++) {
    const b = sess.bars[i]
    if (b.high > high) high = b.high
    if (b.low < low) low = b.low
  }
  return {
    high,
    low,
    minutes,
    complete: built >= need && Number.isFinite(high) && Number.isFinite(low),
    builtMinutes: Math.round(built * tfSec / 60),
  }
}

// ----------------------------------- ATR ------------------------------------

/** Wilder ATR over the joined intraday series (tail `period` after warm-up). */
export function atrWilder(bars: DayBar[], period: number): number | null {
  if (bars.length <= period) return null
  let atr = 0
  // seed = simple average of the first `period` true ranges
  let prevClose = bars[0].close
  for (let i = 1; i <= period; i++) {
    const b = bars[i]
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
    atr += tr
    prevClose = b.close
  }
  atr /= period
  for (let i = period + 1; i < bars.length; i++) {
    const b = bars[i]
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
    atr = (atr * (period - 1) + tr) / period
    prevClose = b.close
  }
  return Number.isFinite(atr) && atr > 0 ? atr : null
}

// ----------------------------------- RVOL -----------------------------------

/**
 * Relative volume: TODAY's cumulative volume vs the average cumulative
 * volume of prior sessions at the same bar-of-session index (clamped to each
 * session's length). null when no prior session exists.
 */
export function relVolume(sessions: SessionInfo[]): number | null {
  if (sessions.length < 2) return null
  const today = sessions[sessions.length - 1]
  const idx = today.bars.length - 1
  if (idx < 0) return null
  let todayVol = 0
  for (let i = 0; i <= idx; i++) todayVol += today.bars[i].volume > 0 ? today.bars[i].volume : 0
  let base = 0
  let n = 0
  for (let s = 0; s < sessions.length - 1; s++) {
    const sess = sessions[s]
    const j = Math.min(idx, sess.bars.length - 1)
    if (j < 0) continue
    let v = 0
    for (let i = 0; i <= j; i++) v += sess.bars[i].volume > 0 ? sess.bars[i].volume : 0
    if (v > 0) {
      base += v
      n++
    }
  }
  if (n === 0 || base <= 0 || todayVol <= 0) return null
  return todayVol / (base / n)
}

// --------------------------------- the plan ---------------------------------

export type DaySide = 'long' | 'short'
export type DaySetup = 'breakout-retest' | 'breakout' | 'vwap-pullback' | 'reversion'

export interface DayCheck {
  key: 'vwap' | 'or' | 'pdl' | 'rvol' | 'counter'
  label: string
  /** short verdict shown bold */
  state: string
  tone: 'long' | 'short' | 'neutral' | 'warn'
  detail: string
}

export interface DayPlan {
  side: DaySide
  setup: DaySetup
  /** human-readable why (panel shows it verbatim) */
  rationale: string
  entry: number
  sl: number
  tp: number
  tpSource: 'measured' | 'prevday' | 'vwap' | '2R' | 'or-edge'
  rr: number
  /** user forced the side against the VWAP bias (or trade is a falling-knife bounce) */
  countertrend: boolean
}

export interface DayAnalysis {
  price: number
  vwap: number | null
  or: OpeningRange | null
  orMid: number | null
  pdh: number | null
  pdl: number | null
  atr: number | null
  rvol: number | null
  bias: DaySide
  orState: 'breakout' | 'breakdown' | 'inside' | null
  checks: DayCheck[]
  plan: DayPlan | null
  /** why no plan could be built */
  err: string | null
  sessions: number
  sessionDate: string | null
}

export interface DayPlanInput {
  /** reference price (live quote preferred, last close fallback) */
  price: number
  side: 'auto' | DaySide
  orMinutes: number
  tfSec: number
  bars: DayBar[]
}

const clampStep = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** limit-price rounding for advice display — mirrors pxOut (stocks 2/4dp, crypto 6/8dp) */
function r(v: number): number {
  return Number.isFinite(v) ? +v.toFixed(6) : v
}

/**
 * Build the full day-trade analysis: session stats, checklist, and (when
 * geometry allows) a concrete limit-only plan. Never throws — a null plan +
 * err explains why not.
 */
export function analyzeDay(input: DayPlanInput): DayAnalysis {
  const { price: p, tfSec } = input
  const sessions = groupSessions(input.bars)
  const today = sessions.length > 0 ? sessions[sessions.length - 1] : null
  const out: DayAnalysis = {
    price: p,
    vwap: null,
    or: null,
    orMid: null,
    pdh: null,
    pdl: null,
    atr: null,
    rvol: null,
    bias: 'long',
    orState: null,
    checks: [],
    plan: null,
    err: null,
    sessions: sessions.length,
    sessionDate: today?.key ?? null,
  }
  if (!today || today.bars.length < 2) {
    out.err = 'No intraday session yet for this symbol — try again during/after market hours.'
    return out
  }
  // VWAP of the running session (cumulative from today's open)
  let cumPV = 0
  let cumV = 0
  for (const b of today.bars) {
    const v = b.volume > 0 ? b.volume : 0
    cumPV += ((b.high + b.low + b.close) / 3) * v
    cumV += v
  }
  const vwap = cumV > 0 ? cumPV / cumV : null
  out.vwap = vwap
  const or = openingRange(today, input.orMinutes, tfSec)
  out.or = or
  out.orMid = Number.isFinite(or.high) && Number.isFinite(or.low) ? (or.high + or.low) / 2 : null
  if (sessions.length >= 2) {
    const prev = sessions[sessions.length - 2]
    out.pdh = prev.high
    out.pdl = prev.low
  }
  // ATR over the last ~500 5m bars (≈ 6 sessions) — stable, still intraday-scale
  const atr = atrWilder(input.bars.slice(-500), 14)
  out.atr = atr
  const rvol = relVolume(sessions)
  out.rvol = rvol

  if (p <= 0) {
    out.err = 'No usable price yet.'
    return out
  }
  if (!or.complete || out.orMid == null || !Number.isFinite(or.high) || !Number.isFinite(or.low)) {
    out.err = `Opening range still forming — ${or.builtMinutes} of ${or.minutes} minutes printed. Re-analyze after the window completes.`
    return out
  }
  if (atr == null) {
    out.err = 'Not enough intraday history for ATR — widen the lookback or retry later.'
    return out
  }

  // bias: the community's first rule — above VWAP look long, below look short
  out.bias = vwap != null && p < vwap ? 'short' : 'long'
  out.orState = p > or.high ? 'breakout' : p < or.low ? 'breakdown' : 'inside'
  const side: DaySide = input.side === 'auto' ? out.bias : input.side
  const countertrend = side !== out.bias
  const long = side === 'long'
  const atrN = atr

  // ---- checklist rows ----
  const checks: DayCheck[] = []
  checks.push(
    vwap == null
      ? { key: 'vwap', label: 'VWAP trend', state: 'no volume data', tone: 'neutral', detail: 'Session volume unavailable — VWAP bias skipped.' }
      : out.bias === 'long'
        ? { key: 'vwap', label: 'VWAP trend', state: 'above — long bias', tone: 'long', detail: `Price ${fmtP(p)} is above session VWAP ${fmtP(vwap)} (+${(((p - vwap) / vwap) * 100).toFixed(2)}%).` }
        : { key: 'vwap', label: 'VWAP trend', state: 'below — short bias', tone: 'short', detail: `Price ${fmtP(p)} is below session VWAP ${fmtP(vwap)} (${(((p - vwap) / vwap) * 100).toFixed(2)}%).` },
  )
  const orTxt = `${fmtP(or.low)} – ${fmtP(or.high)}`
  checks.push(
    out.orState === 'breakout'
      ? { key: 'or', label: `Opening range ${or.minutes}m`, state: 'breakout above', tone: 'long', detail: `Price cleared the OR high ${fmtP(or.high)} — continuation/retest setups favor longs.` }
      : out.orState === 'breakdown'
        ? { key: 'or', label: `Opening range ${or.minutes}m`, state: 'breakdown below', tone: 'short', detail: `Price lost the OR low ${fmtP(or.low)} — continuation/retest setups favor shorts.` }
        : { key: 'or', label: `Opening range ${or.minutes}m`, state: 'inside range', tone: 'neutral', detail: `Price is inside ${orTxt} — trade the edges (breakout or VWAP pullback), not the middle.` },
  )
  if (out.pdh != null && out.pdl != null) {
    const dPdh = (out.pdh - p) / atrN
    const dPdl = (p - out.pdl) / atrN
    if (Math.abs(dPdh) <= 0.5) {
      checks.push({ key: 'pdl', label: 'Prior day levels', state: p >= out.pdh ? 'above PDH ✓' : 'at PDH', tone: p >= out.pdh ? 'long' : 'warn', detail: `Price is ${Math.abs(dPdh).toFixed(1)}×ATR ${p >= out.pdh ? 'above' : 'below'} prior-day high ${fmtP(out.pdh)} — breakout watch / magnet level.` })
    } else if (Math.abs(dPdl) <= 0.5) {
      checks.push({ key: 'pdl', label: 'Prior day levels', state: p <= out.pdl ? 'below PDL ✓' : 'at PDL', tone: p <= out.pdl ? 'short' : 'warn', detail: `Price is ${Math.abs(dPdl).toFixed(1)}×ATR ${p <= out.pdl ? 'below' : 'above'} prior-day low ${fmtP(out.pdl)} — breakdown watch / magnet level.` })
    } else {
      const nearest = Math.abs(dPdh) < Math.abs(dPdl)
        ? `PDH ${fmtP(out.pdh)} is ${Math.abs(dPdh).toFixed(1)}×ATR above`
        : `PDL ${fmtP(out.pdl)} is ${Math.abs(dPdl).toFixed(1)}×ATR below`
      checks.push({ key: 'pdl', label: 'Prior day levels', state: 'mid-range', tone: 'neutral', detail: `${nearest} — not an immediate factor.` })
    }
  } else {
    checks.push({ key: 'pdl', label: 'Prior day levels', state: 'unavailable', tone: 'neutral', detail: 'Need one completed session of history for PDH/PDL.' })
  }
  checks.push(
    rvol == null
      ? { key: 'rvol', label: 'Relative volume', state: 'unavailable', tone: 'neutral', detail: 'No prior session to compare against.' }
      : rvol >= 1.5
        ? { key: 'rvol', label: 'Relative volume', state: `${rvol.toFixed(1)}× — hot`, tone: 'long', detail: 'Well above average participation — breakouts have fuel.' }
        : rvol >= 1.2
          ? { key: 'rvol', label: 'Relative volume', state: `${rvol.toFixed(1)}× — active`, tone: 'long', detail: 'Above-average participation — day-trade conditions OK.' }
          : rvol >= 0.8
            ? { key: 'rvol', label: 'Relative volume', state: `${rvol.toFixed(1)}× — normal`, tone: 'neutral', detail: 'Average participation.' }
            : { key: 'rvol', label: 'Relative volume', state: `${rvol.toFixed(1)}× — quiet`, tone: 'warn', detail: 'Below-average participation — expect chop and false breaks; size down.' },
  )
  if (countertrend) {
    checks.push({
      key: 'counter',
      label: 'Trend agreement',
      state: 'countertrend',
      tone: 'warn',
      detail: long
        ? `Long while price is ${vwap != null && p < vwap ? 'below' : 'below'} VWAP — fading intraday momentum; keep size small and honor the stop.`
        : `Short while price is above VWAP — fading intraday momentum; keep size small and honor the stop.`,
    })
  }
  out.checks = checks

  // ---- plan construction ----
  // Risk band: day-trade stops live between 0.5 and 2.5 ATR(5m) from entry.
  const riskFloor = 0.5 * atrN
  const riskCap = 2.5 * atrN
  const pickTp = (entry: number, sl: number, cands: { price: number; source: DayPlan['tpSource'] }[]): { tp: number; source: DayPlan['tpSource'] } => {
    const risk = Math.abs(entry - sl)
    const passing = cands
      .filter((c) => Number.isFinite(c.price) && (long ? c.price > entry : c.price < entry))
      .filter((c) => risk > 0 && Math.abs(c.price - entry) / risk >= 1.5)
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))
    if (passing.length > 0) return { tp: passing[0].price, source: passing[0].source }
    // none reaches 1.5R — default to a clean 2R target (community floor)
    return { tp: long ? entry + 2 * risk : entry - 2 * risk, source: '2R' }
  }

  let plan: DayPlan | null = null
  const orH = or.high
  const orL = or.low
  const orMid = out.orMid
  const orHeight = orH - orL
  const measured = long ? p + orHeight : p - orHeight
  const prevDay = long ? out.pdh : out.pdl

  if (long) {
    if (out.orState === 'breakout') {
      // breakout continuation: rest a buy limit at the OR high (fills on the retest)
      const entry = orH
      const cands = [orMid, vwap ?? -Infinity, entry - 1.5 * atrN].filter((c) => c <= entry - riskFloor)
      const raw = cands.length > 0 ? Math.max(...cands) : entry - 1.5 * atrN
      const sl = r(clampStep(raw - 0.25 * atrN, entry - riskCap, entry - riskFloor))
      const { tp, source } = pickTp(entry, sl, [
        { price: measured, source: 'measured' },
        { price: prevDay ?? NaN, source: 'prevday' },
      ])
      plan = {
        side, setup: 'breakout-retest',
        rationale: `Price already cleared the ${or.minutes}m OR high (${fmtP(orH)}). Rest the buy at the level — it fills on the retest; the classic ORB measured move (${fmtP(measured)}) and PDH ${prevDay != null ? fmtP(prevDay) : '—'} frame the target.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend,
      }
    } else if (out.orState === 'inside' && p >= orMid) {
      // upper half of the range — buy the breakout (resting limit above)
      const entry = orH
      const cands = [orMid, vwap != null && vwap < entry - riskFloor ? vwap : -Infinity, entry - 1.5 * atrN].filter((c) => c <= entry - riskFloor)
      const raw = cands.length > 0 ? Math.max(...cands) : entry - 1.5 * atrN
      const sl = r(clampStep(raw - 0.25 * atrN, entry - riskCap, entry - riskFloor))
      const { tp, source } = pickTp(entry, sl, [
        { price: measured, source: 'measured' },
        { price: prevDay ?? NaN, source: 'prevday' },
      ])
      plan = {
        side, setup: 'breakout',
        rationale: `Upper half of the ${or.minutes}m range with a long bias. A resting buy at the OR high ${fmtP(orH)} catches the breakout; stop tucks under the range mid / VWAP.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend,
      }
    } else if (vwap != null && p > vwap && p < orH) {
      // trend-up pullback: rest the buy at VWAP (fills on the dip)
      const entry = vwap
      // stop: 1×ATR under VWAP, or under the OR low — whichever is CLOSER,
      // but only candidates on the VALID side (below entry − 0.5×ATR) qualify
      const cands = [entry - 1 * atrN, orL - 0.25 * atrN].filter((c) => c <= entry - riskFloor)
      const raw = cands.length > 0 ? Math.max(...cands) : entry - 1 * atrN
      const sl = r(clampStep(raw, entry - riskCap, entry - riskFloor))
      const { tp, source } = pickTp(entry, sl, [
        { price: orH, source: 'or-edge' },
        { price: prevDay ?? NaN, source: 'prevday' },
      ])
      plan = {
        side, setup: 'vwap-pullback',
        rationale: `Below the OR high but holding above VWAP ${fmtP(vwap)} — buy the pullback into VWAP, stop 1×ATR under; targets: the OR high ${fmtP(orH)} / prior-day levels.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend,
      }
    } else {
      // below the OR low with a forced long — reversion bounce to VWAP
      const entry = p - 0.5 * atrN
      const sl = r(entry - 1 * atrN)
      const vw = vwap != null && vwap > entry + 0.5 * Math.abs(entry - sl) ? vwap : null
      const { tp, source } = pickTp(entry, sl, [
        ...(vw != null ? [{ price: vw, source: 'vwap' as const }] : []),
        { price: orL, source: 'or-edge' },
      ])
      plan = {
        side, setup: 'reversion',
        rationale: `Price is under the ${or.minutes}m OR low — a long here is a countertrend bounce. Rest the buy ${fmtPrice2(0.5 * atrN)} below, target VWAP ${vwap != null ? fmtP(vwap) : '—'}.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend: true,
      }
    }
  } else {
    // ---- short mirrors ----
    if (out.orState === 'breakdown') {
      const entry = orL
      const cands = [orMid, vwap ?? Infinity, entry + 1.5 * atrN].filter((c) => c >= entry + riskFloor)
      const raw = cands.length > 0 ? Math.min(...cands) : entry + 1.5 * atrN
      const sl = r(clampStep(raw + 0.25 * atrN, entry + riskFloor, entry + riskCap))
      const { tp, source } = pickTp(entry, sl, [
        { price: measured, source: 'measured' },
        { price: prevDay ?? NaN, source: 'prevday' },
      ])
      plan = {
        side, setup: 'breakout-retest',
        rationale: `Price already lost the ${or.minutes}m OR low (${fmtP(orL)}). Rest the sell at the level — it fills on the retest; the measured move (${fmtP(measured)}) and PDL ${prevDay != null ? fmtP(prevDay) : '—'} frame the target.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend,
      }
    } else if (out.orState === 'inside' && p <= orMid) {
      const entry = orL
      const cands = [orMid, vwap != null && vwap > entry + riskFloor ? vwap : Infinity, entry + 1.5 * atrN].filter((c) => c >= entry + riskFloor)
      const raw = cands.length > 0 ? Math.min(...cands) : entry + 1.5 * atrN
      const sl = r(clampStep(raw + 0.25 * atrN, entry + riskFloor, entry + riskCap))
      const { tp, source } = pickTp(entry, sl, [
        { price: measured, source: 'measured' },
        { price: prevDay ?? NaN, source: 'prevday' },
      ])
      plan = {
        side, setup: 'breakout',
        rationale: `Lower half of the ${or.minutes}m range with a short bias. A resting sell at the OR low ${fmtP(orL)} catches the breakdown; stop tucks above the range mid / VWAP.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend,
      }
    } else if (vwap != null && p < vwap && p > orL) {
      const entry = vwap
      // mirror: 1×ATR over VWAP or over the OR high — valid side only
      const cands = [entry + 1 * atrN, orH + 0.25 * atrN].filter((c) => c >= entry + riskFloor)
      const raw = cands.length > 0 ? Math.min(...cands) : entry + 1 * atrN
      const sl = r(clampStep(raw, entry + riskFloor, entry + riskCap))
      const { tp, source } = pickTp(entry, sl, [
        { price: orL, source: 'or-edge' },
        { price: prevDay ?? NaN, source: 'prevday' },
      ])
      plan = {
        side, setup: 'vwap-pullback',
        rationale: `Above the OR low but holding under VWAP ${fmtP(vwap)} — sell the rally into VWAP, stop 1×ATR over; targets: the OR low ${fmtP(orL)} / prior-day levels.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend,
      }
    } else {
      const entry = p + 0.5 * atrN
      const sl = r(entry + 1 * atrN)
      const vw = vwap != null && vwap < entry - 0.5 * Math.abs(entry - sl) ? vwap : null
      const { tp, source } = pickTp(entry, sl, [
        ...(vw != null ? [{ price: vw, source: 'vwap' as const }] : []),
        { price: orH, source: 'or-edge' },
      ])
      plan = {
        side, setup: 'reversion',
        rationale: `Price is over the ${or.minutes}m OR high — a short here is a countertrend fade. Rest the sell ${fmtPrice2(0.5 * atrN)} above, target VWAP ${vwap != null ? fmtP(vwap) : '—'}.`,
        entry: r(entry), sl, tp: r(tp), tpSource: source,
        rr: Math.abs(tp - entry) / Math.abs(entry - sl), countertrend: true,
      }
    }
  }

  // final geometry sanity (mirrors the submit validation)
  const g = plan
  const okGeom = long ? g.sl < g.entry && g.entry < g.tp : g.tp < g.entry && g.entry < g.sl
  if (!okGeom || !(g.rr > 0) || !Number.isFinite(g.rr)) {
    out.plan = null
    out.err = 'Could not build a sane plan from current levels — try a different OR window or side.'
    return out
  }
  out.plan = g
  return out
}

const fmtP = (v: number) => (Number.isFinite(v) ? v.toPrecision(6).replace(/\.?0+$/, '') : '—')
const fmtPrice2 = (v: number) => (Number.isFinite(v) ? v.toPrecision(3) : '—')
