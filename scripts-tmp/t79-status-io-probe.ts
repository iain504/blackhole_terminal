import { buildAlgoConfigExport, parseAlgoConfigImport } from '@/lib/algo-strategies'
const cfg = {
  symbol: 'TSLA', timeframe: '5m' as const, strategy: 'bb-reversion' as const,
  params: {}, qty: 10, sizingMode: 'risk' as const, riskBasis: 'pct' as const,
  riskMoney: null, riskMoneyPct: 1, tpMode: 'pct' as const, tpValue: 2,
  slMode: 'pct' as const, slValue: 1, maxTradesDay: 3, rthOnly: true,
  flattenEod: true, cooldownMin: 0, requireNewSignal: false,
}
const env = buildAlgoConfigExport([
  { name: 'A', config: cfg, enabled: true },
  { name: 'B', config: { ...cfg, symbol: 'AAPL', sizingMode: 'fixed' as const, riskBasis: 'usd' as const, riskMoney: null, riskMoneyPct: null }, enabled: false },
])
const res = parseAlgoConfigImport(env)
console.log('entries:', res.entries.length, 'errors:', res.errors.length)
console.log('A enabled:', res.entries[0].enabled, '| B enabled:', res.entries[1].enabled)
const legacy = JSON.parse(JSON.stringify(env))
delete legacy.configs[0].enabled
delete legacy.configs[1].enabled
const res2 = parseAlgoConfigImport(legacy)
console.log('legacy A enabled:', res2.entries[0].enabled, '| legacy B enabled:', res2.entries[1].enabled)
const res3 = parseAlgoConfigImport(cfg)
console.log('bare:', res3.entries.length, 'enabled:', res3.entries[0].enabled)
const res4 = parseAlgoConfigImport([{ name: 'C', config: cfg, enabled: false }])
console.log('array-wrapped:', res4.entries.length, 'enabled:', res4.entries[0].enabled)
