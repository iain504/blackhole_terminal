// v2.5.0 — Market Sentiment Engine · NLP scoring.
//
// The FinBERT slot in the reference architecture is filled by the app's
// backend LLM (z-ai-web-dev-sdk, server-side only): batched, finance-tuned
// headline scoring with a strict JSON contract, confidence per headline, and
// an OFFLINE finance lexicon fallback (VADER-style) so a model outage degrades
// scoring to a weaker-but-working signal instead of a dead pipeline.
//
// NOTE (user-facing, from the reference plan): if this ever ships
// commercially, swap this module for a self-hosted FinBERT (ProsusAI/finbert)
// — the call sites only consume `scoreHeadlines()` and are engine-agnostic.
// FinBERT carries a non-commercial licence — check before commercial use.
import { clampScore, labelOf } from './sentiment-news'
import type { SentimentLabel } from './sentiment-types'

export interface ScoredHeadline {
  label: SentimentLabel
  score: number // -1..1
  confidence: number // 0..1
  engine: 'llm-finance-v1' | 'lexicon-finance-v1'
}

export const SCORER_ENGINE = 'llm-finance-v1'
export const FALLBACK_ENGINE = 'lexicon-finance-v1'

// ---------------------------------------------------------------------------
// Offline finance lexicon (fallback engine)
// ---------------------------------------------------------------------------

const BULL_PATTERNS: RegExp[] = [
  /\b(surge[sd]?|soar(?:s|ed|ing)?|jump(?:s|ed)?|rally|rallies|rallied|rocket\w*|spike[sd]?)\b/i,
  /\b(beats?|blow(?:s)? out|tops? estimates|exceed\w* expectations|raises? (?:guidance|outlook|forecast)|upgrades?|upgraded|price target (?:raise[d]?|hike[d]?))\b/i,
  /\b(record (?:high|profit|revenue|sales|quarter|earnings)|all-?time high|strong(?:er)? than expected|robust|outperform\w*)\b/i,
  /\b(bullish|breakout|buy(?:s)? rating|overweight|accumulat\w+|buyback|share repurchase|dividend (?:hike|increase|raise)|expands?\w*|growth|approv\w+|partnership|landmark deal|wins? contract|secures? contract)\b/i,
  /\b(short squeeze|rebound\w*|recover\w*|turnaround|momentum|inflow\w*|upgrade\w*)\b/i,
]

const BEAR_PATTERNS: RegExp[] = [
  /\b(plunge[sd]?|crash(?:es|ed)?|tumble[sd]?|slump[sd]?|sink[sd]?|sank|collapse[sd]?|nosedish|tank(?:s|ed)?|selloff|sell-?off|dump\w*)\b/i,
  /\b(miss(?:es|ed)? estimates|missed|disappoint\w*|cuts? (?:guidance|outlook|forecast)|lowers? guidance|downgrade[sd]?|price target cut)\b/i,
  /\b(lawsuit|sued|probe|investigat\w+|sec charge\w*|fraud|probe\w*|subpoena\w*|recall\w*|ban\w*)\b/i,
  /\b(bearish|breakdown|sell(?:s)? rating|underweight|warning|warns?|layoff\w*|job cuts|bankrupt\w*|default\w*|restructur\w+|going concern|dilution|offering)\b/i,
  /\b(short (?:seller|report|attack)|downgrade\w*|outflow\w*|decline\w*|weak(?:er)? than expected|slowdown|recession|crash\w*)\b/i,
]

const NEGATORS = /\b(no|not|isn't|isn’t|won't|won’t|denies|denied|rejects?|refutes?)\b/i

export function lexiconScore(title: string): ScoredHeadline {
  let bull = 0
  let bear = 0
  for (const re of BULL_PATTERNS) if (re.test(title)) bull++
  for (const re of BEAR_PATTERNS) if (re.test(title)) bear++
  const negated = NEGATORS.test(title)
  if (negated) { const t = bull; bull = bear; bear = t }
  const total = bull + bear
  if (total === 0) {
    return { label: 'neutral', score: 0, confidence: 0.3, engine: FALLBACK_ENGINE }
  }
  const score = clampScore((bull - bear) / total)
  return {
    label: labelOf(score),
    score,
    confidence: Math.min(0.85, 0.45 + 0.15 * total),
    engine: FALLBACK_ENGINE,
  }
}

// ---------------------------------------------------------------------------
// LLM batch scorer (primary)
// ---------------------------------------------------------------------------

const BATCH_SIZE = 20

const SYSTEM_PROMPT =
  'You are a financial news sentiment annotator, in the role of a FinBERT-equivalent ' +
  'finance NLP engine. For each headline, judge the sentiment it expresses ABOUT THE ' +
  'NAMED COMPANY OR ASSET and its likely short-horizon (1-5 day) directional implication ' +
  'for its stock/price. Ignore sentiment about the broader market unless it directly ' +
  'involves the asset. Respond with STRICT JSON only: a JSON array, one object per ' +
  'input line, in order: [{"i":<line index>,"label":"positive"|"negative"|"neutral",' +
  '"score":<-1..1>,"confidence":<0..1>}]. No markdown, no commentary.'

let zaiPromise: Promise<unknown> | null = null

async function getZai() {
  if (!zaiPromise) {
    zaiPromise = (async () => {
      const mod = await import('z-ai-web-dev-sdk')
      const ZAI = (mod as unknown as { default: unknown }).default ?? (mod as unknown)
      return await (ZAI as { create(): Promise<unknown> }).create()
    })()
  }
  return zaiPromise
}

function extractJsonArray(text: string): unknown[] | null {
  if (!text) return null
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1))
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Rate-limit discipline: the scoring endpoint 429s when concurrent batches
// pile up (measured on a 3-symbol inline scan). Every batch rides a single-
// file queue with a small gap, and a 429 gets one retry after a real backoff.
// ---------------------------------------------------------------------------
let llmQueue: Promise<void> = Promise.resolve()
const BATCH_GAP_MS = 400
const RATE_LIMIT_BACKOFF_MS = 2500

function enqueueLlm<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmQueue.then(fn, fn)
  const gap = () => new Promise<void>((r) => setTimeout(r, BATCH_GAP_MS))
  llmQueue = run.then(gap, gap)
  return run
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** One LLM batch call with 429-aware retry. Throws only after the retry. */
async function callLlmBatch(userMsg: string): Promise<string> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await enqueueLlm(async () => {
        const zai = await getZai()
        const completion = await (zai as any).chat.completions.create({
          messages: [
            { role: 'assistant', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          thinking: { type: 'disabled' },
        })
        const content = (completion as any)?.choices?.[0]?.message?.content
        if (typeof content !== 'string' || content.length === 0) throw new Error('empty LLM response')
        return content
      })
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      // only a rate limit is worth a retry — anything else fails fast
      if (!msg.includes('429') && !msg.toLowerCase().includes('too many requests')) throw e
      await sleep(RATE_LIMIT_BACKOFF_MS)
    }
  }
  throw lastErr
}

/** Score a batch of headlines with the LLM; falls back to the lexicon
 *  engine headline-by-headline on any failure. Never throws. */
export async function scoreHeadlines(titles: string[]): Promise<ScoredHeadline[]> {
  if (titles.length === 0) return []
  const out: ScoredHeadline[] = new Array(titles.length)

  // process in batches, tolerating per-batch failure
  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE)
    let scored = false
    try {
      const userMsg = batch.map((t, j) => `${i + j}. ${t.replace(/\s+/g, ' ').slice(0, 280)}`).join('\n')
      const content = await callLlmBatch(userMsg)
      const arr = extractJsonArray(content)
      if (arr) {
        for (const item of arr) {
          const it = item as Record<string, any>
          const idx = Number(it?.i)
          if (!Number.isFinite(idx) || idx < i || idx >= i + batch.length) continue
          const label = it?.label
          const score = clampScore(Number(it?.score))
          const conf = Math.max(0, Math.min(1, Number(it?.confidence)))
          if (label === 'positive' || label === 'negative' || label === 'neutral') {
            out[idx] = {
              label,
              score,
              confidence: Number.isFinite(conf) && conf > 0 ? conf : 0.6,
              engine: SCORER_ENGINE,
            }
          }
        }
        scored = out.slice(i, i + batch.length).every(Boolean)
      }
    } catch {
      scored = false
    }
    if (!scored) {
      for (let j = 0; j < batch.length; j++) {
        if (!out[i + j]) out[i + j] = lexiconScore(batch[j])
      }
    }
  }
  return out.map((s) => s ?? lexiconScore(''))
}
