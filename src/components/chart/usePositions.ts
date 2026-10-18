'use client'

// Polls open positions + SL/TP exit orders for one chart symbol.
// Feeds the on-chart position/[SL]/[TP] lines and trade ticket.
import { useCallback, useEffect, useState } from 'react'
import { PositionsData } from './trading-types'

export function useSymbolPositions(symbol: string) {
  const [data, setData] = useState<PositionsData | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/trading/positions?symbol=${encodeURIComponent(symbol)}`)
      if (res.ok) {
        const json = await res.json()
        setData({
          mode: json.mode ?? 'paper',
          positions: json.positions || [],
          exits: json.exits || {},
          pending: json.pending || [],
        })
      } else {
        setData(null)
      }
    } catch {
      /* offline */
    } finally {
      setLoaded(true)
    }
  }, [symbol])

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, 15000)
    const onChanged = () => void refresh()
    window.addEventListener('tt:settings-changed', onChanged)
    window.addEventListener('tt:positions-changed', onChanged)
    return () => {
      clearInterval(timer)
      window.removeEventListener('tt:settings-changed', onChanged)
      window.removeEventListener('tt:positions-changed', onChanged)
    }
  }, [refresh])

  const hasKeys = loaded && data !== null
  return { data, refresh, hasKeys }
}
