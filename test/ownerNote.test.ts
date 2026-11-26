import './setup.ts'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mergeSettings } from '../server/core.ts'
import { MAX_OWNER_NOTE, ownerNote, saveOwnerNote } from '../server/ownerNote.ts'
import { buildPrompt } from '../server/prompt.ts'

const prompt = (language: 'de' | 'en') =>
  buildPrompt({
    project: { id: 1, key: 'SHOP', name: 'Demo shop', settings: mergeSettings({ language }) },
    issue: { id: 1, number: 7, title: 'Cart', description: '' },
    agent: { id: 2, name: 'Developer', skill_ids: [] },
    team: [],
    workdir: { cwd: '.' } as any,
    kind: 'work',
  })

afterEach(() => void saveOwnerNote({ note: '' }))

test('without a note the prompt has no such section', () => {
  assert.doesNotMatch(prompt('en'), /Note from the owner/)
})

test('every prompt carries the note, under a heading in the language of the project', () => {
  saveOwnerNote({ note: '  We push to Forgejo, not GitHub.  ' })
  assert.equal(ownerNote(), 'We push to Forgejo, not GitHub.')
  assert.match(prompt('en'), /## Note from the owner, valid for every agent\n[^\n]+\nWe push to Forgejo, not GitHub\./)
  assert.match(prompt('de'), /## Hinweis des Besitzers, gilt für alle Agenten\n[^\n]+\nWe push to Forgejo, not GitHub\./)
})

test('a note is cut at its limit', () => {
  assert.equal(saveOwnerNote({ note: 'x'.repeat(MAX_OWNER_NOTE + 50) }).note.length, MAX_OWNER_NOTE)
})
