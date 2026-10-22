// Task 61 research: algo strategies for regular trading hours / Stage 3 (Weinstein topping-distribution) stocks
import ZAI from 'z-ai-web-dev-sdk'

const queries = [
  'best intraday algorithmic trading strategies for range-bound sideways stocks regular trading hours',
  'Stan Weinstein stage 3 topping distribution phase trading strategy how to trade',
  'github RSI-2 mean reversion strategy Larry Connors intraday backtest results',
  'opening range breakout strategy 15 minute ORB stocks youtube proven rules',
  'Bollinger Band mean reversion intraday strategy RSI filter range market',
]

const zai = await ZAI.create()
for (const q of queries) {
  try {
    const r = await zai.functions.invoke('web_search', { query: q, num: 6 })
    console.log('\n#### QUERY:', q)
    for (const it of r) console.log(`- [${it.host_name}] ${it.name}\n  ${String(it.snippet || '').slice(0, 300)}`)
  } catch (e) {
    console.log('ERR', q, e?.message)
  }
}
