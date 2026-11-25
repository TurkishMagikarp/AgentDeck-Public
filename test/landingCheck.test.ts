import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { defaultSettings } from '../server/core.ts'
import { landIssue } from '../server/landing.ts'

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
    encoding: 'utf8',
  }).trim()

/** A repository on main with one commit and the issue branch agentdeck/T-1 one commit ahead. */
function repoWithIssueBranch() {
  const repo = mkdtempSync(join(tmpdir(), 'agentdeck-landing-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'readme.txt'), 'start\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'start')
  git(repo, 'checkout', '-q', '-b', 'agentdeck/T-1')
  writeFileSync(join(repo, 'feature.txt'), 'feature\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'feature')
  git(repo, 'checkout', '-q', 'main')
  return repo
}

function projectFor(repo: string, command: string, commandAt: 'review' | 'landing') {
  const settings = defaultSettings()
  settings.landing.mode = 'merge'
  settings.precheck = { enabled: true, command, quickCommand: '', timeoutMin: 1, commandAt }
  return { id: 1, key: 'T', repo_path: repo, settings }
}

const issue = { id: 1, number: 1, title: 'Feature' }

describe('check command at landing', () => {
  test('a green check lands the branch and says so', async () => {
    const repo = repoWithIssueBranch()
    const outcome = await landIssue(projectFor(repo, 'test -f feature.txt', 'landing'), issue)
    assert.equal(outcome.status, 'done')
    assert.match(outcome.note, /green/)
    assert.equal(git(repo, 'show', 'HEAD:feature.txt'), 'feature')
  })

  test('a red check takes the merge back and sends the issue to the maker', async () => {
    const repo = repoWithIssueBranch()
    const before = git(repo, 'rev-parse', 'HEAD')
    const outcome = await landIssue(projectFor(repo, 'echo broken && exit 3', 'landing'), issue)
    assert.equal(outcome.status, 'todo')
    assert.match(outcome.note, /broken/)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
    assert.equal(git(repo, 'status', '--porcelain'), '')
  })

  test('the base branch does not move while the check runs', async () => {
    const repo = repoWithIssueBranch()
    const before = git(repo, 'rev-parse', 'main')
    const seen = join(mkdtempSync(join(tmpdir(), 'agentdeck-seen-')), 'main.txt')
    const outcome = await landIssue(
      projectFor(repo, `git -C "${repo}" rev-parse main > "${seen}" && test -f feature.txt`, 'landing'),
      issue,
    )
    assert.equal(outcome.status, 'done')
    assert.equal(readFileSync(seen, 'utf8').trim(), before)
    assert.notEqual(git(repo, 'rev-parse', 'main'), before)
    assert.equal(git(repo, 'show', 'main:feature.txt'), 'feature')
  })

  test('a conflict at landing goes back to the maker and leaves the base alone', async () => {
    const repo = repoWithIssueBranch()
    writeFileSync(join(repo, 'feature.txt'), 'other\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'other')
    const before = git(repo, 'rev-parse', 'main')
    const outcome = await landIssue(projectFor(repo, 'true', 'landing'), issue)
    assert.equal(outcome.status, 'todo')
    assert.equal(git(repo, 'rev-parse', 'main'), before)
  })

  test('a check that runs before the review is not repeated at landing', async () => {
    const repo = repoWithIssueBranch()
    const outcome = await landIssue(projectFor(repo, 'exit 1', 'review'), issue)
    assert.equal(outcome.status, 'done')
  })
})
