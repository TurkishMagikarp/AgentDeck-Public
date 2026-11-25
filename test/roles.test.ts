import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { allows, hasOddNumber, requiredRole } from '../server/roles.ts'
import { createUser, deleteUser, sessionHash, setUserRole, userByName, userBySession, userByToken } from '../server/users.ts'

describe('requiredRole', () => {
  test('reading is for viewers, working the board for operators', () => {
    assert.equal(requiredRole('GET', '/api/projects/1/board'), 'viewer')
    assert.equal(requiredRole('GET', '/api/events'), 'viewer')
    assert.equal(requiredRole('PATCH', '/api/issues/5'), 'operator')
    assert.equal(requiredRole('POST', '/api/issues/5/comments'), 'operator')
    assert.equal(requiredRole('POST', '/api/something/new'), 'operator')
  })

  test('what decides what runs or what it costs is for admins', () => {
    for (const [method, path] of [
      ['POST', '/api/projects'],
      ['DELETE', '/api/projects/3'],
      ['POST', '/api/projects/3/agents'],
      ['PATCH', '/api/agents/9'],
      ['POST', '/api/projects/3/webhooks'],
      ['PUT', '/api/providers/anthropic'],
      ['GET', '/api/providers/anthropic/login'],
      ['PUT', '/api/mcp/github'],
      ['GET', '/api/mail'],
      ['GET', '/api/audit'],
      ['POST', '/api/users'],
      ['POST', '/api/blueprint'],
      ['POST', '/api/import'],
      ['POST', '/api/issues/5/raise-cap'],
    ])
      assert.equal(requiredRole(method, path), 'admin', `${method} ${path}`)
  })

  test('an operator may pause a project but not change its settings', () => {
    assert.equal(requiredRole('PATCH', '/api/projects/3', { paused: true }), 'operator')
    assert.equal(requiredRole('PATCH', '/api/projects/3', { paused: true, settings: {} }), 'admin')
    assert.equal(requiredRole('PATCH', '/api/projects/3', {}), 'admin')
    assert.equal(requiredRole('PATCH', '/api/projects/3', null), 'admin')
  })

  test('run logs need an operator, own push devices only a viewer', () => {
    assert.equal(requiredRole('GET', '/api/runs/4/log'), 'operator')
    assert.equal(requiredRole('GET', '/api/runs/4/events'), 'operator')
    assert.equal(requiredRole('POST', '/api/push/subscribe'), 'viewer')
    assert.equal(requiredRole('POST', '/api/logout'), 'viewer')
  })

  test('ids that Number() reads but the rules do not match are refused', () => {
    for (const path of ['/api/projects/0x1', '/api/projects/1e0', '/api/agents/+1', '/api/projects/%201', '/api/runs/1.0/log', '/api/projects/0b1'])
      assert.equal(hasOddNumber(path), true, path)
    for (const path of ['/api/projects/1', '/api/projects/12/agents', '/api/issues/5', '/api/projects/1/lessons/3', '/api/search', '/api/providers/anthropic'])
      assert.equal(hasOddNumber(path), false, path)
  })

  test('approving a gated landing is for admins', () => {
    assert.equal(requiredRole('POST', '/api/issues/5/approve-landing'), 'admin')
  })

  test('roles include the ones below', () => {
    assert.equal(allows('admin', 'operator'), true)
    assert.equal(allows('operator', 'viewer'), true)
    assert.equal(allows('viewer', 'operator'), false)
    assert.equal(allows('operator', 'admin'), false)
  })
})

describe('users', () => {
  test('a user is found by token and by session hash, never by a wrong or empty one', () => {
    const { user, token } = createUser('Ada Test', 'operator')
    assert.match(token, /^adu_/)
    assert.equal(userByToken(token)?.id, user.id)
    assert.equal(userBySession(sessionHash(token))?.id, user.id)
    assert.equal(userByToken(token + 'x'), undefined)
    assert.equal(userByToken(''), undefined)
    assert.equal(userBySession(''), undefined)
    assert.equal(userByName('ada test')?.role, 'operator')
    setUserRole(user.id, 'viewer')
    assert.equal(userByToken(token)?.role, 'viewer')
    deleteUser(user.id)
    assert.equal(userByToken(token), undefined)
  })

  test('names and roles are checked', () => {
    assert.throws(() => createUser('', 'viewer'))
    assert.throws(() => createUser('<script>', 'viewer'))
    assert.throws(() => createUser('Bob', 'root'))
    const { user } = createUser('Bob', 'viewer')
    assert.throws(() => createUser('bob', 'viewer'), /already exists/)
    assert.throws(() => setUserRole(user.id, 'owner'))
    deleteUser(user.id)
  })
})
