'use client';

// Global 401 watcher (v2.7.3).
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

const g = window as typeof window & {
  __tt401PatchedFetch?: typeof fetch
  __tt401Handler?: () => void
}

/** Register the handler invoked on a session-death 401. Idempotent per mount. */
export function setUnauthorizedHandler(cb: (() => void) | undefined): void {
  g.__tt401Handler = cb
}

/** Patch window.fetch once so every component's fetch is watched for free. */
export function installUnauthorizedWatcher(): void {
  if (typeof window === 'undefined' || g.__tt401PatchedFetch) return
  const prev = window.fetch.bind(window)
  g.__tt401PatchedFetch = prev
  window.fetch = async (input, init) => {
    const res = await prev(input, init)
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String((input as { url?: string })?.url ?? '')
      if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
        g.__tt401Handler?.()
      }
    } catch {
      // the watcher must never break the caller's response handling
    }
    return res
  }
}
