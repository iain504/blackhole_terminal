"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polling data hook: runs `fetcher` immediately on mount / deps change,
 * then re-runs it on an interval. In-flight calls are never overlapped.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: React.DependencyList,
  enabled = true
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    // reset stale data whenever deps change (not on interval polls)
    setLoading(true);
    setData(null);
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const d = await fetcherRef.current();
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Request failed");
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    const id = setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [...deps, enabled, tick, intervalMs]);

  return { data, error, loading, refresh };
}
