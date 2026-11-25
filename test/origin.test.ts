import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCrossSiteWrite } from '../server/origin.ts'

const headers = (values: Record<string, string>) => (name: string) => values[name]

test('same-origin writes pass, also behind a proxy that forwards the host', () => {
  assert.equal(isCrossSiteWrite('POST', headers({ origin: 'https://agents.example.org', host: 'agents.example.org' })), false)
  assert.equal(
    isCrossSiteWrite('PATCH', headers({ origin: 'https://agents.example.org', host: '127.0.0.1:8790', 'x-forwarded-host': 'agents.example.org' })),
    false,
  )
})

test('a write from another site is refused', () => {
  assert.equal(isCrossSiteWrite('POST', headers({ origin: 'https://evil.example', host: 'agents.example.org' })), true)
  assert.equal(isCrossSiteWrite('DELETE', headers({ origin: 'https://agents.example.org.evil.example', host: 'agents.example.org' })), true)
  assert.equal(isCrossSiteWrite('POST', headers({ origin: 'null', host: 'agents.example.org' })), true)
})

test('reads, token calls and requests without an origin pass', () => {
  assert.equal(isCrossSiteWrite('GET', headers({ origin: 'https://evil.example', host: 'a' })), false)
  assert.equal(isCrossSiteWrite('POST', headers({ host: 'agents.example.org' })), false)
  assert.equal(isCrossSiteWrite('POST', headers({ origin: 'https://evil.example', host: 'a', authorization: 'Bearer x' })), false)
  assert.equal(
    isCrossSiteWrite('POST', headers({ origin: 'https://evil.example', host: 'a', authorization: 'Bearer x', cookie: 'agentdeck_session=1' })),
    true,
    'a header next to a session cookie does not exempt the request',
  )
})

test('Sec-Fetch-Site decides when the browser sends it, whatever the proxy does to Host', () => {
  assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'same-origin', origin: 'https://a.example', host: '127.0.0.1:8790' })), false)
  assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'cross-site', host: 'a.example' })), true)
  assert.equal(isCrossSiteWrite('POST', headers({ 'sec-fetch-site': 'same-site', host: 'a.example' })), true)
})
