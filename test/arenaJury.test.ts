import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { juryPrompt, labelled, parseVerdict } from '../server/arena.ts'
import { withLang } from '../server/i18n.ts'

const file = (path: string, patch: string) => ({
  path,
  added: 3,
  removed: 1,
  binary: false,
  patch,
  cut: false,
})

describe('the jury question', () => {
  const entries = labelled([{ id: 11 }, { id: 12 }]).map(({ label, entry }) => ({
    label,
    entryId: entry.id,
    costUsd: 1,
    summary: `Summary of ${label}`,
    files: [file(`src/${label}.ts`, `+const from${label} = true`)],
  }))
  const parent = { title: 'Cart survives a reload', description: 'Keep it.', checklist: ['Test is green'] }
  const prompt = withLang('en', () => juryPrompt(parent, entries))

  test('shows task, checklist and every entry under a neutral label', () => {
    assert.match(prompt, /Cart survives a reload/)
    assert.match(prompt, /- Test is green/)
    assert.match(prompt, /## Entry A[\s\S]*Summary of A[\s\S]*src\/A\.ts \(\+3 −1\)[\s\S]*fromA/)
    assert.match(prompt, /## Entry B[\s\S]*fromB/)
    assert.match(prompt, /<winner>one of: A, B<\/winner>/)
  })

  test('a German project gets the question in German, with the same blocks', () => {
    const german = withLang('de', () => juryPrompt(parent, entries))
    assert.match(german, /Du bist die Jury/)
    assert.match(german, /## Beitrag A[^]*Summary of A[^]*fromA/)
    assert.match(german, /<winner>einer von: A, B<.winner>/)
    assert.match(german, /<reason>zwei bis vier Sätze auf Deutsch/)
    assert.match(prompt, /<reason>two to four sentences in English/)
  })

  test('a huge diff is cut, an empty branch says so', () => {
    const huge = [
      { ...entries[0], files: [file('a.ts', 'x'.repeat(20_000)), file('b.ts', 'y'.repeat(20_000))] },
      { ...entries[1], files: [] },
    ]
    const big = juryPrompt({ title: 't', description: '' }, huge)
    assert.ok(big.length < 30_000)
    assert.match(big, /weitere Änderungen gekürzt/)
    assert.match(big, /keine Änderungen im Branch/)
    const english = withLang('en', () => juryPrompt({ title: 't', description: '' }, huge))
    assert.match(english, /more changes cut/)
    assert.match(english, /no changes in the branch/)
  })
})

describe('the verdict', () => {
  test('names an entry that took part, with its reason', () => {
    assert.deepEqual(
      parseVerdict('<winner>B</winner>\n<reason> Kleiner und getestet. </reason>', ['A', 'B']),
      {
        label: 'B',
        reason: 'Kleiner und getestet.',
      },
    )
    assert.equal(parseVerdict('<winner>Entry a</winner>', ['A', 'B'])?.label, 'A')
    assert.equal(parseVerdict('<winner>Beitrag B</winner>', ['A', 'B'])?.label, 'B')
  })

  test('anything else is no verdict', () => {
    assert.equal(parseVerdict('PASS', ['A', 'B']), undefined)
    assert.equal(parseVerdict('<winner>C</winner>', ['A', 'B']), undefined)
    assert.equal(parseVerdict('<winner>A and B</winner>', ['A', 'B']), undefined)
    assert.equal(parseVerdict('', ['A']), undefined)
  })
})
