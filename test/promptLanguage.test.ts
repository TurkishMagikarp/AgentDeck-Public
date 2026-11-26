// Everything a model is told comes in the language of the project, and the protocol that code
// reads back is the same in both languages.
import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { doneWhenItems, parseReport } from '../server/checklist.ts'
import { blueprintGuide, blueprintRequest } from '../server/blueprint.ts'
import { withLang } from '../server/i18n.ts'
import { buildPrompt, tag } from '../server/prompt.ts'
import { de } from '../server/prompts/de.ts'
import { en } from '../server/prompts/en.ts'
import { listTemplates } from '../server/templates.ts'
import { TICKET_FORMAT, missingSections } from '../server/ticket.ts'

const project = (language: 'de' | 'en', settings: Record<string, unknown> = {}) => ({
  id: 1,
  key: 'SHOP',
  name: 'Webshop',
  description: 'A shop.',
  settings: {
    language,
    adhd: false,
    caveman: false,
    checklists: { enabled: true },
    precheck: { enabled: true, command: 'npm test', commandAt: 'landing' },
    ...settings,
  },
})

const lead = { id: 1, name: 'Lead', role: 'Planner', enabled: true, skill_ids: [], instructions: 'Plan.' }
const dev = { id: 2, name: 'Dev', role: '', enabled: true, skill_ids: [], instructions: '' }
const issue = {
  id: 1,
  number: 7,
  title: 'Cart survives a reload',
  description: 'Keep the cart.',
  maker_id: 2,
  checklist: ['Test is green'],
  checklist_report: '1. ok: `npm test`',
}

const prompt = (language: 'de' | 'en', kind: 'work' | 'review', settings = {}, extra = {}) =>
  buildPrompt({
    project: project(language, settings),
    issue,
    agent: kind === 'work' ? dev : lead,
    team: [lead, dev],
    workdir: { branch: 'agentdeck/shop-7' } as any,
    kind,
    ...extra,
  })

describe('the prompt of a run', () => {
  test('an English project is addressed in English', () => {
    const work = prompt('en', 'work')
    assert.match(work, /^You are "Dev" working autonomously in the project "Webshop"\./)
    assert.match(work, /## Issue SHOP-7: Cart survives a reload/)
    assert.match(work, /## Acceptance checklist\n[^\n]*\n1\. Test is green/)
    assert.match(work, /## Board commands/)
    assert.match(work, /`## Done when`/)
    assert.match(work, /- Answer in English\./)
    assert.match(work, /Do not run `npm test`/)
    assert.doesNotMatch(work, /Antworte|language of the issue/)
  })

  test('a German project is addressed in German', () => {
    const work = prompt('de', 'work')
    assert.match(work, /^Du bist "Dev" und arbeitest selbstständig im Projekt "Webshop"\./)
    assert.match(work, /## Issue SHOP-7: Cart survives a reload/)
    assert.match(work, /## Abnahme-Checkliste\n[^\n]*\n1\. Test is green/)
    assert.match(work, /## Board-Befehle/)
    assert.match(work, /`## Fertig wenn`/)
    assert.match(work, /- Antworte auf Deutsch\./)
    assert.match(work, /Führe `npm test` und andere vollständige Testläufe nicht aus/)
    assert.doesNotMatch(work, /Answer in|You are/)
  })

  test('the language of the project wins over the language of the caller', () => {
    assert.match(
      withLang('en', () => prompt('de', 'work')),
      /^Du bist "Dev"/,
    )
    assert.match(
      withLang('de', () => prompt('en', 'review')),
      /^You are "Lead", Planner,/,
    )
  })

  test('the blocks, status values and checklist marks are the same in both languages', () => {
    for (const language of ['de', 'en'] as const) {
      const work = prompt(language, 'work')
      assert.match(
        work,
        /<summary>[^<]+<\/summary>\n<handoff>[^<]+<\/handoff>\n<status>done \| review \| blocked \| handoff:AGENT_NAME<\/status>$/,
      )
      assert.match(work, /<checklist>\n1\. ok: [^\n]+\n2\. open: [^\n]+\n<\/checklist>/)
      assert.match(work, /"n\/a: /)
      assert.match(work, /node "\$AGENTDECK_CLI" create --title/)

      const review = prompt(language, 'review')
      assert.match(review, /<summary>[^<]+<\/summary>\n<status>approve \| changes \| blocked<\/status>$/)
      assert.match(review, /"approve"[^\n]*"changes"[^\n]*"blocked"/)
      assert.match(review, /1\. ok: `npm test`/)

      const decides = prompt(language, 'work', {}, { decides: true })
      assert.match(decides, /`handoff:AGENT_NAME`/)
      assert.match(decides, /`done`[^]*`blocked`/)
    }
  })

  test('a reviewer reads its task in the language of the project', () => {
    assert.match(prompt('en', 'review'), /## Your task: review\nDev finished this issue/)
    assert.match(prompt('de', 'review'), /## Deine Aufgabe: Prüfung\nDev hat dieses Issue bearbeitet/)
    assert.match(prompt('de', 'review'), /## So urteilst du/)
  })

  test('the short summary starts with words of the language', () => {
    const adhd = { adhd: true }
    assert.match(prompt('de', 'work', adhd), /"Fertig:", "Teilweise:" oder "Blockiert:"/)
    assert.match(prompt('de', 'review', adhd), /"Passt:" oder "Ändern:"/)
    assert.match(prompt('en', 'work', adhd), /"Done:", "Partly:" or "Blocked:"/)
    assert.match(prompt('en', 'review', adhd), /"Approved:" or "Changes:"/)
  })

  test('the caveman style comes in the language too', () => {
    assert.match(prompt('en', 'work', { caveman: true }), /## Writing style: caveman/)
    assert.match(prompt('de', 'work', { caveman: true }), /## Schreibstil: Höhlenmensch/)
  })

  test('an answer is read the same whatever language asked for it', () => {
    const answer =
      '<checklist>\n1. ok: `a.png`\n2. open: fehlt\n3. n/a: kein UI\n</checklist>\n<status>review</status>'
    assert.deepEqual(parseReport(tag(answer, 'checklist'), 3)?.open, [2])
    assert.equal(tag(answer, 'status'), 'review')
  })
})

describe('the German texts are complete', () => {
  const shape = (value: unknown): unknown =>
    value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]))
      : typeof value

  test('both languages hold the same texts', () => {
    assert.deepEqual(shape(de), shape(en))
  })

  test('no text is the same in both languages by accident', () => {
    const same = Object.entries(en)
      .filter(([key, value]) => typeof value === 'string' && value === (de as any)[key])
      .map(([key]) => key)
    assert.deepEqual(same, ['skills', 'team', 'commits'])
  })
})

describe('issues in both languages', () => {
  test('the format names the headings of its language, and both are accepted', () => {
    const german = withLang('de', TICKET_FORMAT)
    const english = withLang('en', TICKET_FORMAT)
    for (const heading of ['Ziel', 'Aufgabe', 'Dateien', 'Fertig wenn', 'Nicht Teil davon', 'Hinweise'])
      assert.ok(german.includes(`\`## ${heading}\``), heading)
    for (const heading of ['Goal', 'Task', 'Files', 'Done when', 'Out of scope', 'Notes'])
      assert.ok(english.includes(`\`## ${heading}\``), heading)
    assert.deepEqual(missingSections('## Aufgabe\n1. x\n## Dateien\n- a\n## Fertig wenn\n- y'), [])
  })

  test('"Fertig wenn" becomes the checklist like "Done when"', () => {
    const items = ['Der Test ist grün', 'Die README nennt den Start']
    assert.deepEqual(doneWhenItems(`## Aufgabe\nx\n\n## Fertig wenn\n- ${items.join('\n- ')}`), items)
    assert.deepEqual(doneWhenItems(`## Task\nx\n\n## Done when\n- ${items.join('\n- ')}`), items)
    assert.deepEqual(doneWhenItems('Bauen. Fertig, wenn: Tests decken beide Wege ab.'), [
      'Tests decken beide Wege ab',
    ])
  })
})

describe('templates and blueprints', () => {
  test('the template list answers in the language of the person asking', () => {
    const german = withLang('de', listTemplates)
    const english = withLang('en', listTemplates)
    assert.deepEqual(
      german.map((template) => template.id),
      english.map((template) => template.id),
    )
    assert.equal(german[0].name, 'SaaS-MVP')
    assert.deepEqual(german[0].agents, ['Lead', 'Backend', 'Frontend', 'Prüfer'])
    assert.equal(english[0].name, 'SaaS MVP')
    assert.deepEqual(english[0].agents, ['Lead', 'Backend', 'Frontend', 'Reviewer'])
    assert.deepEqual(
      german.map((template) => template.issues),
      english.map((template) => template.issues),
    )
  })

  test('the blueprint guide keeps its JSON keys and values in both languages', () => {
    const german = withLang('de', blueprintGuide)
    const english = withLang('en', blueprintGuide)
    assert.match(german, /^Ein Blueprint ist ein JSON-Objekt/)
    assert.match(english, /^A blueprint is one JSON object/)
    const keys = (guide: string) => [...guide.matchAll(/"([a-z_A-Z]+)":/g)].map((match) => match[1])
    assert.deepEqual(keys(german), keys(english))
    assert.match(
      withLang('de', () => blueprintRequest('Ein Shop')),
      /## Wunsch\nEin Shop$/,
    )
    assert.match(
      withLang('en', () => blueprintRequest('A shop')),
      /## Request\nA shop$/,
    )
  })
})
