'use client'

// News panel: single-column feed (Task 13 #1) — symbol news or all markets.
import { useEffect, useState } from 'react'
import { NewsItem } from '@/lib/market-types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ExternalLink, Newspaper } from 'lucide-react'

export function NewsPanel({ symbol }: { symbol: string }) {
  const [scope, setScope] = useState<'symbol' | 'all'>('symbol')
  const [data, setData] = useState<{ key: string; news: NewsItem[] }>({ key: '', news: [] })
  const key = `${symbol}|${scope}`
  const loading = data.key !== key

  useEffect(() => {
    let alive = true
    const fetchNews = async () => {
      try {
        const q = scope === 'symbol' ? `symbol=${encodeURIComponent(symbol)}` : 'symbol=ALL'
        const res = await fetch(`/api/market/news?${q}&limit=30`)
        if (!res.ok || !alive) return
        const json = await res.json()
        if (alive) {
          setData({ key, news: (json.news as NewsItem[]) || [] })
        }
      } catch { /* offline */ }
    }
    fetchNews()
    const timer = setInterval(fetchNews, 60000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [key, scope, symbol])

  const news = data.news

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-800/60 px-2 py-1.5">
        {(
          [
            { key: 'symbol' as const, label: symbol },
            { key: 'all' as const, label: 'All markets' },
          ]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setScope(key)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] transition-colors',
              scope === key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0">
        {loading && <p className="px-2 py-6 text-center text-[11px] text-zinc-500">Loading news…</p>}
        {!loading && news.length === 0 && (
          <div className="px-2 py-6 text-center text-[11px] text-zinc-500">
            <Newspaper className="mx-auto mb-1 h-4 w-4" />
            No news found
          </div>
        )}
        {/* single column: one card per row */}
        <ul className="divide-y divide-zinc-800/50">
          {news.map((n) => (
            <li key={n.id}>
              <a
                href={n.url === '#' ? undefined : n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex gap-2 px-2 py-2 transition-colors hover:bg-zinc-800/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[12px] leading-4 text-zinc-200">{n.headline}</p>
                  <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-3.5 text-zinc-500">{n.summary}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-600">
                    <span className="text-zinc-500">{n.source}</span>
                    <span>·</span>
                    <span>{timeAgo(n.ts)}</span>
                    {n.url !== '#' && <ExternalLink className="h-2.5 w-2.5" />}
                  </p>
                </div>
                {n.image && (
                  <img
                    src={n.image}
                    alt=""
                    className="h-12 w-16 shrink-0 rounded object-cover"
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                )}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function timeAgo(ts: number): string {
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}
