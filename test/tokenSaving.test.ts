import './setup.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { newState, parse, withContextLimit } from '../server/adapters.ts'
import { connectionsFor } from '../server/mcp.ts'
import { buildPrompt } from '../server/prompt.ts'
import { mergeSettings } from '../server/core.ts'

describe('opencode context limit', () => {
  test('the model of the run gets a window that makes opencode compact at the threshold', () => {
    const config = JSON.parse(withContextLimit(undefined, 'opencode-go/deepseek-v4.1-flash', 100_000)!)
    assert.deepEqual(config.provider['opencode-go'].models['deepseek-v4.1-flash'].limit, {
      context: 132_000,
      output: 32_000,
    })
  })

  test('MCP servers, plugins and other models of the provider stay', () => {
    const before = JSON.stringify({
      mcp: { github: { type: 'remote' } },
      plugin: ['file:///app/rtk-opencode.mjs'],
      provider: { 'opencode-go': { models: { other: { limit: { context: 5, output: 1 } } } } },
    })
    const config = JSON.parse(withContextLimit(before, 'opencode-go/deepseek-v4.1-flash', 100_000)!)
    assert.equal(config.mcp.github.type, 'remote')
    assert.deepEqual(config.plugin, ['file:///app/rtk-opencode.mjs'])
    assert.equal(config.provider['opencode-go'].models.other.limit.context, 5)
  })

  test('a model id with slashes keeps them', () => {
    const config = JSON.parse(withContextLimit(undefined, 'openrouter/deepseek/flash', 50_000)!)
    assert.ok(config.provider.openrouter.models['deepseek/flash'])
  })

  test('no model or a threshold of 0 changes nothing', () => {
    assert.equal(withContextLimit('{"mcp":{}}', '', 100_000), '{"mcp":{}}')
    assert.equal(withContextLimit(undefined, 'opencode-go/deepseek-v4.1-flash', 0), undefined)
  })
})

describe('opencode final answer', () => {
  const textOf = (texts: string[]) => {
    const st = newState()
    for (const text of texts) parse('opencode', 'test', { type: 'text', part: { text } }, st, () => {})
    return st.text
  }

  test('what a compaction says after the answer does not replace it', () => {
    const answer = '<summary>Fertig: Karte gebaut.</summary>\n<status>review</status>'
    assert.equal(textOf(['Ich lese die Karte.', answer, '## Objective\n…', 'No next steps remain.']), answer)
  })

  test('a later answer with a status wins', () => {
    assert.equal(textOf(['<status>blocked</status>', '<status>done</status>']), '<status>done</status>')
  })

  test('without any status the last text counts', () => {
    assert.equal(textOf(['eins', 'zwei']), 'zwei')
  })
})

describe('on-demand connections', () => {
  const issue = { title: 'Wegmarken setzen', description: 'Karte anpassen', checklist: [], mcp_wanted: [] }

  test('PixelLab stays out of an issue that does not name it, the others come along', () => {
    assert.deepEqual(connectionsFor(['pixellab', 'elevenlabs', 'github'], issue), ['elevenlabs', 'github'])
  })

  test('an issue that names it gets it', () => {
    assert.deepEqual(connectionsFor(['pixellab'], { ...issue, description: 'Sprite mit PixelLab erzeugen' }), [
      'pixellab',
    ])
    assert.deepEqual(connectionsFor(['pixellab'], { ...issue, checklist: ['pixellab tileset liegt vor'] }), [
      'pixellab',
    ])
  })

  test('an agent that asked for it gets it in the next run', () => {
    assert.deepEqual(connectionsFor(['pixellab'], { ...issue, mcp_wanted: ['pixellab'] }), ['pixellab'])
  })

  test('the prompt of a work run says what is missing and how to get it', () => {
    const prompt = (kind: 'work' | 'review', heldBack: string[], language = 'en') =>
      buildPrompt({
        project: { id: 1, key: 'SHOP', name: 'Demo shop', settings: mergeSettings({ language }) },
        issue: { id: 1, number: 7, title: 'Wegmarken', description: '' },
        agent: { id: 2, name: 'World builder', skill_ids: [] },
        team: [],
        workdir: { cwd: '.' } as any,
        kind,
        heldBack,
      })
    assert.match(prompt('work', ['pixellab']), /MCP tools of PixelLab \(`pixellab`\) are not loaded/)
    assert.match(prompt('work', ['pixellab']), /handoff:World builder/)
    assert.doesNotMatch(prompt('work', []), /Tools not loaded/)
    assert.doesNotMatch(prompt('review', ['pixellab']), /Tools not loaded/)
    assert.match(prompt('review', []), /Use few steps/)
    assert.match(prompt('work', ['pixellab'], 'de'), /MCP-Werkzeuge von PixelLab \(`pixellab`\) in diesem Lauf nicht geladen/)
    assert.match(prompt('review', [], 'de'), /Brauch wenige Schritte/)
  })
})
