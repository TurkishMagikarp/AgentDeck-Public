import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstSentence, journalLine } from '../server/journal.ts'

const system = (body: string) => journalLine({ author: 'System', kind: 'system', body })

test('landings, red landings and approvals become short lines', () => {
  assert.deepEqual(system('Landed in main (9d9b5ce6, `SHARDS=4 npm test` green).'), {
    kind: 'landed',
    text: 'Landed in main (9d9b5ce6)',
  })
  const red = system(
    'The project check `x` failed (exit code 1) on the merged state. Fix that and hand in again.\n\n```\ncheck_art: ok\nFAIL  test_maps.gd test_exits: harbor_beach: arrival is free\n```',
  )
  assert.equal(red?.kind, 'landingRed')
  assert.match(red!.text, /^Landing red: test_maps\.gd test_exits/)
  assert.deepEqual(system('Lead approved.'), { kind: 'approved', text: 'Approved by Lead' })
})

test('waits, partials and escalations are named', () => {
  assert.deepEqual(system('Now waits for SHOP-826, SHOP-827 and carries on by itself once that is done.'), {
    kind: 'waits',
    text: 'Waits for SHOP-826, SHOP-827',
  })
  assert.equal(system('Partial handoff, open: item 5. Interim review by Lead.')?.kind, 'partial')
  assert.equal(system('Handed to Lead to decide: World builder failed the precheck 3 times in a row.\n\nRead why.')?.kind, 'escalated')
})

test('noise stays out of the journal', () => {
  assert.equal(journalLine({ author: 'Precheck', kind: 'system', body: 'Precheck passed: no conflicts with main.' }), null)
  assert.equal(system('Lead approved the interim state. Carry on with the open items.'), null)
  assert.equal(journalLine({ author: 'Lead', kind: 'review', body: 'Approved: all good.' }), null)
  assert.equal(journalLine({ author: 'Lead', kind: 'agent', body: 'Done: built.' }), null)
})

test('change requests and red prechecks keep their reason', () => {
  assert.deepEqual(journalLine({ author: 'Lead', kind: 'review', body: 'Changes: the branch carries SHOP-706 along. - Take the merge out' }), {
    kind: 'changes',
    text: 'Lead asks for changes: the branch carries SHOP-706 along.',
  })
  const pre = journalLine({ author: 'Precheck', kind: 'watchdog', body: 'These proof files are missing: `a.png`. Create them.' })
  assert.deepEqual(pre, { kind: 'precheckRed', text: 'Precheck red: These proof files are missing: `a.png`.' })
})

test('first sentences are cut to one line', () => {
  assert.equal(firstSentence('One. Two.'), 'One.')
  assert.equal(firstSentence('x'.repeat(200), 10), `${'x'.repeat(9)}…`)
})
