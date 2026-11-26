import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstSentence, journalLine } from '../server/journal.ts'

const system = (body: string) => journalLine({ author: 'System', kind: 'system', body })

test('landings, red landings and approvals become short lines', () => {
  assert.deepEqual(system('In main gelandet (9d9b5ce6, `SHARDS=4 ./bin/run-tests` grün).'), {
    kind: 'landed',
    text: 'Gelandet in main (9d9b5ce6)',
  })
  const red = system(
    'Die Projektprüfung `x` ist auf dem gemergten Stand fehlgeschlagen (Exit-Code 1). Behebe das.\n\n```\ncheck_art: ok\nFAIL  test_maps.gd test_exits: sahilkoy_beach: arrival is free\n```',
  )
  assert.equal(red?.kind, 'landingRed')
  assert.match(red!.text, /^Landung rot: test_maps\.gd test_exits/)
  assert.deepEqual(system('Lead hat freigegeben.'), { kind: 'approved', text: 'Freigegeben von Lead' })
})

test('waits, partials and escalations are named', () => {
  assert.deepEqual(system('Wartet jetzt auf SHOP-826, SHOP-827 und geht von selbst weiter, sobald das erledigt ist.'), {
    kind: 'waits',
    text: 'Wartet auf SHOP-826, SHOP-827',
  })
  assert.equal(system('Teilabgabe, offen: Punkt 5. Zwischenprüfung durch Lead.')?.kind, 'partial')
  assert.equal(system('An Lead zur Entscheidung: World builder scheitert 3-mal in Folge.\n\nLies, warum.')?.kind, 'escalated')
})

test('noise stays out of the journal', () => {
  assert.equal(journalLine({ author: 'Vorcheck', kind: 'system', body: 'Vorcheck bestanden: main eingemergt.' }), null)
  assert.equal(system('Lead hat den Zwischenstand freigegeben. Weiter mit den offenen Punkten.'), null)
  assert.equal(journalLine({ author: 'Lead', kind: 'review', body: 'Passt: alles gut.' }), null)
  assert.equal(journalLine({ author: 'Lead', kind: 'agent', body: 'Fertig: gebaut.' }), null)
})

test('change requests and red prechecks keep their reason', () => {
  assert.deepEqual(journalLine({ author: 'Lead', kind: 'review', body: 'Ändern: Branch trägt SHOP-706 mit. - Merge raus' }), {
    kind: 'changes',
    text: 'Lead verlangt Änderungen: Branch trägt SHOP-706 mit.',
  })
  const pre = journalLine({ author: 'Vorcheck', kind: 'watchdog', body: 'Diese Nachweis-Dateien fehlen: `a.png`. Erzeuge sie.' })
  assert.deepEqual(pre, { kind: 'precheckRed', text: 'Vorcheck rot: Diese Nachweis-Dateien fehlen: `a.png`.' })
})

test('first sentences are cut to one line', () => {
  assert.equal(firstSentence('Eins. Zwei.'), 'Eins.')
  assert.equal(firstSentence('x'.repeat(200), 10), `${'x'.repeat(9)}…`)
})
