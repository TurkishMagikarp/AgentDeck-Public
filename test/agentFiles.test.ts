import './setup.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
// @ts-ignore: plain ES module
import { fileTool } from '../server/agentFiles.mjs'
import { ownerOf, SANDBOX } from '../server/sandbox.ts'

describe('file tools of the API agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-files-'))
  const work = join(root, 'work')
  const secret = join(root, 'secret')
  mkdirSync(work)
  mkdirSync(secret)
  writeFileSync(join(secret, 'agentdeck.db'), 'keys')
  // A directory link works on Windows without admin rights too.
  symlinkSync(secret, join(work, 'escape'), 'junction')

  test('reads and writes inside the working directory', async () => {
    assert.equal(await fileTool(work, 'write_file', { path: 'src/a.txt', content: 'hello' }), 'written')
    assert.equal(await fileTool(work, 'read_file', { path: 'src/a.txt' }), 'hello')
    assert.equal(await fileTool(work, 'edit_file', { path: 'src/a.txt', old_text: 'hello', new_text: 'hi' }), 'edited')
    assert.equal(readFileSync(join(work, 'src', 'a.txt'), 'utf8'), 'hi')
  })

  test('refuses paths that leave it', async () => {
    await assert.rejects(fileTool(work, 'read_file', { path: '../secret/agentdeck.db' }), /outside/)
    await assert.rejects(fileTool(work, 'read_file', { path: join(secret, 'agentdeck.db') }), /outside/)
  })

  test('refuses to follow a link out of it', async () => {
    await assert.rejects(fileTool(work, 'read_file', { path: 'escape/agentdeck.db' }), /outside/)
    await assert.rejects(fileTool(work, 'list_dir', { path: 'escape' }), /outside/)
    await assert.rejects(fileTool(work, 'write_file', { path: 'escape/new.txt', content: 'x' }), /outside/)
  })

  test('a name that starts with two dots is still inside', async () => {
    assert.equal(await fileTool(work, 'write_file', { path: '..notes', content: 'n' }), 'written')
  })
})

test('the sandbox is off outside its container', () => {
  if (process.platform === 'linux' && process.env.AGENTDECK_SANDBOX === '1') return
  assert.equal(SANDBOX, false)
  assert.equal(ownerOf(tmpdir()), null)
})
