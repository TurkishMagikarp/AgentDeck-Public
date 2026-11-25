import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requiredRole } from '../server/roles.ts'

test('the spend limit is an admin decision, pausing the fleet and reading the overview are not', () => {
  assert.equal(requiredRole('PUT', '/api/spend-guard'), 'admin')
  assert.equal(requiredRole('POST', '/api/kill-switch'), 'operator')
  assert.equal(requiredRole('GET', '/api/overview'), 'viewer')
})
