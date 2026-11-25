// A small coding agent for providers that only offer an OpenAI-compatible chat API (Deepseek).
// The CLIs bring their own agent loop; here we run it ourselves: ask the model, execute the tools
// it calls inside the issue's working directory, repeat until it answers without tool calls.
import { join } from 'node:path'
import { safeEnv } from './auth.ts'
// @ts-ignore: plain ES module shared with the sandboxed process
import { fileTool } from './agentFiles.mjs'
import { ownerOf, SANDBOX, spawnIn, spawnShellIn, stopGroup } from './sandbox.ts'
import type { RunHandle, RunOpts, RunResult, Usage } from './adapters.ts'
import { connectionKeys } from './mcp.ts'
import { rewriteCommand, rtkInstalled, RTK_INSTRUCTIONS } from './rtk.ts'

const MAX_STEPS = 80
const MAX_TOOL_OUTPUT = 12_000
const COMMAND_TIMEOUT_MS = 120_000
const AGENT_FILES = join(import.meta.dirname, 'agentFiles.mjs')

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }

const tool = (name: string, description: string, properties: Record<string, string>) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, text]) => [key, { type: 'string', description: text }]),
      ),
      required: Object.keys(properties),
    },
  },
})

const READ_TOOLS = [
  tool('read_file', 'Read a text file.', { path: 'Path relative to the working directory' }),
  tool('list_dir', 'List the entries of a directory.', { path: 'Directory, "." for the working directory' }),
]

const WRITE_TOOLS = [
  tool('write_file', 'Create or overwrite a file.', {
    path: 'Path relative to the working directory',
    content: 'Full file content',
  }),
  tool('edit_file', 'Replace one exact, unique occurrence of a string in a file.', {
    path: 'Path relative to the working directory',
    old_text: 'Exact text to replace',
    new_text: 'Replacement',
  }),
  tool('run_command', 'Run a shell command in the working directory (builds, tests, git).', {
    command: 'The command line',
  }),
]

const clip = (text: string) =>
  text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) + '\n… (output truncated)' : text

export function startApiRun(opts: RunOpts, baseUrl: string, apiKey: string, model: string): RunHandle {
  const abort = new AbortController()
  const usage: Usage = { input: 0, output: 0, cost: 0 }

  /** File tools stay inside the working directory; in the sandbox they run as the project user. */
  function onFiles(tool: string, args: Record<string, string>): Promise<string> {
    // A read-only question of the owner outside any project (blueprints) may read as the server.
    const sandboxed = SANDBOX && (opts.autonomous || ownerOf(opts.cwd))
    if (!sandboxed) return fileTool(opts.cwd, tool, args).catch((err: Error) => `Error: ${err.message}`)
    return new Promise((done) => {
      const child = spawnIn(opts.cwd, process.execPath, [AGENT_FILES, opts.cwd, tool], {}, true)
      let output = ''
      child.stdout!.on('data', (chunk) => (output += chunk))
      child.on('error', (err) => done(`Error: ${err.message}`))
      child.on('close', () => done(output))
      child.stdin!.end(JSON.stringify(args))
    })
  }

  async function runCommand(command: string) {
    const env = safeEnv({ ...connectionKeys(), ...opts.env })
    const rewritten = await rewriteCommand(opts.cwd, command, env)
    if (abort.signal.aborted) return 'Command canceled'
    return new Promise<string>((done) => {
      const child = spawnShellIn(opts.cwd, rewritten, {
        env,
        windowsHide: true,
        // Its own process group, so a timeout or a stop ends what the command started too.
        detached: process.platform !== 'win32',
      })
      let output = ''
      const collect = (chunk: Buffer) => (output = (output + chunk).slice(-MAX_TOOL_OUTPUT * 2))
      child.stdout!.on('data', collect)
      child.stderr!.on('data', collect)
      const stop = () => stopGroup(child.pid)
      const timer = setTimeout(stop, COMMAND_TIMEOUT_MS)
      abort.signal.addEventListener('abort', stop, { once: true })
      child.on('error', (err) => done(`Command failed to start: ${err.message}`))
      child.on('close', (code) => {
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', stop)
        done(`${output.trim()}\n[exit code ${code}]`)
      })
    })
  }

  async function execute(name: string, args: Record<string, string>): Promise<string> {
    switch (name) {
      case 'read_file':
      case 'list_dir':
      case 'write_file':
      case 'edit_file':
        return onFiles(name, args)
      case 'run_command':
        return runCommand(args.command)
      default:
        return `Unknown tool ${name}`
    }
  }

  async function ask(messages: Message[]) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: opts.autonomous ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS,
      }),
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error?.message ?? `API answered with HTTP ${res.status}`)

    usage.input += data.usage?.prompt_tokens ?? 0
    usage.cached = (usage.cached ?? 0) + (data.usage?.prompt_cache_hit_tokens ?? 0)
    usage.output += data.usage?.completion_tokens ?? 0
    return data.choices?.[0]?.message as Message
  }

  async function loop(): Promise<RunResult> {
    const messages: Message[] = [
      {
        role: 'system',
        content:
          `You are a coding agent working in ${opts.cwd} on ${process.platform}. ` +
          'Use the tools to inspect files' +
          (opts.autonomous ? ', change them and run commands. ' : '. You cannot change anything. ') +
          (opts.env?.RTK_DB_PATH && rtkInstalled() ? `${RTK_INSTRUCTIONS} ` : '') +
          'When the task is finished, reply with your final message and no tool call.',
      },
      { role: 'user', content: opts.prompt },
    ]

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await ask(messages)
      if (!reply) throw new Error('The API returned no answer')
      messages.push(reply)
      if (reply.content) {
        opts.onActivity?.(reply.content)
        opts.onEvent?.({ kind: 'assistant', text: reply.content })
      }

      if (!reply.tool_calls?.length) return { ok: true, text: reply.content ?? '', usage }

      for (const call of reply.tool_calls) {
        opts.onActivity?.(`${call.function.name}: ${call.function.arguments}`)
        opts.onEvent?.({ kind: 'tool_call', name: call.function.name, text: call.function.arguments ?? '' })
        let result: string
        let failed = false
        try {
          result = await execute(call.function.name, JSON.parse(call.function.arguments || '{}'))
        } catch (err: any) {
          result = `Error: ${err.message}`
          failed = true
        }
        opts.onEvent?.({ kind: failed ? 'error' : 'tool_result', name: call.function.name, text: result })
        messages.push({ role: 'tool', tool_call_id: call.id, content: clip(result) })
      }
    }
    return { ok: false, text: '', usage, error: `Not finished after ${MAX_STEPS} steps` }
  }

  const done = loop().catch((err): RunResult => ({ ok: false, text: '', usage, error: err.message }))
  return { kill: () => abort.abort(), done }
}
