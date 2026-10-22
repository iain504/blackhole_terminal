// Round-trip probe for the Task 66 algo config import/export helpers.
import {
  buildAlgoConfigExport, parseAlgoConfigImport, normalizeAlgoRunConfig,
  runToAlgoConfig, algoConfigSummaryName, algoExportFileBase,
  type AlpoRunConfig,
} from '../src/lib/algo-strategies'

let fails = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) fails += 1
  console.log(`${cond ? 'PASS' : 'FAIL'} · ${name}${extra ? ` — ${extra}` : ''}`)
}

const cfg: AlpoRunConfig = {
  symbol: 'tsla', timeframe: '5m', strategy: 'bb-reversion',
  params: { bbPeriod: 25, bbStd: 9, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, allowShort: 1 },
  qty: 10, tpMode: 'pct', tpValue: 1.5, slMode: 'pct', slValue: 1,
  maxTradesDay: 3, rthOnly: true, flattenEod: true, cooldownMin: 0, requireNewSignal: false,
}

// 1. export → JSON → import round-trip (params clamped: bbStd 9 → 4)
const env = buildAlgoConfigExport([{ name: 'My TSLA fade', config: cfg }])
const json = JSON.parse(JSON.stringify(env))
const r1 = parseAlgoConfigImport(json)
check('envelope round-trip: 1 entry', r1.entries.length === 1 && r1.errors.length === 0, JSON.stringify(r1.errors))
check('envelope round-trip: name kept', r1.entries[0]?.name === 'My TSLA fade')
check('envelope round-trip: symbol uppercased', r1.entries[0]?.config.symbol === 'TSLA')
check('envelope round-trip: bbStd clamped to max 4', r1.entries[0]?.config.params.bbStd === 4, `got ${r1.entries[0]?.config.params.bbStd}`)
check('envelope round-trip: bbPeriod kept', r1.entries[0]?.config.params.bbPeriod === 25)
check('envelope round-trip: re-export is byte-stable config', JSON.stringify(r1.entries[0]?.config) === JSON.stringify({ ...cfg, symbol: 'TSLA', params: { ...cfg.params, bbStd: 4 } }))

// 2. bare single config (no envelope)
const r2 = parseAlgoConfigImport(JSON.parse(JSON.stringify(cfg)))
check('bare config accepted', r2.entries.length === 1 && r2.entries[0].name === algoConfigSummaryName(r2.entries[0].config), r2.entries[0]?.name)

// 3. bare array of wrapped entries
const r3 = parseAlgoConfigImport([
  { name: 'A', config: { ...cfg, symbol: 'F' } },
  JSON.parse(JSON.stringify({ ...cfg, strategy: 'vwap-fade', timeframe: '1m', symbol: 'btc/usd', params: {} })),
])
check('array of 2 accepted', r3.entries.length === 2 && r3.errors.length === 0)
check('crypto symbol + slash kept', r3.entries[1]?.config.symbol === 'BTC/USD')
check('empty params → strategy defaults', r3.entries[1]?.config.params.devPct === 0.6, JSON.stringify(r3.entries[1]?.config.params))
check('vwap default allowShort', r3.entries[1]?.config.params.allowShort === 1)

// 4. invalid entries rejected with reasons, valid ones survive
const r4 = parseAlgoConfigImport([
  { ...cfg, strategy: 'nope' },
  { ...cfg, symbol: '' },
  { ...cfg, timeframe: '1h' },
  { ...cfg, qty: 0 },
  { ...cfg, qty: -5 },
  'garbage',
  null,
  { ...cfg },
])
check('7 invalid of 8 rejected', r4.entries.length === 1 && r4.errors.length === 7, `entries=${r4.entries.length} errors=${r4.errors.length}`)
check('unknown strategy reason', /unknown strategy "nope"/.test(r4.errors[0].reason), r4.errors[0].reason)
check('invalid symbol reason', /invalid symbol/.test(r4.errors[1].reason), r4.errors[1].reason)
check('unsupported timeframe reason', /unsupported timeframe "1h"/.test(r4.errors[2].reason), r4.errors[2].reason)
check('bad qty reason', /qty/.test(r4.errors[3].reason), r4.errors[3].reason)

// 5. TP/SL edge cases
const badTp = normalizeAlgoRunConfig({ ...cfg, tpMode: 'pct', tpValue: 0 })
check('pct + invalid TP value → downgraded to none', typeof badTp === 'object' && badTp.tpMode === 'none' && badTp.tpValue === null)
const tpBoth = normalizeAlgoRunConfig({ ...cfg, tpMode: 'pct', tpValue: 250 })
check('TP clamped to 100', typeof tpBoth === 'object' && tpBoth.tpValue === 100)
const tpLow = normalizeAlgoRunConfig({ ...cfg, tpMode: 'pct', tpValue: 0.001 })
check('TP clamped to 0.01 floor', typeof tpLow === 'object' && tpLow.tpValue === 0.01)
const guardOff = normalizeAlgoRunConfig({ ...cfg, rthOnly: false, flattenEod: false, maxTradesDay: 999 })
check('guards off + cap clamped to 50', typeof guardOff === 'object' && guardOff.rthOnly === false && guardOff.flattenEod === false && guardOff.maxTradesDay === 50)
check('allowShort=0 stays bool', JSON.parse(JSON.stringify({ ...cfg, params: { ...cfg.params, allowShort: 0 } })).params.allowShort === 0)
const boolNorm = normalizeAlgoRunConfig({ ...cfg, params: { ...cfg.params, allowShort: 0.4 } })
check('allowShort 0.4 → 0', typeof boolNorm === 'object' && boolNorm.params.allowShort === 0)

// 6. version guard + garbage
const r6 = parseAlgoConfigImport({ kind: 'blackhole-algo-config', version: 99, configs: [] })
check('future envelope version rejected', r6.entries.length === 0 && /unsupported envelope version/.test(r6.errors[0].reason), r6.errors[0]?.reason)
const r6b = parseAlgoConfigImport(undefined)
check('undefined → not valid JSON', r6b.entries.length === 0 && r6b.errors[0].reason === 'not valid JSON')
const r6c = parseAlgoConfigImport('hello')
check('string → not valid JSON', r6c.entries.length === 0 && r6c.errors[0].reason === 'not valid JSON')

// 7. run → config mapping (from an AlgoRunDto-ish row)
const runDto = {
  symbol: 'BTC/USD', timeframe: '15m', strategy: 'orb15',
  params: { orMinutes: 99, onePerSide: 1 }, qty: 0.001,
  tpMode: 'pct', tpValue: 2, slMode: 'none', slValue: null,
  maxTradesDay: 4, rthOnly: false, flattenEod: true,
}
const mapped = runToAlgoConfig(runDto)
check('run mapping: tf kept', mapped.timeframe === '15m')
check('run mapping: orMinutes clamped to 60', mapped.params.orMinutes === 60, `got ${mapped.params.orMinutes}`)
check('run mapping: SL none → null', mapped.slMode === 'none' && mapped.slValue === null)

// 8. file base format
check('file base format', /^blackhole-algo-configs-\d{8}-\d{4}$/.test(algoExportFileBase()), algoExportFileBase())

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
