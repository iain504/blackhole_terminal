import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { getEarningsEvent } from '@/lib/earnings'

export const dynamic = 'force-dynamic'

// GET /api/market/earnings?symbols=AAPL,MSFT — next earnings per symbol for
// the AI Trade engine's win-rate context pack (v2.12.32).
//
// The one calendar event a technical snapshot can never see: an earnings
// report re-prices a stock in a single overnight gap, so an entry 1-2 days
// before the report is a coin flip that owns the gap with no stop that can
// protect it. The AI auto-trader fetches this once per scan (all scan
// symbols in one call) and (a) feeds 「財報: N 天後」 into every verdict
// prompt, (b) HARD-GATES entries inside the danger window (report − 2d …
// report + 20h) — the same FSD discipline the Nebula autopilot uses.
//
// The per-symbol lib is cached (12h when >7d out, 3h when close) with a
// single-flight map, so a scan cadence of 5+ min never re-hits Yahoo.
// Everything FAILS OPEN: crypto / no date / fetch failure → known:false and
// the gate stands down — a missing date must never brick trading.
export async function GET(req: Request) {
  try {
    await requireUser()
    const { searchParams } = new URL(req.url)
    const symbols = (searchParams.get('symbols') || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9./:=_-]{1,15}$/.test(s))
      .slice(0, 30)
    const events: Record<string, { daysAway: number | null; inBlock: boolean; inWarn: boolean; known: boolean; atMs: number | null }> = {}
    if (symbols.length === 0) return NextResponse.json({ events })
    // small worker pool — Yahoo rate-limits bursts (ranking-phase lesson)
    let i = 0
    const worker = async () => {
      while (i < symbols.length) {
        const sym = symbols[i++]
        try {
          const ev = await getEarningsEvent(sym)
          events[sym] = { daysAway: ev.daysAway, inBlock: ev.inBlock, inWarn: ev.inWarn, known: ev.known, atMs: ev.atMs }
        } catch {
          events[sym] = { daysAway: null, inBlock: false, inWarn: false, known: false, atMs: null }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, symbols.length) }, worker))
    return NextResponse.json({ events })
  } catch (e) {
    return handleError(e)
  }
}
