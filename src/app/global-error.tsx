'use client'

// Global error boundary (Task 3-c) — last-resort shell for errors thrown by
// the root layout / outside any route segment. Renders its OWN <html><body>
// with INLINE STYLES only: when this fires, global CSS / fonts / Tailwind may
// not have loaded at all. Self-contained — no imports beyond react.
import { useEffect } from 'react'

const MAX_MSG = 300

function truncate(msg: string) {
  const clean = msg.replace(/\s+/g, ' ').trim() || 'Unknown error'
  return clean.length > MAX_MSG ? `${clean.slice(0, MAX_MSG)}…` : clean
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[global-error]', error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: '#09090b',
          color: '#e4e4e7',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        }}
      >
        <div
          role="alert"
          aria-live="polite"
          style={{
            width: '100%',
            maxWidth: 520,
            border: '1px solid #7f1d1d',
            borderRadius: 8,
            background: '#0c0a09',
            padding: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 16px',
              borderBottom: '1px solid #27272a',
              fontSize: 11,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#a1a1aa',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#ef4444',
                display: 'inline-block',
              }}
            />
            terminal error
            {error.digest ? (
              <span style={{ marginLeft: 'auto', fontSize: 10, color: '#52525b' }}>
                digest {error.digest}
              </span>
            ) : null}
          </div>
          <div style={{ padding: '16px 20px' }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#e4e4e7' }}>
              <span style={{ color: '#f87171' }}>✗</span> {truncate(error.message)}
            </p>
            <p style={{ margin: '8px 0 0', fontSize: 12, color: '#71717a' }}>
              The application crashed while rendering. Reload to restore the workspace.
            </p>
            <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={reset}
                style={{
                  background: '#059669',
                  color: '#09090b',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Reload workspace
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  background: 'transparent',
                  color: '#d4d4d8',
                  border: '1px solid #3f3f46',
                  borderRadius: 6,
                  padding: '8px 14px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Hard reload page
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
