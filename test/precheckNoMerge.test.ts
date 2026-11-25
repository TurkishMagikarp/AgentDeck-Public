import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { precheck } from '../server/precheck.ts'

/** main moved on after agentdeck/T-1 was started; both commit their own file, or the same one. */
function repo(sameFile = false) {
  const dir = mkdtempSync(join(tmpdir(), 'nomerge-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text)
    git('add', file)
    git('commit', '-qm', `${file} ${text}`)
  }
  git('init', '-q', '-b', 'main')
  commit('start.txt', 'start')
  git('checkout', '-qb', 'agentdeck/T-1')
  commit(sameFile ? 'shared.txt' : 'feature.txt', 'feature')
  git('checkout', '-q', 'main')
  commit(sameFile ? 'shared.txt' : 'other.txt', 'other')
  git('checkout', '-q', 'agentdeck/T-1')
  return { dir, git }
}

const check = (dir: string, command = '') =>
  precheck({ cwd: dir, branch: 'agentdeck/T-1', base: 'main', command, timeoutMin: 1, report: null })

test('the base is not merged into the branch before its turn', async () => {
  const { dir, git } = repo()
  const before = git('rev-parse', 'HEAD')
  const result = await check(dir)
  assert.equal(result.ok, true)
  assert.match(result.note, /no conflicts/)
  assert.equal(git('rev-parse', 'HEAD'), before)
})

test('a conflict with the base is found without touching the branch', async () => {
  const { dir, git } = repo(true)
  const before = git('rev-parse', 'HEAD')
  const result = await check(dir)
  assert.equal(result.ok, false)
  assert.match(result.note, /shared\.txt/)
  assert.equal(git('rev-parse', 'HEAD'), before)
  assert.equal(git('status', '--porcelain'), '')
})

test('the check sees the base merged in, and the merge is taken back afterwards', async () => {
  const { dir, git } = repo()
  const before = git('rev-parse', 'HEAD')
  assert.equal((await check(dir, 'test -f other.txt && test -f feature.txt')).ok, true)
  assert.equal(git('rev-parse', 'HEAD'), before)
  const red = await check(dir, 'exit 4')
  assert.equal(red.ok, false)
  assert.equal(git('rev-parse', 'HEAD'), before)
})
