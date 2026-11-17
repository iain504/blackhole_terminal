// AI TRADE REVIEW (智慧複盤) — v2.12.49. Turns historical closed round-trips
// into STRUCTURED, GUARDED lessons the live trading prompt can actually use.
//
// Doctrine alignment (核心護盤記憶): execution logic and AI stay DECOUPLED —
// this module is an OFFLINE analyst. It never triggers anything on price; its
// whole output is contextual rules fed back into the steward's prompt. The
// auditor prompt enforces the anti-overfit guards the user mandated:
//   · process graded SEPARATELY from outcome (2x2 quadrant matrix)
//   · hindsight bias eliminated — entry judged on point-in-time context only
//   · MAE/MFE excursion efficiency vs ATR (wicked stops / early exits)
//   · session & liquidity attribution (regular vs extended hours)
//   · NO single-trade overfitting — candidate rules need 2+ sightings
//   · strict JSON only, validated server-side before anything is stored
//
// Enrichment is computed with POINT-IN-TIME data only: ATR14 from DAILY bars
// that CLOSED before the entry, MAE/MFE from intraday bars inside
// [entryAt..exitAt], volume ratio from bars preceding the entry bar. Nothing
// after the exit ever leaks into the trade's context.

import type { Bar, Timeframe } from '@/lib/market-types'
import { computeAtr } from '@/lib/indicators'

// ---------------------------------------------------------------------------
// session classification (ET clock, DST-safe via Intl)
// ---------------------------------------------------------------------------

export type EquitySession = 'pre' | 'regular' | 'post' | 'overnight' | 'weekend'
export type TradeSessionTag = EquitySession | 'crypto-24h'

const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

/** ET session of an ISO timestamp: pre 04:00–09:30, regular 09:30–16:00,
 * post 16:00–20:00, else overnight; Sat/Sun = weekend (crypto never sleeps). */
export function classifySession(iso: string | number, assetClass?: string): TradeSessionTag {
  if (assetClass === 'crypto') return 'crypto-24h'
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return 'overnight'
  const parts = ET_TIME.formatToParts(new Date(t))
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? ''
  const wd = get('weekday')
  if (wd === 'Sat' || wd === 'Sun') return 'weekend'
  const h = parseInt(get('hour'), 10) % 24 // Intl may render 24:xx for midnight under hour12:false
  const m = parseInt(get('minute'), 10)
  const mins = h * 60 + m
  if (mins >= 240 && mins < 570) return 'pre' // 04:00–09:30
  if (mins >= 570 && mins < 960) return 'regular' // 09:30–16:00
  if (mins >= 960 && mins < 1200) return 'post' // 16:00–20:00
  return 'overnight'
}

/** The extended-hours doctrine tag: pre/post (and overnight/weekend gaps)
 * are the sessions where Alpaca's native SL/TP cannot protect a position. */
export function isExtendedLike(s: TradeSessionTag): boolean {
  return s === 'pre' || s === 'post' || s === 'overnight' || s === 'weekend'
}

// ---------------------------------------------------------------------------
// excursion math (MAE/MFE) — the TP/SL-tuning signal
// ---------------------------------------------------------------------------

export interface Excursions {
  /** max adverse excursion, $/share, ≥ 0 (against the position) */
  mae: number
  /** max favorable excursion, $/share, ≥ 0 (with the position) */
  mfe: number
  maePct: number // % of entry price
  mfePct: number
  /** same excursions in ATR units (ATR at entry) — null when ATR unknown */
  maeAtr: number | null
  mfeAtr: number | null
  barsUsed: number
}

/** MAE/MFE over the bars that the trade actually lived through
 * [entrySec..exitSec]. Magnitudes, direction-aware (short mirrored). */
export function computeExcursions(
  bars: Bar[],
  entrySec: number,
  exitSec: number,
  side: 'long' | 'short',
  entryPrice: number,
  atr: number | null,
): Excursions | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null
  const win = bars.filter((b) => b.time >= entrySec && b.time <= exitSec && b.low > 0 && b.high > 0)
  if (win.length === 0) return null
  let minLow = Number.POSITIVE_INFINITY
  let maxHigh = 0
  for (const b of win) {
    if (b.low < minLow) minLow = b.low
    if (b.high > maxHigh) maxHigh = b.high
  }
  // adverse = worst price against the direction; favorable = best with it
  const adverse = side === 'long' ? entryPrice - minLow : maxHigh - entryPrice
  const favorable = side === 'long' ? maxHigh - entryPrice : entryPrice - minLow
  const mae = Math.max(0, adverse)
  const mfe = Math.max(0, favorable)
  return {
    mae,
    mfe,
    maePct: (mae / entryPrice) * 100,
    mfePct: (mfe / entryPrice) * 100,
    maeAtr: atr != null && atr > 0 ? mae / atr : null,
    mfeAtr: atr != null && atr > 0 ? mfe / atr : null,
    barsUsed: win.length,
  }
}

/** ATR14 at entry from DAILY bars that CLOSED BEFORE the entry — the model
 * must never see a volatility number the trader could not have known. */
export function atrAtEntry(dailyBars: Bar[], entrySec: number): number | null {
  const prior = dailyBars.filter((b) => b.time + 86400 <= entrySec) // bar open + full day ≤ entry
  if (prior.length < 15) return null
  return computeAtr(prior.slice(-15), 14)
}

/** Entry bar volume ÷ mean volume of the preceding 20 bars (liquidity pulse
 * at the moment of entry). Needs ≥ 5 prior bars, else null. */
export function volumeRatioAtEntry(bars: Bar[], entrySec: number): number | null {
  const idx = bars.findIndex((b) => b.time >= entrySec)
  if (idx < 5) return null
  const prior = bars.slice(Math.max(0, idx - 20), idx)
  if (prior.length < 5) return null
  const avg = prior.reduce((a, b) => a + (b.volume > 0 ? b.volume : 0), 0) / prior.length
  if (avg <= 0) return null
  return bars[idx].volume / avg
}

/** Slippage of a limit order fill: fill − intended limit, direction-adjusted
 * (positive bps = paid MORE than intended when buying / received LESS when
 * selling). Market orders and missing limits → null (honest). */
export function slippageBps(
  fillPrice: number,
  limitPrice: string | null | undefined,
  side: 'buy' | 'sell',
): number | null {
  const lim = Number.parseFloat(limitPrice ?? '')
  if (!Number.isFinite(lim) || lim <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) return null
  const raw = side === 'buy' ? fillPrice - lim : lim - fillPrice
  // positive raw = fill worse than intended (buy higher / sell lower)
  return (raw / lim) * 10_000
}

/** Excursion window timeframe: ≤2 trading days reads 15m bars, longer reads
 * 1h — keeps Alpaca page counts sane without losing intraday precision. */
export function excursionTimeframe(durationMs: number): Timeframe {
  return durationMs <= 2 * 86_400_000 ? '15m' : '1h'
}

// ---------------------------------------------------------------------------
// batching + enrichment payload for the auditor
// ---------------------------------------------------------------------------

export const AUDIT_BATCH_SIZE = 6
export const AUDIT_LIMITS = [12, 24, 36] as const

/** Split trades into auditor batches of 5–10 (default 6) — newest first.
 *  The size is clamped into the spec's 5-10 band (a batch smaller than 5
 *  would push the model toward single-trade overfitting, the exact failure
 *  mode Rule 4 forbids). */
export function buildAuditBatches<T>(trades: T[], size = AUDIT_BATCH_SIZE): T[][] {
  const n = Math.max(5, Math.min(10, Math.round(size)))
  const out: T[][] = []
  for (let i = 0; i < trades.length; i += n) out.push(trades.slice(i, i + n))
  return out
}

export interface EnrichedTrade {
  trade_id: string
  symbol: string
  asset_class: string
  side: 'long' | 'short'
  qty: number
  source: string
  strategy?: string
  entry_time: string
  exit_time: string
  held_minutes: number
  entry_price: number
  exit_price: number
  pnl: number
  pnl_pct: number
  entry_session: TradeSessionTag
  exit_session: TradeSessionTag
  held_extended: boolean
  excursions: {
    mae: number; mae_pct: number; mfe: number; mfe_pct: number
    mae_atr: number | null; mfe_atr: number | null
  } | null
  excursion_note: string | null
  atr: { value: number; pct: number } | null
  volume_ratio: number | null
  slippage: { entry_bps: number | null; exit_bps: number | null } | null
  reason: string
}

// ---------------------------------------------------------------------------
// strict output validation — the auditor NEVER stores what it was not asked for
// ---------------------------------------------------------------------------

export const QUADRANTS = ['GOOD_PROCESS_WIN', 'GOOD_PROCESS_LOSS', 'BAD_PROCESS_WIN', 'BAD_PROCESS_LOSS'] as const
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const
/** Tag vocabulary — anything else the model invents is dropped server-side. */
export const TAG_WHITELIST = [
  'session:extended', 'session:regular', 'session:any',
  'vol:high', 'vol:low', 'vol:any',
  'asset:crypto', 'asset:equity', 'asset:any',
] as const

export interface ParsedAudit {
  trade_id: string
  symbol: string
  quadrant: (typeof QUADRANTS)[number]
  execution_score: number
  mae_mfe_diagnosis: string
  session_impact: string
  root_cause: string
}
export interface ParsedPattern {
  pattern_description: string
  frequency_in_batch: number
  estimated_pnl_impact: string
}
export interface ParsedRule {
  rule_id: string
  condition: string
  action: string
  confidence: (typeof CONFIDENCES)[number]
  tags: string[]
}

export interface ParsedAuditOutput {
  audits: ParsedAudit[]
  patterns: ParsedPattern[]
  rules: ParsedRule[]
}

const asStr = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const asNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : Number.NaN
}

function parseTags(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : []
  return [...new Set(arr.filter((t): t is string => typeof t === 'string' && (TAG_WHITELIST as readonly string[]).includes(t)))]
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1))
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Parse + validate the auditor's JSON. Guards enforced here:
 *  · audits whose trade_id is NOT in the batch are DROPPED (hallucination guard)
 *  · quadrant must be one of the four; score clamped 1..10
 *  · text fields capped (a rambling model cannot bloat the DB or the prompt)
 *  · candidate rules keep only whitelisted tags; empty condition/action → dropped
 */
export function parseAuditOutput(text: string, validTradeIds: Set<string>): ParsedAuditOutput | null {
  const obj = extractJsonObject(text)
  if (!obj) return null

  const audits: ParsedAudit[] = []
  const rawAudits = Array.isArray(obj.trade_audits) ? obj.trade_audits : []
  for (const a of rawAudits) {
    const it = a as Record<string, unknown>
    const id = asStr(it.trade_id, 120)
    if (!id || !validTradeIds.has(id)) continue // unknown/hallucinated id → drop
    const q = asStr(it.quadrant, 40)
    if (!(QUADRANTS as readonly string[]).includes(q)) continue
    const score = Math.max(1, Math.min(10, Math.round(asNum(it.execution_score) || 0) || 5))
    audits.push({
      trade_id: id,
      symbol: asStr(it.symbol, 24) || '—',
      quadrant: q as ParsedAudit['quadrant'],
      execution_score: score,
      mae_mfe_diagnosis: asStr(it.mae_mfe_diagnosis, 600) || '—',
      session_impact: asStr(it.session_impact, 400) || '—',
      root_cause: asStr(it.root_cause, 400) || '—',
    })
  }

  const patterns: ParsedPattern[] = []
  const rawPatterns = Array.isArray(obj.batch_patterns) ? obj.batch_patterns : []
  for (const p of rawPatterns.slice(0, 8)) {
    const it = p as Record<string, unknown>
    const desc = asStr(it.pattern_description, 400)
    if (!desc) continue
    const freq = Math.max(1, Math.round(asNum(it.frequency_in_batch) || 1))
    patterns.push({ pattern_description: desc, frequency_in_batch: freq, estimated_pnl_impact: asStr(it.estimated_pnl_impact, 200) || '—' })
  }

  const rules: ParsedRule[] = []
  const rawRules = Array.isArray(obj.candidate_rules_for_live_prompt) ? obj.candidate_rules_for_live_prompt : []
  for (const r of rawRules.slice(0, 6)) {
    const it = r as Record<string, unknown>
    const cond = asStr(it.condition, 300)
    const act = asStr(it.action, 300)
    if (!cond || !act) continue
    const conf = asStr(it.confidence, 10).toUpperCase()
    rules.push({
      rule_id: asStr(it.rule_id, 60) || `r-${cond.slice(0, 24).replace(/\W+/g, '')}`,
      condition: cond,
      action: act,
      confidence: ((CONFIDENCES as readonly string[]).includes(conf) ? conf : 'MEDIUM') as ParsedRule['confidence'],
      tags: parseTags(it.tags),
    })
  }

  if (audits.length === 0 && patterns.length === 0 && rules.length === 0) return null
  return { audits, patterns, rules }
}

// ---------------------------------------------------------------------------
// rule lifecycle — dedupe, ranking, steward injection matching
// ---------------------------------------------------------------------------

/** Stable dedupe key: lowercase, strip punctuation, collapse whitespace, cap —
 * the same guardrail re-proposed in a later batch folds into ONE row. */
export function ruleDedupeKey(condition: string, action: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)
  return `${norm(condition)}=>${norm(action)}`
}

const CONF_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 }

/** Consolidation ranking: confidence × recurrence × recency. Deterministic
 * fallback when the LLM consolidation pass is unavailable. */
export function rankCandidates<T extends { confidence: string; frequency: number; lastSeenAt: Date | string }>(
  rules: T[],
): T[] {
  return [...rules].sort((a, b) => {
    const c = (CONF_RANK[b.confidence] ?? 0) - (CONF_RANK[a.confidence] ?? 0)
    if (c !== 0) return c
    if (b.frequency !== a.frequency) return b.frequency - a.frequency
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  })
}

export interface MinimalRule {
  condition: string
  action: string
  confidence: string
  tags: string[]
}

/** Steward injection: keep rules whose session tag matches the CURRENT live
 * session (session:any always passes; pre/post/overnight all count as
 * `session:extended`). Cap 7 — the prompt must not bloat. */
export function matchActiveRules<T extends MinimalRule>(rules: T[], session: 'regular' | 'pre' | 'post', cap = 7): T[] {
  const tag = session === 'regular' ? 'session:regular' : 'session:extended'
  return rules
    .filter((r) => {
      const tags = Array.isArray(r.tags) ? r.tags : []
      if (tags.includes('session:any') || tags.length === 0) return true
      return tags.includes(tag)
    })
    .slice(0, cap)
}

// ---------------------------------------------------------------------------
// prompts (low temperature 0.1–0.2 enforced at the call site)
// ---------------------------------------------------------------------------

export const AUDIT_SYSTEM_PROMPT = `### SYSTEM PROMPT
You are a Quantitative Trading Auditor evaluating historical US equity/crypto trades executed via Alpaca. Your objective is to improve future risk-adjusted P&L by identifying repeatable execution flaws, regime mismatches, and parameter inefficiencies.

STRICT AUDIT RULES:
1. Eliminate Hindsight Bias: Judge entry quality ONLY using the market indicators, volatility (ATR), session state, and liquidity available at \`entry_time\`. Data recorded AFTER the entry (the excursion trace, the exit) may be used to evaluate EXIT quality and stop placement, never the entry decision.
2. Separate Process from Outcome: Classify every trade into one of four quadrants:
   - \`GOOD_PROCESS_WIN\`: Valid setup, disciplined execution, profitable.
   - \`GOOD_PROCESS_LOSS\`: Valid setup, proper risk control, stopped out by normal market variance. (Do NOT recommend strategy changes for these.)
   - \`BAD_PROCESS_WIN\`: Flawed entry, poor liquidity, or oversized risk that got lucky. (Flag as high-risk behavior.)
   - \`BAD_PROCESS_LOSS\`: Preventable error (e.g., chasing low-volume extended hours, ignoring high spread, fighting strong higher-timeframe trend).
3. Analyze MAE/MFE: Use Maximum Adverse Excursion (MAE) and Maximum Favorable Excursion (MFE) relative to ATR to evaluate whether Stop-Loss levels are getting wicked out or Take-Profit levels are leaving significant gains on the table. MAE/MFE are given in $/share, % of entry, and ATR multiples. If excursions are null, say the data was unavailable and judge on execution metrics only — never invent numbers.
4. No Single-Trade Overfitting: Only propose a \`candidate_rule\` if a pattern appears across 2 or more trades in this batch, or aligns with known structural market constraints (e.g., Alpaca extended-hours liquidity limits: no native SL/TP brackets pre/post market, whole shares only, 422 on market/GTC extended orders).
5. Echo trade_id EXACTLY as provided for each audited trade. Crypto trades run a 24h session (entry_session = crypto-24h) — apply session judgment only to equities.
6. Tags for candidate rules MUST come from this vocabulary only: session:extended, session:regular, session:any, vol:high, vol:low, vol:any, asset:crypto, asset:equity, asset:any.

Output strictly valid JSON matching the requested schema. No prose outside the JSON.`

export const AUDIT_USER_TEMPLATE = (batchJson: string): string => `Analyze the following batch of completed trades from our 15m/30m/1h intraday & swing strategy:

<trade_batch>
${batchJson}
</trade_batch>

Return JSON in this exact format:
{
  "trade_audits": [
    {
      "trade_id": "string",
      "symbol": "string",
      "quadrant": "GOOD_PROCESS_WIN | GOOD_PROCESS_LOSS | BAD_PROCESS_WIN | BAD_PROCESS_LOSS",
      "execution_score": 1-10,
      "mae_mfe_diagnosis": "string (concise analysis of stop placement and exit timing vs ATR)",
      "session_impact": "string (impact of regular vs extended hours, spread, or slippage)",
      "root_cause": "string"
    }
  ],
  "batch_patterns": [
    {
      "pattern_description": "string",
      "frequency_in_batch": "integer",
      "estimated_pnl_impact": "string"
    }
  ],
  "candidate_rules_for_live_prompt": [
    {
      "rule_id": "string",
      "condition": "string (e.g., 'When holding into extended hours with spread > 0.4% ATR')",
      "action": "string (e.g., 'Flatten 50% before 15:55 ET and widen synthetic SL buffer by 0.5x ATR')",
      "confidence": "HIGH | MEDIUM | LOW",
      "tags": ["session:extended"]
    }
  ]
}`

export const CONSOLIDATE_SYSTEM_PROMPT = `You consolidate candidate trading guardrails produced by a post-trade audit pipeline into the account's ACTIVE "AI Trading Guardrails" list.

STRICT RULES:
1. Merge/deduplicate overlapping candidates — one guardrail per distinct behavior.
2. Cap the list at 5-7 rules: pick the highest-impact ones (confidence × recurrence × P&L impact); drop vague, contradictory, or single-trade-flavored rules.
3. Rewrite each kept rule as a crisp condition → action pair a pre-trade model can follow at a glance.
4. Keep tags from this vocabulary only: session:extended, session:regular, session:any, vol:high, vol:low, vol:any, asset:crypto, asset:equity, asset:any.
5. NEVER propose rules that bypass risk control (e.g., "remove stops", "average down", "increase size to recover"). Guardrails exist to REDUCE risk-adjusted drawdown, not to chase losses.

Output strictly valid JSON: {"rules":[{"rule_id":"string","condition":"string","action":"string","confidence":"HIGH|MEDIUM|LOW","tags":["..."]}]}. No prose outside the JSON.`

export const CONSOLIDATE_USER_TEMPLATE = (candidatesJson: string, activesJson: string): string =>
  `Current ACTIVE guardrails:
<active_rules>
${activesJson}
</active_rules>

Candidate rules from recent audits:
<candidates>
${candidatesJson}
</candidates>

Consolidate into the next ACTIVE list (5-7 rules max) per the system rules. Return JSON: {"rules":[...]}.`
