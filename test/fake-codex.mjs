// Stands in for `codex app-server` in the tests. Answers the JSON-RPC requests AgentDeck sends
// and writes every request it got to FAKE_CODEX_LOG. FAKE_CODEX_STATE holds what it reports.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const state = JSON.parse(readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'))
const answer = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(message) + '\n')
  if (message.method === 'initialize') return answer(message.id, { userAgent: 'fake' })
  if (message.method === 'account/rateLimits/read')
    return answer(message.id, {
      rateLimits: { primary: state.primary },
      rateLimitResetCredits: { availableCount: state.available, credits: [] },
    })
  if (message.method === 'account/rateLimitResetCredit/consume') {
    if (state.available < 1) return answer(message.id, { outcome: 'noCredit' })
    state.available -= 1
    state.primary = { ...state.primary, usedPercent: 0 }
    writeFileSync(process.env.FAKE_CODEX_STATE, JSON.stringify(state))
    return answer(message.id, { outcome: 'reset' })
  }
  if (message.id != null)
    process.stdout.write(JSON.stringify({ id: message.id, error: { message: 'unknown' } }) + '\n')
})
