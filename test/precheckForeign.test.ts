import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { precheck } from '../server/precheck.ts'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'foreign-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  const commit = (file: string) => {
    writeFileSync(join(dir, file), file)
    git('add', file)
    git('commit', '-qm', file)
  }
  git('init', '-q', '-b', 'main')
  commit('start')
  return { dir, git, commit }
}

const check = (dir: string, branch: string) =>
  precheck({ cwd: dir, branch, base: 'main', command: '', timeoutMin: 1, report: null })

test('a branch that merged a neighbour branch fails before the review', async () => {
  const { dir, git, commit } = repo()
  git('checkout', '-qb', 'agentdeck/SHOP-708')
  commit('sahilkoy')
  git('checkout', '-qb', 'agentdeck/SHOP-706', 'main')
  commit('zongul')
  git('merge', '-q', '--no-edit', 'agentdeck/SHOP-708')
  const result = await check(dir, 'agentdeck/SHOP-706')
  assert.equal(result.ok, false)
  assert.match(result.note, /agentdeck\/SHOP-708/)
})

test('a neighbour branch that has landed is fine', async () => {
  const { dir, git, commit } = repo()
  git('checkout', '-qb', 'agentdeck/SHOP-708')
  commit('sahilkoy')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', '--no-edit', 'agentdeck/SHOP-708')
  git('checkout', '-qb', 'agentdeck/SHOP-706')
  commit('zongul')
  assert.equal((await check(dir, 'agentdeck/SHOP-706')).ok, true)
})

test('a branch started from this one does not make this one foreign', async () => {
  const { dir, git, commit } = repo()
  git('checkout', '-qb', 'agentdeck/SHOP-706')
  commit('zongul')
  git('checkout', '-qb', 'agentdeck/SHOP-845')
  commit('collectors')
  git('checkout', '-q', 'agentdeck/SHOP-706')
  assert.equal((await check(dir, 'agentdeck/SHOP-706')).ok, true)
})
