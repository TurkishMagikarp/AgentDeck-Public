import './setup.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { issueChanges } from '../server/diff.ts'
import { gitGraph } from '../server/gitGraph.ts'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitcache-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text)
    git('add', '-A')
    git('commit', '-qm', `${file}: ${text.trim()}`)
  }
  git('init', '-q', '-b', 'main')
  commit('readme.txt', 'start\n')
  git('checkout', '-qb', 'agentdeck/C-1')
  commit('a.txt', 'one\n')
  git('checkout', '-q', 'main')
  return { dir, git, commit }
}

const project = (dir: string) => ({
  id: 999_001,
  key: 'C',
  repo_path: dir,
  settings: { workspace: 'issue' as const, landing: { baseBranch: 'main' } },
})

test('the changes of an issue follow new commits on the branch and on the base', async () => {
  const { dir, git, commit } = repo()
  const first = await issueChanges(project(dir), 1)
  assert.deepEqual(first.files.map((f) => f.path), ['a.txt'])
  assert.equal((await issueChanges(project(dir), 1)).files.length, 1) // from the cache

  git('checkout', '-q', 'agentdeck/C-1')
  commit('b.txt', 'two\n')
  git('checkout', '-q', 'main')
  const second = await issueChanges(project(dir), 1)
  assert.deepEqual(second.files.map((f) => f.path).sort(), ['a.txt', 'b.txt'])
  assert.equal(second.commits.length, 2)

  git('merge', '-q', '--no-edit', 'agentdeck/C-1')
  const landed = await issueChanges(project(dir), 1)
  assert.equal(landed.state, 'landed-or-empty')
})

test('the git graph follows a moving branch and a landing', async () => {
  const { dir, git, commit } = repo()
  const before = await gitGraph(project(dir))
  assert.ok(before.repo)
  assert.equal(before.branches[0].commits.length, 1)
  assert.equal(before.branches[0].landed, false)

  git('checkout', '-q', 'agentdeck/C-1')
  commit('b.txt', 'two\n')
  git('checkout', '-q', 'main')
  const grown = await gitGraph(project(dir))
  assert.ok(grown.repo)
  assert.equal(grown.branches[0].commits.length, 2)

  git('merge', '-q', '--no-ff', '--no-edit', 'agentdeck/C-1')
  const landed = await gitGraph(project(dir))
  assert.ok(landed.repo)
  assert.equal(landed.branches[0].landed, true)
  assert.ok(landed.branches[0].mergeHash)
  // The cached base list is not reversed twice.
  const again = await gitGraph(project(dir))
  assert.ok(again.repo)
  assert.deepEqual(again.baseCommits, landed.baseCommits)
})
