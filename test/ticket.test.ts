import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { missingSections } from '../server/ticket.ts'

describe('missingSections', () => {
  test('a ticket with headings is complete', () => {
    const description = '## Goal\nWhy\n## Task\n1. Do it\n## Files\n- a.ts\n## Done when\n- [ ] works'
    assert.deepEqual(missingSections(description), [])
  })

  test('bold labels count as sections', () => {
    const description = '**Task:** do it\n\n**Files:** a.ts\n\n**Done when:** it works'
    assert.deepEqual(missingSections(description), [])
  })

  test('names what is missing', () => {
    assert.deepEqual(missingSections('Fix the bug in the menu.'), ['Task', 'Files', 'Done when'])
    assert.deepEqual(missingSections('## Task\nx\n## done when\n- y'), ['Files'])
  })

  test('German headings count the same', () => {
    const description = '## Ziel\nWarum\n## Aufgabe\n1. Tun\n## Dateien\n- a.ts\n## Fertig wenn\n- [ ] läuft'
    assert.deepEqual(missingSections(description), [])
    const bold = '**Aufgabe:** tun\n\n**Dateien:** a.ts\n\n**Fertig, wenn:** es läuft'
    assert.deepEqual(missingSections(bold), [])
    assert.deepEqual(missingSections('## Aufgabe\nx\n## Files\n- a.ts'), ['Done when'])
    assert.deepEqual(missingSections('## Aufgaben\nx\n## Dateien\n## Fertig wenn\n- y'), ['Task'])
  })

  test('a word inside a sentence is no section', () => {
    assert.deepEqual(missingSections('The task is done when the files exist.'), [
      'Task',
      'Files',
      'Done when',
    ])
  })
})
