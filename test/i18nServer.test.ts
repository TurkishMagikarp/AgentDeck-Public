// Every text the server passes to t(), tIn() or variants() needs an English entry with the same
// placeholders, and a text switches with the language it is asked for in.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { en } from '../server/i18n/en.ts'
import { forProject, requestLang, say, t, tIn, variants, withLang } from '../server/i18n.ts'

const SRC = join(import.meta.dirname, '..', 'server')

const sources = readdirSync(SRC)
  .filter((name) => /\.(ts|mjs)$/.test(name) && name !== 'i18n.ts')
  .map((name) => ({ name, text: readFileSync(join(SRC, name), 'utf8') }))

const unquote = (body: string) =>
  body.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_, esc: string) =>
    esc[0] === 'u' && esc.length === 5
      ? String.fromCharCode(parseInt(esc.slice(1), 16))
      : ({ n: '\n', t: '\t' } as Record<string, string>)[esc] ?? esc,
  )

const keys: { file: string; key: string }[] = []
for (const { name, text } of sources) {
  const calls = /(?<![\w.$])(?:t|variants)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1|(?<![\w.$])tIn\(\s*[\w.()'"]+,\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/gs
  for (const match of text.matchAll(calls)) {
    const quote = match[1] ?? match[3]
    const body = match[2] ?? match[4]
    assert.ok(quote !== '`' || !body.includes('${'), `${name}: t() takes {placeholders}, not \${…}: ${body.slice(0, 50)}`)
    keys.push({ file: name, key: unquote(body) })
  }
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

test('the scan finds the server texts', () => {
  assert.ok(keys.length > 100, `only ${keys.length} t() calls found`)
})

test('every server text has an English translation', () => {
  const missing = keys.filter(({ key }) => !(key in en)).map(({ file, key }) => `${file}: ${key}`)
  assert.deepEqual(missing, [])
})

test('English server texts keep the placeholders of the German key', () => {
  const broken = Object.entries(en)
    .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
    .map(([key]) => key)
  assert.deepEqual(broken, [])
})

test('no English server text is empty', () => {
  assert.deepEqual(Object.entries(en).filter(([, value]) => !value.trim()).map(([key]) => key), [])
})

test('a text follows the language of the work it belongs to', () => {
  const [key] = Object.keys(en).filter((text) => en[text] !== text.split('||')[0])
  assert.equal(withLang('en', () => t(key)), en[key])
  assert.equal(withLang('de', () => t(key)), key.split('||')[0])
  assert.equal(forProject({ settings: { language: 'en' } }, () => t(key)), en[key])
  assert.deepEqual(variants(key), [tIn('de', key), tIn('en', key)])
  assert.equal(withLang('en', () => say({ de: 'eins', en: 'one' })), 'one')
})

test('the language survives an await and a timer', async () => {
  const seen = await withLang('en', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    return say({ de: 'de', en: 'en' })
  })
  assert.equal(seen, 'en')
})

test('a request asks for its language with the header, then with the browser preference', () => {
  const header = (values: Record<string, string>) => (name: string) => values[name]
  assert.equal(requestLang(header({ 'x-agentdeck-lang': 'en', 'accept-language': 'de-DE' })), 'en')
  assert.equal(requestLang(header({ 'accept-language': 'de-DE,de;q=0.9' })), 'de')
  assert.equal(requestLang(header({ 'accept-language': 'fr-FR' })), 'en')
  assert.equal(requestLang(header({})), 'de')
})
