import assert from 'node:assert/strict'
import { test } from 'node:test'
import { partialStep, waitingLines } from '../server/partial.ts'

test('a maker that waits for an open issue makes the issue wait, without a review', () => {
  assert.deepEqual(partialStep({ waitsFor: [826, 827], openBefore: null, openNow: [1, 4] }), {
    kind: 'wait',
    on: [826, 827],
  })
})

test('only the first partial delivery gets an interim review', () => {
  assert.equal(partialStep({ waitsFor: [], openBefore: null, openNow: [1, 4] }).kind, 'interim')
  assert.equal(partialStep({ waitsFor: [], openBefore: [], openNow: [1, 4] }).kind, 'interim')
  assert.equal(partialStep({ waitsFor: [], openBefore: [1, 2, 4], openNow: [1, 4] }).kind, 'goOn')
})

test('a later partial delivery that met nothing new goes to a human', () => {
  assert.equal(partialStep({ waitsFor: [], openBefore: [1, 4], openNow: [1, 4] }).kind, 'stuck')
  assert.equal(partialStep({ waitsFor: [], openBefore: [1, 4], openNow: [1, 2, 4] }).kind, 'stuck')
})

test('only lines that say something waits name blockers', () => {
  const report = [
    'Teilweise: Route 5 gebaut.',
    '- Ausgänge warten auf SHOP-826',
    '- Collectors lack figures (SHOP-827)',
    '- Sammler weiter bei SHOP-845',
  ].join('\n')
  const lines = waitingLines(report)
  assert.match(lines, /SHOP-826/)
  assert.match(lines, /SHOP-827/)
  assert.doesNotMatch(lines, /SHOP-845/)
})
