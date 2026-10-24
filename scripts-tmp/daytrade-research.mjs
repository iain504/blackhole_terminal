// Task 83 research: what indicators / technical drawings does the day-trading
// community actually use? Web search via z-ai-web-dev-sdk (backend only).
import ZAI from 'z-ai-web-dev-sdk'

const queries = [
  'best indicators for day trading reddit community consensus VWAP',
  'most used indicators day trading VWAP opening range breakout volume profile',
  'day trading technical drawings tools support resistance levels premarket high low',
  'what indicators do profitable day traders actually use',
]

const zai = await ZAI.create()
for (const q of queries) {
  try {
    const r = await zai.functions.invoke('web_search', { query: q, num: 8 })
    console.log('\n=== QUERY:', q, '===')
    for (const it of r ?? []) {
      console.log(`- [${it.host_name}] ${it.name}`)
      console.log(`  ${String(it.snippet || '').replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  } catch (e) {
    console.log('SEARCH FAILED:', q, e?.message ?? e)
  }
}
