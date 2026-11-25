import './setup.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emit, takeChangedProjects } from '../server/core.ts'

test('board changes mark a project for the sweep, live output does not', () => {
  takeChangedProjects()
  emit(1, { t: 'activity', text: 'working' })
  emit(1, { t: 'waiting', reasons: {} })
  emit(2, { t: 'notice', text: '' })
  assert.deepEqual(takeChangedProjects(), [])

  emit(1, { t: 'issue', issue: {} })
  emit(3, { t: 'reload' })
  emit(1, { t: 'comment', comment: {} })
  assert.deepEqual(takeChangedProjects().sort(), [1, 3])
  assert.deepEqual(takeChangedProjects(), [], 'taking clears the list')
})
