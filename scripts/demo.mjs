import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Always use a fresh, local-only board. Never reuse the user's project database or CLI setup.
process.env.AGENTDECK_DATA = mkdtempSync(join(tmpdir(), 'agentdeck-demo-'))
process.env.AGENTDECK_MOCK = '1'
process.env.AGENTDECK_MOCK_MS = '1500'
process.env.AGENTDECK_DEMO = '1'
process.env.AGENTDECK_TOKEN = ''
process.env.AGENTDECK_TRUST_PROXY = '0'
process.env.HOST = '127.0.0.1'
process.env.PORT ??= '8791'

const { applyBlueprint } = await import('../server/blueprint.ts')

applyBlueprint({
  project: {
    key: 'OBS',
    name: 'Observatory',
    description: 'An example team building a night-sky guide. All agent activity is simulated.',
    paused: true,
    settings: { maxConcurrent: 1, fallbackEnabled: false },
  },
  agents: [
    { name: 'Atlas', role: 'Builder', provider: 'mock' },
    { name: 'Lyra', role: 'Reviewer', provider: 'mock' },
  ],
  issues: [
    { title: 'Sketch the star map layout', status: 'done', assignee: 'Atlas' },
    { title: 'Check the constellation labels', status: 'review', assignee: 'Atlas' },
    {
      title: 'Write the first stargazing guide',
      description: '## Task\nDraft a beginner-friendly guide.\n\n## Done when\n- The guide explains where to look and what to bring.',
      status: 'todo',
      assignee: 'Atlas',
      reviewers: ['Lyra'],
      priority: 2,
    },
    { title: 'Add a red-light reading mode', status: 'backlog', assignee: 'Atlas' },
  ],
})

await import('../server/main.ts')
