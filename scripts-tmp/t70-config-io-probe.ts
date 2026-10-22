// Task 70-c probe — config IO v2: envelope round-trip, v1 backward compat,
// rule payload normalization, re-entry field clamps, parse of rules-only and
// mixed files. Run: bun scripts-tmp/t70-config-io-probe.ts
import {
  buildAlgoConfigExport, parseAlgoConfigImport, normalizeAlgoRunConfig,
  normalizeStrategyRuleImport, runToAlgoConfig, ruleToExportEntry,
  strategyRuleSummaryName, strategyRuleConditionSummary,
  type AlpoRunConfig,
} from '../src/lib/algo-strategies'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) } else { fail++; console.log(`FAIL ${name} ${extra}`) }
}

const cfg: AlpoRunConfig = {
  symbol: 'TSLA', timeframe: '5m', strategy: 'orb15',
  params: { orMinutes: 15, onePerSide: 0 },
  qty: 10, sizingMode: 'fixed' as const, riskMoney: null, tpMode: 'pct', tpValue: 1, slMode: 'pct', slValue: 0.5,
  maxTradesDay: 3, rthOnly: true, flattenEod: true,
  cooldownMin: 15, requireNewSignal: true,
}

// ---- v2 envelope round trip ----
const env = buildAlgoConfigExport([{ name: 'ORB · TSLA 5m', config: cfg }])
ok('v2 envelope version', env.version === 2)
ok('v2 envelope rules array present', Array.isArray(env.rules) && env.rules.length === 0)
const back = parseAlgoConfigImport(JSON.parse(JSON.stringify(env)))
ok('v2 round trip entries', back.entries.length === 1)
ok('v2 round trip cooldownMin', back.entries[0]?.config.cooldownMin === 15)
ok('v2 round trip requireNewSignal', back.entries[0]?.config.requireNewSignal === true)
ok('v2 round trip name', back.entries[0]?.name === 'ORB · TSLA 5m')

// ---- v1 backward compat ----
const v1 = { kind: 'blackhole-algo-config', version: 1, exportedAt: 'x', configs: [{ name: 'legacy', config: { ...cfg, cooldownMin: undefined, requireNewSignal: undefined } }] }
const back1 = parseAlgoConfigImport(v1)
ok('v1 imports', back1.entries.length === 1 && back1.errors.length === 0)
ok('v1 defaults cooldownMin 0', back1.entries[0]?.config.cooldownMin === 0)
ok('v1 defaults requireNewSignal false', back1.entries[0]?.config.requireNewSignal === false)

// ---- unsupported future version still rejected ----
const v9 = parseAlgoConfigImport({ kind: 'blackhole-algo-config', version: 9, configs: [] })
ok('v9 rejected', v9.entries.length === 0 && /unsupported envelope version/.test(v9.errors[0]?.reason ?? ''))

// ---- clamps on import ----
const clamped = normalizeAlgoRunConfig({ ...cfg, cooldownMin: 9999, requireNewSignal: true, qty: 7 })
ok('cooldownMin clamped 9999→240', typeof clamped !== 'string' && clamped.cooldownMin === 240)
ok('requireNewSignal strict boolean (string "yes"→false)', typeof normalizeAlgoRunConfig({ ...cfg, requireNewSignal: 'yes' }) !== 'string' && (normalizeAlgoRunConfig({ ...cfg, requireNewSignal: 'yes' }) as AlpoRunConfig).requireNewSignal === false)
const neg = normalizeAlgoRunConfig({ ...cfg, cooldownMin: -5 })
ok('cooldownMin -5→0', typeof neg !== 'string' && neg.cooldownMin === 0)

// ---- run mapping carries the fields ----
const mapped = runToAlgoConfig({ ...cfg, params: JSON.stringify(cfg.params) } as never)
ok('runToAlgoConfig cooldownMin', mapped.cooldownMin === 15 && mapped.requireNewSignal === true)
const mappedLegacy = runToAlgoConfig({ ...cfg, cooldownMin: undefined, requireNewSignal: undefined } as never)
ok('runToAlgoConfig legacy row defaults', mappedLegacy.cooldownMin === 0 && mappedLegacy.requireNewSignal === false)

// ---- rules: valid rsi + macd ----
const rsi = normalizeStrategyRuleImport({
  symbol: 'aapl', kind: 'rsi', condition: 'cross_below', level: 30, timeframe: '1D',
  params: { period: 14 }, action: 'buy', qty: 5, tpMode: 'pct', tpValue: 2, slMode: 'pct', slValue: 1, repeat: true,
})
ok('rsi rule normalized (symbol uppercased)', typeof rsi !== 'string' && rsi.symbol === 'AAPL' && rsi.repeat === true)
ok('rsi rule summary', typeof rsi !== 'string' && strategyRuleSummaryName(rsi) === 'RSI(14) crosses below 30 · 1D · AAPL BUY 5')

const macd = normalizeStrategyRuleImport({
  symbol: 'BTC/USD', kind: 'macd', condition: 'bull_cross', level: 0, timeframe: '1h',
  params: { fast: 12, slow: 26, signal: 9 }, action: 'sell', qty: 0.5, tpMode: 'price', tpValue: 65000, slMode: 'none', slValue: null, repeat: false,
})
ok('macd rule normalized', typeof macd !== 'string' && macd.condition === 'bull_cross')
ok('macd summary contains crossover', typeof macd !== 'string' && /bull crossover/.test(strategyRuleConditionSummary(macd)))

// macd slow<=fast corrected like the create API
const macdFix = normalizeStrategyRuleImport({ kind: 'macd', condition: 'bear_cross', level: 0, timeframe: 'xx', params: { fast: 26, slow: 12 }, symbol: 'MSFT', action: 'sell', qty: 2, tpMode: 'none', slMode: 'none' })
ok('macd slow corrected + tf defaulted', typeof macdFix !== 'string' && macdFix.params.slow === 27 && macdFix.timeframe === '1D')

// ---- rules: rejections mirror POST /api/strategies ----
ok('bad kind rejected', typeof normalizeStrategyRuleImport({ kind: 'ema', symbol: 'A', condition: 'cross_above', level: 1, action: 'buy', qty: 1, tpMode: 'none', slMode: 'none' }) === 'string')
ok('bad action rejected', typeof normalizeStrategyRuleImport({ kind: 'rsi', condition: 'cross_above', level: 50, symbol: 'A', action: 'hold', qty: 1, tpMode: 'none', slMode: 'none' }) === 'string')
ok('rsi level 100 rejected', typeof normalizeStrategyRuleImport({ kind: 'rsi', condition: 'cross_above', level: 100, symbol: 'A', action: 'buy', qty: 1, tpMode: 'none', slMode: 'none' }) === 'string')
ok('qty 0 rejected', typeof normalizeStrategyRuleImport({ kind: 'rsi', condition: 'cross_above', level: 50, symbol: 'A', action: 'buy', qty: 0, tpMode: 'none', slMode: 'none' }) === 'string')
ok('pct >100 rejected', typeof normalizeStrategyRuleImport({ kind: 'rsi', condition: 'cross_above', level: 50, symbol: 'A', action: 'buy', qty: 1, tpMode: 'pct', tpValue: 250, slMode: 'none' }) === 'string')
ok('price 0 rejected', typeof normalizeStrategyRuleImport({ kind: 'rsi', condition: 'cross_above', level: 50, symbol: 'A', action: 'buy', qty: 1, tpMode: 'none', slMode: 'price', slValue: 0 }) === 'string')
ok('bad symbol rejected', typeof normalizeStrategyRuleImport({ kind: 'rsi', condition: 'cross_above', level: 50, symbol: 'A B!', action: 'buy', qty: 1, tpMode: 'none', slMode: 'none' }) === 'string')

// ---- mixed file: configs + rules + skips ----
const mixedEnv = {
  kind: 'blackhole-algo-config', version: 2, exportedAt: 'x',
  configs: [
    { name: 'good', config: cfg },
    { name: 'bad', config: { ...cfg, strategy: 'nope' } },
  ],
  rules: [
    { name: 'r1', rule: { symbol: 'NVDA', kind: 'rsi', condition: 'cross_above', level: 70, timeframe: '15m', params: { period: 7 }, action: 'sell', qty: 3, tpMode: 'pct', tpValue: 1.5, slMode: 'pct', slValue: 1, repeat: false } },
    { name: 'r2-bad', rule: { symbol: 'NVDA', kind: 'rsi', condition: 'cross_below', level: 999, timeframe: '15m', params: {}, action: 'sell', qty: 3, tpMode: 'none', slMode: 'none' } },
  ],
}
const mixed = parseAlgoConfigImport(mixedEnv)
ok('mixed: 1 config valid + 1 skipped', mixed.entries.length === 1 && mixed.errors.length === 1)
ok('mixed: 1 rule valid + 1 skipped', mixed.rules.length === 1 && mixed.ruleErrors.length === 1)
ok('mixed rule name from file', mixed.ruleNames[0] === 'r1')
ok('mixed rule level intact', mixed.rules[0]?.level === 70 && mixed.rules[0]?.params.period === 7)

// ---- rules-only file (no configs) ----
const rulesOnly = parseAlgoConfigImport({ kind: 'blackhole-algo-config', version: 2, exportedAt: 'x', configs: [], rules: [{ rule: { symbol: 'F', kind: 'macd', condition: 'cross_above', level: 5, timeframe: '1D', params: {}, action: 'buy', qty: 1, tpMode: 'none', slMode: 'none' } }] })
ok('rules-only file parses', rulesOnly.entries.length === 0 && rulesOnly.rules.length === 1)

// ---- ruleToExportEntry round trip ----
const exported = ruleToExportEntry(mixedEnv.rules[0].rule as never)
ok('ruleToExportEntry works', typeof exported !== 'string' && exported.name.startsWith('RSI(7)'))
const re = parseAlgoConfigImport(buildAlgoConfigExport([], [exported as never]))
ok('export→import rule round trip', re.rules.length === 1 && re.rules[0]?.symbol === 'NVDA' && re.rules[0]?.tpMode === 'pct')

console.log(`\n${pass} PASS · ${fail} FAIL`)
process.exit(fail > 0 ? 1 : 0)
