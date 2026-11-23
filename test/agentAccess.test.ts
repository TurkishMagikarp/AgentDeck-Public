import './setup.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { readStatus } from '../server/auth.ts'
import { connectionKeys, prepareMcp, setConnectionKey } from '../server/mcp.ts'

describe('opencode login status', () => {
  const list = (count: number, names: string[] = []) =>
    [
      '┌  Credentials ~/.local/share/opencode/auth.json',
      '│',
      ...names.map((name) => `●  ${name} api`),
      '│',
      `└  ${count} credentials`,
    ].join('\n')

  test('one stored credential counts as logged in', () => {
    assert.deepEqual(readStatus('opencode', list(1, ['OpenCode Go']), 0), {
      loggedIn: true,
      detail: '1 credentials stored',
    })
  })

  test('no credential is not logged in', () => {
    assert.deepEqual(readStatus('opencode', list(0), 0), { loggedIn: false, detail: '' })
  })

  test('several credentials are counted', () => {
    assert.equal(
      readStatus('opencode', list(2, ['OpenCode Go', 'OpenCode']), 0).detail,
      '2 credentials stored',
    )
  })

  test('the singular form is read too', () => {
    assert.equal(readStatus('opencode', '└  1 credential', 0).loggedIn, true)
  })

  test('unreadable output is not logged in', () => {
    assert.equal(readStatus('opencode', 'command not found', 127).loggedIn, false)
  })
})

describe('connection keys for agents', () => {
  beforeEach(() => {
    for (const id of ['github', 'pixellab', 'elevenlabs', 'recraft', 'meshy']) setConnectionKey(id, '')
  })

  test('every stored key is handed out under its usual name', () => {
    setConnectionKey('pixellab', 'pl-key')
    setConnectionKey('elevenlabs', 'el-key')
    assert.deepEqual(connectionKeys(), { PIXELLAB_API_KEY: 'pl-key', ELEVENLABS_API_KEY: 'el-key' })
  })

  test('no keys, no variables', () => {
    assert.deepEqual(connectionKeys(), {})
  })

  for (const cli of ['claude', 'codex', 'opencode', 'managed']) {
    test(`${cli} agents get the keys without listing the connection`, () => {
      setConnectionKey('pixellab', 'pl-key')
      const setup = prepareMcp(cli, [], 'run-1')
      assert.equal(setup.env.PIXELLAB_API_KEY, 'pl-key')
      setup.cleanup()
    })
  }

  test('opencode agents that list a connection also get its MCP server', () => {
    setConnectionKey('pixellab', 'pl-key')
    const setup = prepareMcp('opencode', ['pixellab'], 'run-2')
    const config = JSON.parse(setup.env.OPENCODE_CONFIG_CONTENT)
    assert.equal(config.mcp.pixellab.url, 'https://api.pixellab.ai/mcp')
    assert.equal(setup.env.PIXELLAB_API_KEY, 'pl-key')
  })

  test('a removed key is no longer handed out', () => {
    setConnectionKey('pixellab', 'pl-key')
    setConnectionKey('pixellab', '')
    assert.equal(prepareMcp('opencode', [], 'run-3').env.PIXELLAB_API_KEY, undefined)
  })
})
