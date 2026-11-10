import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { cachedJson } from '@/lib/api-cache'
import { getBars, hasAlpacaKeys } from '@/lib/alpaca'

export const dynamic = 'force-dynamic'

// GET /api/market/correlation?symbols=AAPL,MSFT,TSLA[&days=30]
//
// v2.12.33 — price-RETURN correlation matrix for the AI auto-trader's
// concentration gate. The sentiment route's "correlation" is a sentiment→
// return IC (signal quality), NOT symbol↔symbol co-movement — stacking a
// candidate onto a cluster of holdings that all move together is the same
// trade in disguise, and nothing quantified that before.
//
// Data: ~40 daily bars per symbol via the shared getBars (Alpaca 1Day /
// Binance 1d), Pearson correlation of the common return window (min 15
// overlapping sessions). SIM data (keyless demo feed) is reported honestly
// (source 'sim') — the scanner only trusts 'real' rows, a demo matrix must
// never drive a live risk decision. Cached 30 min per symbol-set: the gate
// runs per scan but the annual relationships barely move.
export async function GET(req: Request) {
  try {
    const user = await requireUser()
    const { searchParams } = new URL(req.url)
    const days = Math.min(Math.max(parseInt(searchParams.get('days') || '30', 10) || 30, 14), 90)
    const symbols = (searchParams.get('symbols') || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9./:-]{1,15}$/.test(s))
      .slice(0, 8)
    if (symbols.length < 2) return NextResponse.json({ matrix: {}, source: 'none', computedAt: new Date().toISOString() })
    const keyed = await hasAlpacaKeys(user.id)
    const result = await cachedJson(`corr:${symbols.join(',')}:${days}:${keyed ? 'k' : 'n'}`, 1_800_000, async () => {
      // per-symbol daily return series (concurrency 4 — one bars call each)
      const series = new Map<string, number[]>()
      let i = 0
      let anyReal = false
      const worker = async () => {
        while (i < symbols.length) {
          const sym = symbols[i++]
          try {
            const r = await getBars(sym, '1D', user.id, { lookbackDays: days + 10 })
            const closes = r.bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0)
            const rets: number[] = []
            for (let k = 1; k < closes.length; k++) rets.push(closes[k] / closes[k - 1] - 1)
            if (!r.demo && rets.length >= 16) anyReal = true
            series.set(sym, rets)
          } catch {
            series.set(sym, [])
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, worker))
      // Pearson per pair over the common tail (align from the end — feeds lag)
      const matrix: Record<string, Record<string, number>> = {}
      const pearson = (a: number[], b: number[]): number | null => {
        const n = Math.min(a.length, b.length)
        if (n < 15) return null
        const wa = a.slice(a.length - n)
        const wb = b.slice(b.length - n)
        const ma = wa.reduce((x, y) => x + y, 0) / n
        const mb = wb.reduce((x, y) => x + y, 0) / n
        let num = 0
        let da = 0
        let db = 0
        for (let k = 0; k < n; k++) {
          const xa = wa[k] - ma
          const xb = wb[k] - mb
          num += xa * xb
          da += xa * xa
          db += xb * xb
        }
        return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null
      }
      for (let a = 0; a < symbols.length; a++) {
        matrix[symbols[a]] = {}
        for (let b = 0; b < symbols.length; b++) {
          if (a === b) { matrix[symbols[a]][symbols[b]] = 1; continue }
          const ra = series.get(symbols[a]) ?? []
          const rb = series.get(symbols[b]) ?? []
          const r = pearson(ra, rb)
          if (r != null) matrix[symbols[a]][symbols[b]] = Number(r.toFixed(3))
        }
      }
      return { matrix, source: anyReal ? 'real' : 'sim', computedAt: new Date().toISOString() }
    })
    return NextResponse.json(result)
  } catch (e) {
    return handleError(e)
  }
}
