import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultSettings } from '../server/core.ts'
import { landIssue, landings } from '../server/landing.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
    encoding: 'utf8',
  }).trim()

function repoWithBranches(numbers: number[]) {
  const repo = mkdtempSync(join(tmpdir(), 'agentdeck-steps-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'readme.txt'), 'start\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'start')
  for (const number of numbers) {
    git(repo, 'checkout', '-q', '-b', `agentdeck/S-${number}`, 'main')
    writeFileSync(join(repo, `f${number}.txt`), 'x\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', `f${number}`)
  }
  git(repo, 'checkout', '-q', 'main')
  return repo
}

test('the board sees each landing waiting in line, then testing, then gone', async () => {
  const repo = repoWithBranches([1, 2])
  const settings = defaultSettings()
  settings.landing.mode = 'merge'
  settings.precheck = { enabled: true, command: 'true', quickCommand: '', timeoutMin: 1, commandAt: 'landing' }
  const project = { id: 7, key: 'S', repo_path: repo, settings }

  const first = landIssue(project, { id: 71, number: 1, title: 'one' })
  const second = landIssue(project, { id: 72, number: 2, title: 'two' })
  assert.equal(landings.get(72)?.step, 'queued')
  assert.equal(landings.get(72)?.number, 2)

  assert.equal((await first).status, 'done')
  assert.equal(landings.has(71), false)
  assert.equal((await second).status, 'done')
  assert.equal(landings.has(72), false)
})
