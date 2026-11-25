import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { juryPrompt, labelled, parseVerdict } from '../server/arena.ts'

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
  const prompt = juryPrompt(
    { title: 'Cart survives a reload', description: 'Keep it.', checklist: ['Test is green'] },
    entries,
  )

  test('shows task, checklist and every entry under a neutral label', () => {
    assert.match(prompt, /Cart survives a reload/)
    assert.match(prompt, /- Test is green/)
    assert.match(prompt, /## Entry A[\s\S]*Summary of A[\s\S]*src\/A\.ts \(\+3 −1\)[\s\S]*fromA/)
    assert.match(prompt, /## Entry B[\s\S]*fromB/)
    assert.match(prompt, /<winner>one of: A, B<\/winner>/)
  })

  test('a huge diff is cut, an empty branch says so', () => {
    const big = juryPrompt({ title: 't', description: '' }, [
      { ...entries[0], files: [file('a.ts', 'x'.repeat(20_000)), file('b.ts', 'y'.repeat(20_000))] },
      { ...entries[1], files: [] },
    ])
    assert.ok(big.length < 30_000)
    assert.match(big, /further changes cut/)
    assert.match(big, /no changes in the branch/)
  })
})

describe('the verdict', () => {
  test('names an entry that took part, with its reason', () => {
    assert.deepEqual(
      parseVerdict('<winner>B</winner>\n<reason> Smaller and tested. </reason>', ['A', 'B']),
      {
        label: 'B',
        reason: 'Smaller and tested.',
      },
    )
    assert.equal(parseVerdict('<winner>Entry a</winner>', ['A', 'B'])?.label, 'A')
  })

  test('anything else is no verdict', () => {
    assert.equal(parseVerdict('PASS', ['A', 'B']), undefined)
    assert.equal(parseVerdict('<winner>C</winner>', ['A', 'B']), undefined)
    assert.equal(parseVerdict('<winner>A and B</winner>', ['A', 'B']), undefined)
    assert.equal(parseVerdict('', ['A']), undefined)
  })
})
