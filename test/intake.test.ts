import './setup.ts'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, test } from 'node:test'
import { mergeSettings } from '../server/core.ts'
import { all, get, run } from '../server/db.ts'
import { webhookApp } from '../server/githubWebhook.ts'
import { takeGithubIssue } from '../server/intake.ts'

function project(key: string, intake: unknown) {
  return Number(
    run(
      'INSERT INTO projects (key, name, settings, created_at) VALUES (?, ?, ?, ?)',
      key,
      key,
      JSON.stringify({ intake }),
      Date.now(),
    ).lastInsertRowid,
  )
}

const labeled = (over: Record<string, unknown> = {}, issue: Record<string, unknown> = {}) => ({
  action: 'labeled',
  label: { name: 'agentdeck' },
  repository: { full_name: 'acme/shop' },
  issue: {
    number: 42,
    title: 'Cart loses items on reload',
    body: 'Steps: add two items, reload.',
    state: 'open',
    html_url: 'https://github.com/acme/shop/issues/42',
    user: { login: 'mona' },
    ...issue,
  },
  ...over,
})

const shop = project('IN-A', { enabled: true, repo: 'acme/shop', label: 'agentdeck', status: 'backlog' })
const eager = project('IN-B', { enabled: true, repo: 'Acme/Shop', label: 'AgentDeck', status: 'todo' })
project('IN-C', { enabled: false, repo: 'acme/shop' })
project('IN-D', { enabled: true, repo: 'acme/other' })

describe('settings', () => {
  test('intake stays off without a repository in owner/name form', () => {
    assert.equal(mergeSettings({ intake: { enabled: true, repo: 'not a repo' } }).intake.enabled, false)
    assert.equal(mergeSettings({ intake: { enabled: true, repo: 'acme/shop' } }).intake.enabled, true)
    assert.equal(mergeSettings({}).intake.label, 'agentdeck')
    assert.equal(mergeSettings({ intake: { status: 'done' } }).intake.status, 'backlog')
  })
})

describe('labelled GitHub issues', () => {
  test('are filed once in every project that takes the repository and label', () => {
    const taken = takeGithubIssue(labeled())
    assert.deepEqual(taken.map((entry) => entry.projectId).sort(), [shop, eager].sort())

    const filed = get('SELECT * FROM issues WHERE project_id=?', shop)
    assert.equal(filed.title, 'Cart loses items on reload')
    assert.equal(filed.status, 'backlog')
    assert.equal(filed.created_by, 'GitHub')
    assert.equal(filed.source, 'https://github.com/acme/shop/issues/42')
    assert.match(filed.description, /acme\/shop#42.*mona/)
    assert.match(filed.description, /add two items/)
    assert.equal(get('SELECT status FROM issues WHERE project_id=?', eager).status, 'todo')

    // GitHub delivers again (label removed and set again, a redelivery): nothing new.
    assert.deepEqual(takeGithubIssue(labeled()), [])
    assert.equal(all('SELECT 1 FROM issues WHERE project_id=?', shop).length, 1)
  })

  test('other labels, actions, pull requests and closed issues are ignored', () => {
    const fresh = { html_url: 'https://github.com/acme/shop/issues/43', number: 43 }
    assert.deepEqual(takeGithubIssue(labeled({ label: { name: 'bug' } }, fresh)), [])
    assert.deepEqual(takeGithubIssue(labeled({ action: 'opened' }, fresh)), [])
    assert.deepEqual(takeGithubIssue(labeled({}, { ...fresh, pull_request: {} })), [])
    assert.deepEqual(takeGithubIssue(labeled({}, { ...fresh, state: 'closed' })), [])
    assert.deepEqual(takeGithubIssue(labeled({}, { ...fresh, html_url: 'https://example.com/x' })), [])
    assert.deepEqual(takeGithubIssue(null), [])
  })

  test('a very long body is cut', () => {
    const taken = takeGithubIssue(
      labeled(
        {},
        { number: 44, html_url: 'https://github.com/acme/shop/issues/44', body: 'x'.repeat(50_000) },
      ),
    )
    const filed = get('SELECT description FROM issues WHERE id=?', taken[0].issueId)
    assert.ok(filed.description.length < 19_000)
    assert.match(filed.description, /\(cut\)/)
  })
})

describe('webhook', () => {
  const SECRET = 'a-webhook-secret-of-some-length'
  test('a signed issues delivery reaches the intake, an unsigned one does not', async () => {
    const seen: unknown[] = []
    const app = webhookApp(
      SECRET,
      () => {},
      (payload) => void seen.push(payload),
    )
    const body = JSON.stringify(labeled())
    const headers = { 'content-type': 'application/json', 'x-github-event': 'issues' }
    assert.equal((await app.request('/webhook', { method: 'POST', headers, body })).status, 401)
    const signature = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex')
    const signed = await app.request('/webhook', {
      method: 'POST',
      headers: { ...headers, 'x-hub-signature-256': signature },
      body,
    })
    assert.equal(signed.status, 200)
    assert.equal(seen.length, 1)
  })
})
