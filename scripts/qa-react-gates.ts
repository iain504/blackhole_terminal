// v2.12.38 QA — react-mode gate math with realistic structural plans.
import { validatePlanSide, dynamicThresholds } from '../src/lib/ai-trade-gates'
import { AI_AUTO_DEFAULT_CONFIG, baseThresholds, sanitizeAiAutoConfig } from '../src/store/ai-auto-trade'

const fmt = (ok: boolean, rr: number | null, reason: string | null) => `${ok ? 'PASS' : 'FAIL'} rr=${rr?.toFixed(2) ?? '—'} ${reason ?? ''}`

// OLD gates: everything below dies (confidence 30 < 60, R:R < 7)
console.log('== OLD unified gate (60% / 1:7) ==')
console.log(' plan A conf=30 → confidence gate:', 30 >= 60 ? 'PASS' : 'FAIL (信心未達 60%)')

// NEW react gates
const cfg = sanitizeAiAutoConfig({}) // defaults → react mode
const base = baseThresholds(cfg)
console.log('\n== NEW react gates (defaults) ==', base)

const ref = 100
// realistic plans the model is now told to produce
const plans = [
  { name: 'A tight-trigger breakout', side: 'buy' as const, trigger: 100.5, tp: 104.0, sl: 99.0 },
  { name: 'B moderate breakout',      side: 'buy' as const, trigger: 101.0, tp: 104.5, sl: 99.5 },
  { name: 'C wide chase (band ok)',   side: 'buy' as const, trigger: 103.0, tp: 106.0, sl: 100.5 },
  { name: 'D breakdown short',        side: 'sell' as const, trigger: 99.5, tp: 96.0, sl: 101.0 },
  { name: 'E too-far trigger',        side: 'buy' as const, trigger: 106.0, tp: 109.0, sl: 103.5 },
]
for (const p of plans) {
  const geo = validatePlanSide(p.side, ref, p.trigger, p.tp, p.sl)
  const confOk = 45 >= base.minConfidence
  const rrOk = geo.ok && geo.rr != null && geo.rr >= base.minRR
  console.log(` ${p.name}: geo=${fmt(geo.ok, geo.rr, geo.reason)} · conf45≥${base.minConfidence}:${confOk ? 'PASS' : 'FAIL'} · rr≥${base.minRR}:${rrOk ? 'PASS' : 'FAIL'} → plan ${geo.ok && confOk && rrOk ? 'CREATED' : 'REJECTED'}`)
}

// against-the-wind surcharge still applies
const dyn = dynamicThresholds(base.minConfidence, base.minRR, 'RISK_OFF', 'long')
console.log('\n== RISK_OFF long surcharge ==', dyn.minConfidence, dyn.minRR, '·', dyn.note)

// old saved config (no react fields) migrates to the softer defaults
const old = sanitizeAiAutoConfig({ minConfidence: 60, minRR: 7, entryMode: 'react' })
console.log('\n== old stored config migration ==', JSON.stringify(baseThresholds(old)))

// instant mode keeps 60/7
const inst = sanitizeAiAutoConfig({ entryMode: 'instant' })
console.log('== instant keeps strict gates ==', JSON.stringify(baseThresholds(inst)))
