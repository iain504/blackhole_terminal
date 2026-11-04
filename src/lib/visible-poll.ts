// v2.11.3 — setInterval that PAUSES while the browser tab is hidden.
//
// The terminal's data tabs (Agent 3s, Positions 10s, Algo/Grid 5s, Strategy
// 20s) used to poll straight through background-tab life: a parked terminal
// in a hidden tab kept firing heavy queries (positions, agent brain, algo
// logs) forever — server CPU, device battery and log noise for a user who
// isn't even looking. This helper skips ticks while document.hidden and fires
// ONE immediate refresh the moment the tab becomes visible again, so the UI
// never shows stale data on return. Cleanup contract is identical to
// setInterval (returns a stop function).
export function visibleAwareInterval(fn: () => void, ms: number): () => void {
  const tick = () => {
    if (!document.hidden) fn()
  }
  const onVis = () => {
    if (!document.hidden) fn()
  }
  const t = setInterval(tick, ms)
  document.addEventListener('visibilitychange', onVis)
  return () => {
    clearInterval(t)
    document.removeEventListener('visibilitychange', onVis)
  }
}
