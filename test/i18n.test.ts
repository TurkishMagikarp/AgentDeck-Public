// Every text passed to t('…') in the web UI needs an English entry with the same placeholders.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { en } from '../web/src/i18n/en.ts'

const SRC = join(import.meta.dirname, '..', 'web', 'src')

const sources = readdirSync(SRC)
  .filter((name) => /\.(ts|tsx)$/.test(name) && name !== 'i18n.ts')
  .map((name) => ({ name, text: readFileSync(join(SRC, name), 'utf8') }))

/** Evaluates a quoted JS string literal the way the compiler would. */
const unquote = (quote: string, body: string) =>
  body.replace(/\\(u[0-9a-fA-F]{4}|.)/gs, (_, esc: string) =>
    esc[0] === 'u' && esc.length === 5
      ? String.fromCharCode(parseInt(esc.slice(1), 16))
      : ({ n: '\n', t: '\t' } as Record<string, string>)[esc] ?? esc,
  )

const keys: { file: string; key: string }[] = []
for (const { name, text } of sources) {
  for (const match of text.matchAll(/(?<![\w.$])t\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs)) {
    assert.notEqual(match[1], '`', `${name}: t() takes a plain string, not a template: ${match[2].slice(0, 50)}`)
    keys.push({ file: name, key: unquote(match[1], match[2]) })
  }
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

test('the scan finds the UI texts', () => {
  assert.ok(keys.length > 50, `only ${keys.length} t() calls found`)
})

test('every t() text has an English translation', () => {
  const missing = keys.filter(({ key }) => !(key in en)).map(({ file, key }) => `${file}: ${key}`)
  assert.deepEqual(missing, [])
})

test('English texts keep the placeholders of the German key', () => {
  const broken = Object.entries(en)
    .filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())
    .map(([key]) => key)
  assert.deepEqual(broken, [])
})

test('no English entry is left empty or identical by accident', () => {
  const empty = Object.entries(en).filter(([, value]) => !value.trim()).map(([key]) => key)
  assert.deepEqual(empty, [])
})

// German that never went through t(): a label table without an English entry, a placeholder, a
// text node. A literal counts as German when it has an umlaut or a common German word; it must then
// be a key of the dictionary (directly in t('…') or by way of a table that is translated where it is
// shown). Text outside of literals (JSX text nodes) must not look German at all.
const GERMAN = /[äöüÄÖÜß]|(?<![\w-])(und|oder|nicht|der|die|das|ein|eine|einen|mit|von|vom|auf|ist|sind|wird|kein|keine|noch|alle|zum|zur|bei|nach|wenn|nur|auch|aus)(?![\w-])/

// Not shown to anyone: patterns that read what agents wrote, in both languages.
const NOT_TEXT = ['[a-zäöü/]+', 'erledigt|erfüllt|ja|yes']

/** Splits a source file into its string literals and the code and JSX text between them. */
function split(text: string) {
  const literals: string[] = []
  let rest = ''
  let at = 0
  // Comments, regex literals after ( , = : or at a line start, then strings. Order matters.
  const token =
    /\/\*[\s\S]*?\*\/|(?<=^|\s)\/\/[^\n]*|(?<=(?:^|[(,=:])\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*|(['"])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^`\\])*)`/gm
  for (const match of text.matchAll(token)) {
    rest += text.slice(at, match.index) + ' '
    at = match.index + match[0].length
    if (match[1]) literals.push(unquote(match[1], match[2]))
    else if (match[0][0] === '`') literals.push('`' + match[3].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '…'))
    else if (match[0][0] === '/' && match[0][1] !== '/' && match[0][1] !== '*') literals.push(match[0])
  }
  return { literals, rest: rest + text.slice(at) }
}

test('no German text bypasses t()', () => {
  const found: string[] = []
  for (const { name, text } of sources) {
    const { literals, rest } = split(text)
    for (const literal of literals) {
      if (!GERMAN.test(literal) || literal in en) continue
      if (!NOT_TEXT.some((pattern) => literal.includes(pattern))) found.push(`${name}: ${literal}`)
    }
    for (const line of rest.split('\n')) if (GERMAN.test(line)) found.push(`${name}: ${line.trim()}`)
  }
  assert.deepEqual(found, [])
})
