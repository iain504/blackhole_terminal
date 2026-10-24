// 404 boundary (Task 3-c) — terminal-styled not-found page with a way back.
// Self-contained (no store imports): this must render even when the app state
// is broken.

const MAX_URL = 120

export default function NotFound() {
  // Truncate the requested path — avoid leaking long/odd URLs into the DOM.
  let path = ''
  if (typeof window !== 'undefined') {
    path = window.location.pathname + window.location.search
    if (path.length > MAX_URL) path = `${path.slice(0, MAX_URL)}…`
  }

  return (
    <div
      className="flex min-h-[70vh] items-center justify-center p-6"
      aria-live="polite"
      role="status"
    >
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80" aria-hidden="true" />
          <span className="font-mono text-xs uppercase tracking-widest text-zinc-400">
            404 · not found
          </span>
        </div>
        <div className="px-5 py-4">
          <p className="font-mono text-sm leading-relaxed text-zinc-200">
            <span className="text-amber-400">▲</span> Route not found
            {path ? <span className="text-zinc-500"> — {path}</span> : null}
          </p>
          <p className="mt-2 font-mono text-xs text-zinc-500">
            This address does not match any terminal route.
          </p>
          <div className="mt-5">
            <a
              href="/"
              className="inline-block rounded-md bg-emerald-600 px-3.5 py-1.5 font-mono text-xs font-medium text-zinc-950 transition-colors hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Back to workspace
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
