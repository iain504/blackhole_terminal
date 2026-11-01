// v2.5.0 — Market Sentiment Engine shared types (server libs + API DTOs).
//
// Architecture (mirrors the Financial-Sentiment-Dashboard reference design,
// rebuilt natively for this stack):
//   • Ingestion   — free news RSS (Google News per-symbol feeds; provider list
//                   is pluggable so Yahoo RSS / Reddit can be re-enabled later)
//   • NLP engine  — LLM finance scorer (the FinBERT slot) with an offline
//                   finance-lexicon fallback so scoring never hard-fails
//   • Storage     — SentimentHeadline (article-level) + SentimentScore
//                   (hourly aggregate) in the app's own Prisma store
//   • Evaluation  — sentiment vs forward returns: cross-sectional IC / Rank-IC
//                   (Spearman) computed against the app's own daily bars

export type SentimentLabel = 'positive' | 'negative' | 'neutral'

export interface SentimentHeadlineDto {
  id: string
  symbol: string
  source: string
  publisher: string | null
  title: string
  url: string
  publishedAt: string | null
  label: SentimentLabel | null
  score: number | null
  confidence: number | null
  engine: string | null
}

export interface SentimentSymbolSummary {
  symbol: string
  score: number // -1..1 recency×confidence weighted
  momentum: number | null // delta vs previous hourly bucket
  bull: number
  bear: number
  neutral: number
  headlines: number
  engine: string
  asOf: string
  stale: boolean // older than 12h
}

export interface SentimentScanState {
  running: boolean
  done: number
  total: number
  current: string | null
  headlines: number
  scored: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface SentimentIcRow {
  symbol: string
  score: number // latest sentiment
  fwd1dPct: number | null // next-day return after the sentiment bucket
  pairs: number // sentiment/return pairs available in the window
  corr: number | null // per-symbol time-series Pearson corr
  rankCorr: number | null // per-symbol Spearman
}

export interface SentimentIcResult {
  ic: number | null // cross-sectional Pearson: sentiment vs fwd 1d return
  rankIc: number | null // cross-sectional Spearman
  symbols: number
  pairs: number
  windowDays: number
  note: string
  rows: SentimentIcRow[]
}
