// v2.5.0 — Sentiment↔price evaluation API.
//   GET /api/sentiment/correlation?days=30
//       → cross-sectional IC / Rank-IC + per-symbol sentiment/return rows
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { handleError } from '@/lib/api-helpers'
import { computeSentimentIc } from '@/lib/sentiment-engine'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('days') || '30', 10) || 30, 7), 90)
    const result = await computeSentimentIc(user.id, days)
    return NextResponse.json(result)
  } catch (e) {
    return handleError(e)
  }
}
