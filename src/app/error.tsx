'use client'

// Route-segment error boundary (Task 3-c) — a render throw anywhere in the
// terminal (e.g. the 4,866-line ChartPanel) must never white-screen the app.
// Self-contained on purpose: NO store/external imports here — the boundary
// itself must be the one component that cannot throw again.
import { useEffect } from 'react'

const MAX_MSG = 300

function truncate(msg: string) {
  const clean = msg.replace(/\s+/g, ' ').trim() || 'Unknown error'
  return clean.length > MAX_MSG ? `${clean.slice(0, MAX_MSG)}…` : clean
}

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Surface the full stack in the console for debugging (the card shows only
    // a truncated message — digests may be redacted in prod).
    console.error('[error-boundary]', error)
  }, [error])

  return (
    <div
      className="flex min-h-[60vh] items-center justify-center p-6"
      aria-live="polite"
      role="alert"
    >
      <div className="w-full max-w-lg rounded-lg border border-red-900/60 bg-zinc-950 shadow-xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" aria-hidden="true" />
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">
            runtime error
          </span>
          {error.digest ? (
            <span className="ml-auto font-mono text-[10px] text-zinc-600">
              digest {error.digest}
            </span>
          ) : null}
        </div>
        <div className="px-5 py-4">
          <p className="font-mono text-sm leading-relaxed text-zinc-200">
            <span className="text-red-400">✗</span> {truncate(error.message)}
          </p>
          <p className="mt-2 font-mono text-xs text-zinc-500">
            The workspace hit an unexpected error. Your data is safe — reload to continue.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md bg-emerald-600 px-3.5 py-1.5 font-mono text-xs font-medium text-zinc-950 transition-colors hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Reload workspace
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-zinc-700 px-3.5 py-1.5 font-mono text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Hard reload page
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
