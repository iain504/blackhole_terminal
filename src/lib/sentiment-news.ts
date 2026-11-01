// v2.5.0 — Market Sentiment Engine · news ingestion.
//
// Free, key-less news feeds for the sentiment pipeline. The provider list is
// deliberately pluggable (the reference design lists Yahoo Finance RSS +
// Google News RSS + Reddit): this box probes the live endpoints at build time
// and the unreachable ones stay registered-but-disabled so the engine degrades
// to what actually works instead of hammering 403s every scan.
//
// Measured from this sandbox (2026-11):
//   • Google News RSS   — 200 OK  · primary per-symbol feed
//   • Yahoo RSS (legacy)— 404     · feeds.finance.yahoo.com is dead
//   • Yahoo rssindex    — 429     · rate-limited at the edge
//   • Reddit / StockTwits — 403   · bot-blocked
import type { SentimentLabel } from './sentiment-types'

export interface RawHeadline {
  title: string
  url: string
  publisher: string | null
  publishedAt: Date | null
}

export interface IngestResult {
  fetched: number
  inserted: number
  providers: string[]
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface NewsProvider {
  id: string
  enabled: boolean
  fetch(symbol: string, isCrypto: boolean): Promise<RawHeadline[]>
}

/** Google News RSS — per-symbol search feed. Titles arrive as
 *  "Headline text - Publisher"; the <source> tag carries the publisher. */
const googleNewsProvider: NewsProvider = {
  id: 'google_news_rss',
  enabled: true,
  async fetch(symbol, isCrypto) {
    const coin = symbol.replace(/\/USD$/i, '').replace(/-USD$/i, '')
    const q = isCrypto
      ? `${coin} crypto OR "${coin}"`
      : `"$${symbol}" OR "${symbol} stock"`
    const url =
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
      `&hl=en-US&gl=US&ceid=US:en`
    const xml = await fetchText(url)
    return parseRss(xml)
  },
}

/** Yahoo Finance RSS — registered for completeness; the endpoint is dead
 *  (404) from this box, so it stays disabled until it returns. */
const yahooRssProvider: NewsProvider = {
  id: 'yahoo_finance_rss',
  enabled: false,
  async fetch(symbol) {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`
    const xml = await fetchText(url)
    return parseRss(xml)
  },
}

export const NEWS_PROVIDERS: NewsProvider[] = [googleNewsProvider, yahooRssProvider]

// Re-fetch a symbol at most every 20 minutes — RSS content moves slower and
// Google rate-limits identical queries aggressively.
const FETCH_TTL_MS = 20 * 60 * 1000
const lastFetchAt = new Map<string, number>()

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** Fetch fresh headlines for one symbol and upsert them into the journal.
 *  Returns how many rows were actually inserted (the (symbol,url) unique key
 *  makes repeated scans idempotent). */
export async function ingestSymbolNews(symbol: string, isCrypto: boolean): Promise<IngestResult> {
  const { db } = await import('@/lib/db')
  const key = `${symbol}|${isCrypto ? 'c' : 's'}`
  const last = lastFetchAt.get(key) ?? 0
  if (Date.now() - last < FETCH_TTL_MS) {
    return { fetched: 0, inserted: 0, providers: ['cached'] }
  }
  lastFetchAt.set(key, Date.now())

  const used: string[] = []
  const all: RawHeadline[] = []
  for (const p of NEWS_PROVIDERS) {
    if (!p.enabled) continue
    try {
      const items = await p.fetch(symbol, isCrypto)
      if (items.length > 0) {
        all.push(...items)
        used.push(p.id)
      }
    } catch {
      // one dead provider must never take the scan down
    }
  }

  if (all.length === 0) return { fetched: 0, inserted: 0, providers: used }

  // dedupe by url within the batch, cap 30 headlines per symbol per sweep
  const seen = new Set<string>()
  const rows = all
    .filter((h) => {
      if (!h.title || !h.url || seen.has(h.url)) return false
      seen.add(h.url)
      return true
    })
    .slice(0, 30)
    .map((h) => ({
      symbol,
      source: used[0] ?? 'rss',
      publisher: h.publisher,
      title: h.title.slice(0, 400),
      url: h.url.slice(0, 1000),
      publishedAt: h.publishedAt,
    }))

  // pre-filter already-journaled urls (SQLite's createMany has no
  // skipDuplicates support — dedupe happens here instead)
  const existing = rows.length > 0
    ? await db.sentimentHeadline.findMany({
        where: { symbol, url: { in: rows.map((r) => r.url) } },
        select: { url: true },
      })
    : []
  const have = new Set(existing.map((e) => e.url))
  const fresh = rows.filter((r) => !have.has(r.url))
  let inserted = 0
  if (fresh.length > 0) {
    try {
      const res = await db.sentimentHeadline.createMany({ data: fresh })
      inserted = res.count
    } catch {
      // belt-and-braces fallback for concurrent double-inserts
      for (const r of fresh) {
        try {
          await db.sentimentHeadline.create({ data: r })
          inserted++
        } catch { /* duplicate — fine */ }
      }
    }
  }
  return { fetched: rows.length, inserted, providers: used }
}

// ---------------------------------------------------------------------------
// RSS parsing (dependency-free — the feeds are small, well-formed RSS 2.0)
// ---------------------------------------------------------------------------

export function parseRss(xml: string): RawHeadline[] {
  const out: RawHeadline[] = []
  const items = xml.split(/<item[\s>]/i).slice(1)
  for (const raw of items) {
    const item = raw.slice(0, raw.search(/<\/item>/i) > 0 ? raw.search(/<\/item>/i) : undefined)
    const title = decodeEntities(firstTag(item, 'title'))
    const link = decodeEntities(firstTag(item, 'link'))
    if (!title || !link) continue
    const pub = firstTag(item, 'pubDate')
    const parsed = pub ? new Date(pub) : null
    const sourceTag = firstTagContent(item, 'source')
    // "Headline - Publisher" → strip the trailing publisher when present
    let cleanTitle = title
    let publisher = sourceTag || null
    const dash = cleanTitle.lastIndexOf(' - ')
    if (dash > 20 && dash > cleanTitle.length - 60) {
      const tail = cleanTitle.slice(dash + 3)
      if (!publisher || publisher === tail) {
        publisher = publisher || tail
        cleanTitle = cleanTitle.slice(0, dash)
      }
    }
    out.push({
      title: cleanTitle.trim(),
      url: link.trim(),
      publisher: publisher ? publisher.trim().slice(0, 80) : null,
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    })
  }
  return out
}

function firstTag(xml: string, tag: string): string {
  const open = xml.search(new RegExp(`<${tag}[^>]*>`, 'i'))
  if (open < 0) return ''
  const start = xml.indexOf('>', open) + 1
  const close = xml.toLowerCase().indexOf(`</${tag.toLowerCase()}>`, start)
  return close > start ? xml.slice(start, close) : ''
}

/** <source url="...">Name</source> — tag name must match exactly. */
function firstTagContent(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decodeEntities(m[1]) : ''
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)) } catch { return '' }
    })
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      // polite, identifiable UA — generic bot UAs get harder blocks
      'User-Agent': 'Mozilla/5.0 (compatible; BlackholeTerminal-Sentiment/2.5)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(9000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`rss ${res.status}`)
  return res.text()
}

// label helper shared by the scorer
export function clampScore(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(-1, Math.min(1, v))
}

export function labelOf(score: number): SentimentLabel {
  if (score > 0.15) return 'positive'
  if (score < -0.15) return 'negative'
  return 'neutral'
}
