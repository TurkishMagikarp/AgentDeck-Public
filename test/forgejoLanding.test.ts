import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgejoLanding, requiredForgejoChecks, validateForgejoConfig } from '../server/forgejoLanding.ts'

const sha = 'a'.repeat(40)
const config = validateForgejoConfig({
  api: 'http://forgejo-internal:3000/api/v1/',
  origin: 'ssh://git@forgejo-internal:2222/owner/example.git',
  repository: 'owner/example',
  tokenFile: '/run/agentdeck-forgejo/example.token',
  requiredChecks: ['ci/rust', 'ci/windows'],
})

test('Forgejo does not pass missing, unknown, or outdated commit statuses', () => {
  const good = { id: 1, context: 'ci/rust', status: 'success' }
  assert.equal(requiredForgejoChecks(config.requiredChecks, [good]).verdict, 'pending')
  assert.equal(requiredForgejoChecks([], []).verdict, 'pending')
  const windows = { id: 3, context: 'ci/windows', status: 'success' }
  const failure = { ...good, id: 2, status: 'failure' }
  assert.deepEqual(requiredForgejoChecks(config.requiredChecks, [failure, windows, good]), {
    verdict: 'fail',
    failed: ['ci/rust'],
  })
  assert.equal(requiredForgejoChecks(config.requiredChecks, [good, windows]).verdict, 'pass')
})

test('Forgejo config binds the API, SSH repository and nonempty check contexts', () => {
  assert.throws(() => validateForgejoConfig({ ...config, tokenFile: '/etc/passwd' }))
  assert.throws(() => validateForgejoConfig({ ...config, origin: 'ssh://git@forgejo-internal:2222/owner/other.git' }))
  assert.throws(() => validateForgejoConfig({ ...config, requiredChecks: [] }))
  assert.throws(() => validateForgejoConfig({ ...config, api: 'https://key:secret@forgejo-internal/api/v1/' }))
})

test('Forgejo reuses only the correct repository and branch, with the exact approved commit', async () => {
  const repo = { full_name: 'owner/example' }
  const correct = { number: 3, head: { ref: 'agentdeck/AIR-7', sha, repo }, base: { ref: 'main', repo } }
  const different = { ...correct, number: 4, head: { ...correct.head, repo: { full_name: 'fork/example' } } }
  const request: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, 'GET')
    assert.equal(init.redirect, 'error')
    return Response.json([different, correct])
  }
  const forgejo = new ForgejoLanding(config, 'token', request)
  assert.equal(await forgejo.open('agentdeck/AIR-7', 'main', sha, 'Title', 'Body'), 3)
  await assert.rejects(forgejo.open('agentdeck/AIR-7', 'main', 'b'.repeat(40), 'Title', 'Body'), /geprüften/)
})

test('Forgejo merge uses the exact head and never forces missing checks', async () => {
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'http://forgejo-internal:3000/api/v1/repos/owner/example/pulls/7/merge')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      Do: 'merge', head_commit_id: sha, force_merge: false, delete_branch_after_merge: false,
    })
    return new Response(null, { status: 204 })
  }
  await new ForgejoLanding(config, 'token', request).merge(7, sha, 'merge')
})

test('Forgejo counts a pull request as merged only for the exact commit and base', async () => {
  const repo = { full_name: 'owner/example' }
  // After a squash merge Forgejo deletes the branch and reports the head as refs/pull/<n>/head.
  const pull = { number: 9, state: 'closed', merged: true, head: { ref: 'refs/pull/9/head', sha, repo }, base: { ref: 'main', repo } }
  const answer = (value: object): typeof fetch => async () => Response.json(value)
  const merged = (value: object, commit = sha, base = 'main') =>
    new ForgejoLanding(config, 'token', answer(value)).merged(9, commit, base)
  assert.equal(await merged(pull), true)
  assert.equal(await merged(pull, 'b'.repeat(40)), false)
  assert.equal(await merged(pull, sha, 'dev'), false)
  assert.equal(await merged({ ...pull, merged: false }), false)
  assert.equal(await merged({ ...pull, base: { ref: 'main', repo: { full_name: 'fork/example' } } }), false)
})
