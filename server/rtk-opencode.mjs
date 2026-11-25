import { execFile } from 'node:child_process'

// RTK checks that the rewrite preserves OpenCode's permission decision.
async function rewrite(tool, input, agent) {
  if (process.env.RTK_DISABLED === '1' || !['bash', 'shell'].includes(tool) || typeof input?.command !== 'string')
    return
  const args = ['hook', 'opencode', ...(agent ? ['--agent', agent] : []), '--', input.command]
  await new Promise((resolve) => {
    const cwd = typeof input.workdir === 'string' ? input.workdir : undefined
    execFile('rtk', args, { cwd, timeout: 3000, windowsHide: true }, (error, stdout) => {
      if (!error) {
        try {
          const { command } = JSON.parse(stdout)
          if (typeof command === 'string' && command.trim()) input.command = command
        } catch {}
      }
      resolve()
    })
  })
}

export default {
  id: 'agentdeck-rtk',
  async setup(ctx) {
    await ctx.tool.hook('execute.before', (e) => rewrite(e.tool, e.input, e.agent))
  },
  // Compatibility with the OpenCode 1 CLI in existing AgentDeck installations.
  async server() {
    return { 'tool.execute.before': (input, output) => rewrite(input.tool, output.args) }
  },
}
