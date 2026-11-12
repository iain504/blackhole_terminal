import { repairPlanTp, validatePlanSide } from '../src/lib/ai-trade-gates'
// the wild AAPL case: trigger 231.5, sl 228, model tp 232.5 → rr 0.30, floor 1.88
const t = 231.5, sl = 228
const rawTp = 232.5
const geo = validatePlanSide('buy', 230, t, rawTp, sl)
console.log('model plan: rr=', geo.rr?.toFixed(2), '→ below floor')
const fix = repairPlanTp('buy', t, sl, 1.88)
console.log('repaired tp=', fix?.tp.toFixed(2), 'rr=', fix?.rr, '→ capped?', fix == null)
const recheck = fix ? validatePlanSide('buy', 230, t, fix.tp, sl) : null
console.log('recheck: ok=', recheck?.ok, 'rr=', recheck?.rr?.toFixed(2))
// short side
const sf = repairPlanTp('sell', 99.5, 101.0, 1.6)
console.log('sell repair: tp=', sf?.tp.toFixed(2), 'rr=', sf?.rr)
// absurd risk → null
console.log('wide-risk repair (risk 9% of trigger):', repairPlanTp('buy', 100, 91, 1.5))
