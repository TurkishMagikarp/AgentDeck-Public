import './setup.ts'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { rewriteCommand, rtkEnv, rtkInstalled, rtkRewriteResult, withRtkPlugin } from '../server/rtk.ts'
import { startApiRun } from '../server/apiAgent.ts'
// @ts-ignore: OpenCode loads the same plain ES module
import openCodePlugin from '../server/rtk-opencode.mjs'

test('each project and agent tracks RTK in its own database', () => {
  const env = rtkEnv('ONE', 1)
  assert.match(env.RTK_DB_PATH, /ONE[/\\]agent-1\.db$/)
  assert.notEqual(env.RTK_DB_PATH, rtkEnv('TWO', 1).RTK_DB_PATH)
  assert.notEqual(env.RTK_DB_PATH, rtkEnv('ONE', 2).RTK_DB_PATH)
  assert.equal(env.RTK_TELEMETRY_DISABLED, '1')
})

test('OpenCode registration keeps MCP and other configured plugins', () => {
  const config = { mcp: { tools: { type: 'local' } }, plugin: ['another-plugin'] }
  const add = (raw: string) => withRtkPlugin(raw, 'file:///app/rtk-opencode.mjs')
  assert.deepEqual(JSON.parse(add(add(JSON.stringify(config)))), {
    ...config, plugin: ['another-plugin', 'file:///app/rtk-opencode.mjs'],
  })
})

test('RTK only substitutes successful rewrites, including advisory exit 3', () => {
  for (const code of [0, 3]) assert.equal(rtkRewriteResult(code, 'rtk git status\n', 'git status'), 'rtk git status')
  for (const code of [1, 2, 128]) assert.equal(rtkRewriteResult(code, 'untrusted output', 'git status'), 'git status')
  assert.equal(rtkRewriteResult(0, '  ', 'printf x'), 'printf x')
})

test('DeepSeek passes supported commands through the installed RTK rewrite engine', { skip: !rtkInstalled() }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentdeck-rtk-'))
  const env = { ...process.env, ...rtkEnv('ONE', 3), RTK_DISABLED: '0' }
  assert.equal(await rewriteCommand(cwd, 'git status', env), 'rtk git status')
  assert.equal(await rewriteCommand(cwd, 'git status', { ...env, RTK_DISABLED: '1' }), 'git status')
})

test('the OpenCode hook rewrites shell calls only', { skip: !rtkInstalled() }, async () => {
  const hooks = await openCodePlugin.server()
  const before = hooks['tool.execute.before']
  const workdir = mkdtempSync(join(tmpdir(), 'agentdeck-rtk-'))
  const shell = { args: { command: 'git status', workdir } }
  const other = { args: { command: 'git status', workdir } }
  await before({ tool: 'bash' }, shell)
  await before({ tool: 'read' }, other)
  assert.equal(shell.args.command, 'rtk git status')
  assert.equal(other.args.command, 'git status')
})

test('DeepSeek returns compact shell output and records the command for the assigned agent', {
  skip: !rtkInstalled(),
}, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentdeck-rtk-'))
  execFileSync('git', ['init', '-q'], { cwd })
  const env = rtkEnv('ONE', 12)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, req: { body: string }) => {
    if (++requests === 1) {
      return Response.json({ choices: [{ message: {
        role: 'assistant', content: null, tool_calls: [{
          id: 'shell', function: { name: 'run_command', arguments: JSON.stringify({ command: 'git status' }) },
        }],
      } }] })
    }
    const last = JSON.parse(req.body).messages.at(-1)
    assert.equal(last.role, 'tool')
    assert.match(last.content, /\[exit code 0\]/)
    assert.match(last.content, /^\* No commits yet on /)
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
  })
  const handle = startApiRun(
    { provider: 'deepseek', cwd, env, autonomous: true, prompt: 'Check the working tree' },
    'https://example.invalid', 'test', 'deepseek-chat',
  )
  const result = await handle.done
  assert.equal(result.ok, true, result.error)
  const { summary } = JSON.parse(execFileSync('rtk', ['gain', '--format', 'json'], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
  }))
  assert.equal(summary.total_commands, 1)
})
