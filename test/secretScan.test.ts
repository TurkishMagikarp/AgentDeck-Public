import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { defaultSettings } from '../server/core.ts'
import { landIssue } from '../server/landing.ts'
import { precheck } from '../server/precheck.ts'
import { scanBranch, scanPatch, secretIn } from '../server/secretScan.ts'

// Built at runtime, so this file holds nothing a scanner (ours or GitHub's) would flag.
const random = (length: number, chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') =>
  Array.from({ length }, (_, i) => chars[(i * 7919 + length * 31) % chars.length]).join('')
const KEYS = {
  aws: ['AK', 'IA'].join('') + random(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
  github: ['gh', 'p_'].join('') + random(36),
  anthropic: ['sk', '-ant-', 'api03-'].join('') + random(40),
  openai: ['sk', '-proj-'].join('') + random(48),
  pem: ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join(''),
}

describe('secretIn', () => {
  test('finds the common key formats', () => {
    assert.equal(secretIn(`const key = "${KEYS.aws}"`)?.rule.id, 'aws')
    assert.equal(secretIn(`token=${KEYS.github}`)?.rule.id, 'github')
    assert.equal(secretIn(`ANTHROPIC_API_KEY=${KEYS.anthropic}`)?.rule.id, 'anthropic')
    assert.equal(secretIn(`OPENAI_API_KEY=${KEYS.openai}`)?.rule.id, 'openai')
    assert.equal(secretIn(KEYS.pem)?.rule.id, 'private-key')
  })

  test('finds a random-looking password in an assignment', () => {
    assert.equal(secretIn(`password: "${random(24)}9x"`)?.rule.id, 'assignment')
  })

  test('leaves ordinary code, env lookups and example values alone', () => {
    assert.equal(secretIn('const token = process.env.GITHUB_TOKEN'), null)
    assert.equal(secretIn('password: "correcthorsebatterystaple"'), null)
    assert.equal(secretIn('api_key = "${API_KEY_FROM_ENV_1234}"'), null)
    assert.equal(secretIn(['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('')), null)
    assert.equal(secretIn('const task-switch = 1; disk-usage-for-everything-in-the-world-and-more'), null)
  })
})

describe('scanPatch', () => {
  test('looks only at added lines and names file and commit, never the secret', () => {
    const patch = [
      '\0abc1234',
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1 +1 @@',
      `-OLD=${KEYS.github}`,
      `+AWS=${KEYS.aws}`,
    ].join('\n')
    const [finding, ...rest] = scanPatch(patch)
    assert.equal(rest.length, 0)
    assert.equal(finding.file, '.env')
    assert.equal(finding.commit, 'abc1234')
    assert.ok(!JSON.stringify(finding).includes(KEYS.aws))
  })

  test('a header line inside a hunk is content, not a file name', () => {
    const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -0,0 +1 @@', `+++ ${KEYS.github}`].join('\n')
    assert.equal(scanPatch(patch)[0]?.file, 'x')
  })
})

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text)
    git('add', '-A')
    git('commit', '-qm', file)
  }
  git('init', '-q', '-b', 'main')
  commit('readme.txt', 'start\n')
  git('checkout', '-qb', 'agentdeck/T-1')
  return { dir, git, commit }
}

describe('scanBranch', () => {
  test('a key that a later commit deletes is still found in the history', async () => {
    const { dir, commit } = repo()
    commit('config.js', `export const key = "${KEYS.anthropic}"\n`)
    commit('config.js', 'export const key = process.env.ANTHROPIC_API_KEY\n')
    const findings = await scanBranch(dir, 'main')
    assert.equal(findings.length, 1)
    assert.equal(findings[0].file, 'config.js')
  })

  test('a clean branch has no findings, and a key already in the base does not count', async () => {
    const { dir, git, commit } = repo()
    git('checkout', '-q', 'main')
    commit('old.env', `KEY=${KEYS.github}\n`)
    git('checkout', '-q', 'agentdeck/T-1')
    git('merge', '-q', '--no-edit', 'main')
    commit('feature.js', 'export const answer = 42\n')
    assert.deepEqual(await scanBranch(dir, 'main'), [])
  })

  test('a .gitattributes diff driver in the branch does not run', async () => {
    const { dir, git, commit } = repo()
    const marker = join(dir, 'driver-ran')
    git('config', 'diff.evil.command', `touch ${marker.replace(/\\/g, '/')}`)
    commit('.gitattributes', '*.js diff=evil\n')
    commit('a.js', `const k = "${KEYS.aws}"\n`)
    assert.equal((await scanBranch(dir, 'main')).length, 1)
    assert.equal(existsSync(marker), false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('gates', () => {
  test('the precheck sends the work back to the maker', async () => {
    const { dir, commit } = repo()
    commit('.env', `GITHUB_TOKEN=${KEYS.github}\n`)
    const result = await precheck({ cwd: dir, branch: 'agentdeck/T-1', base: 'main', command: '', timeoutMin: 1, report: null })
    assert.equal(result.ok, false)
    assert.match(result.note, /GitHub-Token in `\.env`/)
    assert.ok(!result.note.includes(KEYS.github))
  })

  test('the precheck names a clean branch', async () => {
    const { dir, commit } = repo()
    commit('a.txt', 'hello\n')
    const result = await precheck({ cwd: dir, branch: 'agentdeck/T-1', base: 'main', command: '', timeoutMin: 1, report: null })
    assert.equal(result.ok, true)
    assert.match(result.note, /keine Geheimnisse/)
  })

  test('the landing stops for the owner and leaves the base as it was', async () => {
    const { dir, git, commit } = repo()
    commit('key.pem', `${KEYS.pem}\nabc\n`)
    git('checkout', '-q', 'main')
    const before = git('rev-parse', 'main')
    const settings = defaultSettings()
    settings.landing.mode = 'merge'
    const outcome = await landIssue({ id: 9, key: 'T', repo_path: dir, settings }, { id: 91, number: 1, title: 'x' })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.needsOwner, true)
    assert.match(outcome.note, /privater Schlüssel/)
    assert.equal(git('rev-parse', 'main'), before)
  })
})
