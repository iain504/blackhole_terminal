// POST /api/alerts/check (Task 3-c) — thin auth + call wrapper around the
// shared evaluation engine (src/lib/alerts-eval.ts). The browser poll keeps
// its exact response shape ({ triggered, checked }); the actual semantics and
// the double-fire-safe claiming now live in the lib so the server-side
// supervisor (src/lib/alerts-supervisor.ts) can run the SAME evaluation with
// the browser closed.
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { evaluateAlerts } from '@/lib/alerts-eval'

export async function POST() {
  try {
    const user = await requireUser()
    const result = await evaluateAlerts(user.id)
    return NextResponse.json(result)
  } catch (e) {
    return handleError(e)
  }
}
