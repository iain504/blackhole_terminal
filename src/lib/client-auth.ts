'use client';

// Global 401 watcher (v2.7.3, SSR-safe since v2.7.4).
//
// Problem it fixes: the auth gate only runs at page load (/api/auth/me). When
// the server-side session dies UNDER an open terminal — platform DB wipe,
// secret rotation on restart, expiry — the tab keeps rendering every panel
// while every API call 401s: a ghost tab where even LAUNCH FULL SCAN just
// toasts "Unauthorized". The AgentTab's 15s poll made this a storm of dead
// requests with no way out except a manual hard refresh.
//
// Fix: a single window.fetch wrapper (installed once, process-wide) watches
// same-origin /api/* responses; any 401 outside /api/auth/* (those routes own
// their error UX — wrong-password etc. must not trigger it) calls the latest
// registered handler. TerminalRoot registers one that clears the zustand user
// (flips the UI to AuthForms) and toasts, so the user lands on the login
// screen with an explanation instead of a broken terminal.
//
// v2.7.4: `window` must NEVER be touched at module-evaluation time. 'use
// client' does not opt out of SSR — client components are still evaluated on
// the server for the initial HTML, where `window` is undefined, and a
// top-level access crashed every GET / with ReferenceError → 500. All access
// is now resolved lazily at call time (event/request handlers always run in
// a real browser).

type G = typeof window & {
  __tt401PatchedFetch?: typeof fetch
  __tt401Handler?: (url: string) => void
}

function browserGlobal(): G | undefined {
  return typeof window === 'undefined' ? undefined : (window as G)
}

/** Register the handler invoked on a session-death 401. Idempotent per mount.
 *  v2.12.2 — the handler receives the failing request URL: a hosted deployment
 *  that bounces the user to the login screen seconds after sign-in used to be
 *  undiagnosable ("which endpoint 401'd?"). The toast/console now name it. */
export function setUnauthorizedHandler(cb: ((url: string) => void) | undefined): void {
  const g = browserGlobal()
  if (g) g.__tt401Handler = cb
}

/** Patch window.fetch once so every component's fetch is watched for free. */
export function installUnauthorizedWatcher(): void {
  const g = browserGlobal()
  if (!g || g.__tt401PatchedFetch) return
  const prev = g.fetch.bind(g)
  g.__tt401PatchedFetch = prev
  g.fetch = async (input, init) => {
    const res = await prev(input, init)
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String((input as { url?: string })?.url ?? '')
      if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
        console.warn('[tt] 401 from', url, '— firing session-expired handler')
        g.__tt401Handler?.(url)
      }
    } catch {
      // the watcher must never break the caller's response handling
    }
    return res
  }
}
