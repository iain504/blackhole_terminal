// POST /api/algo/rules-import (Task 70-c) — recreate StrategyRule rows from a
// v2 algo-config export file. Imported rules are ALWAYS created as 'paused'
// (never auto-armed): the user reviews them in the Strategy Orders drawer and
// arms them deliberately, so importing a file can never place an order.
//
// body: { rules: AlgoRuleImportPayload[] } (validated again server-side —
// every item passes through the same normalizeStrategyRuleImport the client
// used, so a hand-crafted request cannot create out-of-band rules either).
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { readJson, handleError } from '@/lib/api-helpers'
import { normalizeStrategyRuleImport } from '@/lib/algo-strategies'

export const dynamic = 'force-dynamic'

const MAX_RULES = 50 // same per-user cap as POST /api/strategies

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await readJson<{ rules?: unknown }>(req)
    const items = Array.isArray(body?.rules) ? body.rules : []
    if (items.length === 0) {
      return NextResponse.json({ error: 'No rules in payload' }, { status: 400 })
    }
    // Task 89 — cap the payload BEFORE iterating it: the validation loop used
    // to run over the raw array unbounded (body-size permitting), burning CPU
    // on the shared process for a request that could never create 50 rules.
    if (items.length > 100) {
      return NextResponse.json({ error: 'Too many rules in payload — the limit is 100 per import' }, { status: 400 })
    }
    const existing = await db.strategyRule.count({ where: { userId: user.id } })
    if (existing >= MAX_RULES) {
      return NextResponse.json({ error: `Strategy limit reached (${MAX_RULES})` }, { status: 400 })
    }

    let created = 0
    const failed: { index: number; reason: string }[] = []
    for (let i = 0; i < items.length; i++) {
      if (existing + created >= MAX_RULES) {
        failed.push({ index: i, reason: `Strategy limit reached (${MAX_RULES})` })
        continue
      }
      const norm = normalizeStrategyRuleImport(items[i])
      if (typeof norm === 'string') {
        failed.push({ index: i, reason: norm })
        continue
      }
      try {
        await db.strategyRule.create({
          data: {
            userId: user.id,
            // Task 89 — imported rules are PINNED paper like every other rule
            mode: 'paper',
            symbol: norm.symbol,
            kind: norm.kind,
            condition: norm.condition,
            level: norm.level,
            timeframe: norm.timeframe,
            params: norm.params as unknown as object,
            action: norm.action,
            qty: norm.qty,
            tpMode: norm.tpMode,
            tpValue: norm.tpValue,
            tpTf: norm.tpTf ?? null,
            slMode: norm.slMode,
            slValue: norm.slValue,
            slTf: norm.slTf ?? null,
            repeat: norm.repeat,
            status: 'paused', // NEVER auto-arm imported rules
            lastSide: null,
            fireNote: 'Imported from config file — review and arm',
          },
        })
        created++
      } catch {
        failed.push({ index: i, reason: 'could not create the rule' })
      }
    }
    return NextResponse.json({ created, failed })
  } catch (e) {
    return handleError(e)
  }
}
