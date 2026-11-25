import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Hono } from 'hono'
import { BOARD_CSP, limitBody, MAX_BODY_BYTES, newNonce, securityHeaders, showcaseCsp } from '../server/httpSecurity.ts'
import { showcasePage } from '../server/showcase.ts'

const app = new Hono()
app.use('*', securityHeaders)
app.use('/api/*', limitBody)
app.post('/api/echo', async (c) => c.json({ size: (await c.req.text()).length }))
app.get('/page', (c) => c.html('<p>hi</p>'))
app.get('/show', (c) => {
  const nonce = newNonce()
  return c.html(showcasePage('abcdefgh', nonce), 200, { 'content-security-policy': showcaseCsp(nonce) })
})

describe('security headers', () => {
  test('every response gets the strict board policy and the other headers', async () => {
    const res = await app.request('/page')
    assert.equal(res.headers.get('content-security-policy'), BOARD_CSP)
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('referrer-policy'), 'same-origin')
    assert.match(BOARD_CSP, /script-src 'self'(;|$)/)
    assert.match(BOARD_CSP, /frame-ancestors 'none'/)
  })

  test('the showcase keeps its own policy, and its nonce is on its script and style', async () => {
    const res = await app.request('/show')
    const csp = res.headers.get('content-security-policy')!
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]
    const html = await res.text()
    assert.notEqual(csp, BOARD_CSP)
    assert.ok(html.includes(`<script nonce="${nonce}">`))
    assert.ok(html.includes(`<style nonce="${nonce}">`))
    assert.equal(html.match(/<script/g)!.length, 1)
  })

  test('each showcase response gets a fresh nonce', async () => {
    const one = (await app.request('/show')).headers.get('content-security-policy')
    const two = (await app.request('/show')).headers.get('content-security-policy')
    assert.notEqual(one, two)
  })
})

describe('body limit', () => {
  test('lets normal bodies through', async () => {
    const res = await app.request('/api/echo', { method: 'POST', body: 'x'.repeat(50_000) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).size, 50_000)
  })

  test('refuses a body over the limit with 413', async () => {
    const body = 'x'.repeat(MAX_BODY_BYTES + 1)
    const res = await app.request('/api/echo', {
      method: 'POST',
      body,
      headers: { 'content-length': String(body.length) },
    })
    assert.equal(res.status, 413)
    assert.ok(res.headers.get('content-security-policy'))
  })

  test('refuses an oversized body that comes without content-length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(256 * 1024))
    let sent = 0
    const stream = new ReadableStream({
      pull(controller) {
        if (sent++ < 5) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const res = await app.request('/api/echo', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    assert.equal(res.status, 413)
  })
})
