import './setup.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSettings, mergeSettings } from '../server/core.ts'
import { changedShellSettings, confirmedBy, confirmMode, SHELL_SETTINGS } from '../server/reauth.ts'

test('every setting that runs as a shell command is watched', () => {
  assert.deepEqual([...SHELL_SETTINGS].sort(), ['precheck.command', 'precheck.quickCommand', 'preview.command'])
})

test('only a changed command needs the token', () => {
  const stored = mergeSettings({ precheck: { command: 'npm test' }, preview: { command: 'npm run dev' } })
  assert.deepEqual(changedShellSettings(stored, { ...stored, maxConcurrent: 7 }), [])
  assert.deepEqual(
    changedShellSettings(stored, { ...stored, precheck: { ...stored.precheck, quickCommand: 'npm run lint' } }),
    ['precheck.quickCommand'],
  )
  assert.deepEqual(
    changedShellSettings(stored, { ...stored, preview: { ...stored.preview, command: 'sh -c id' } }),
    ['preview.command'],
  )
  // Removing a command is a change too.
  assert.deepEqual(changedShellSettings(stored, { ...stored, precheck: { ...stored.precheck, command: '' } }), [
    'precheck.command',
  ])
})

test('a new project with a command needs the token, one without does not', () => {
  assert.deepEqual(changedShellSettings(null, { maxConcurrent: 2 }), [])
  assert.deepEqual(changedShellSettings(null, undefined), [])
  assert.deepEqual(changedShellSettings(null, { preview: { command: 'x' } }), ['preview.command'])
  assert.deepEqual(changedShellSettings(defaultSettings(), defaultSettings()), [])
})

test('the confirmation is the board token, in the body or as Bearer header', () => {
  assert.equal(confirmedBy('s3cret-token', 's3cret-token', undefined), true)
  assert.equal(confirmedBy('s3cret-token', undefined, 'Bearer s3cret-token'), true)
  assert.equal(confirmedBy('s3cret-token', 'wrong', undefined), false)
  assert.equal(confirmedBy('s3cret-token', 's3cret-toke', 'Bearer nope'), false)
  assert.equal(confirmedBy('s3cret-token', { toString: () => 's3cret-token' }, undefined), false)
})

test('without a board token nothing confirms, not even an empty one', () => {
  assert.equal(confirmedBy('', '', undefined), false)
  assert.equal(confirmedBy('', undefined, 'Bearer '), false)
})

test('behind the proxy without a token command changes are refused', () => {
  assert.equal(confirmMode('t', false), 'token')
  assert.equal(confirmMode('t', true), 'token')
  assert.equal(confirmMode('', true), 'refused')
  assert.equal(confirmMode('', false), 'open')
})
