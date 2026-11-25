import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import { fail } from './store'
import { Modal } from './ui'

type Entry = { id: number; at: number; actor: string; action: string; target: string; detail: Record<string, any> }

const ACTIONS: Record<string, string> = {
  login: 'Logged in',
  'login.failed': 'Login failed',
  logout: 'Logged out',
  'confirm.failed': 'Confirmation with a wrong token',
  'confirm.refused': 'Command change refused (no token set)',
  'project.create': 'Project created',
  'project.update': 'Project changed',
  'project.delete': 'Project deleted',
  'project.import': 'Project imported',
  'project.template': 'Project from a template',
  'project.blueprint': 'Blueprint applied',
  'agent.create': 'Agent created',
  'agent.update': 'Agent changed',
  'agent.delete': 'Agent deleted',
  'agent.switch-provider': 'Provider switched',
  'skill.create': 'Skill created',
  'skill.update': 'Skill changed',
  'skill.delete': 'Skill deleted',
  'provider.access': 'Access changed',
  'provider.resets': 'Resets changed',
  'provider.login': 'Login started',
  'provider.login-cancel': 'Login canceled',
  'routine.create': 'Routine created',
  'routine.update': 'Routine changed',
  'routine.delete': 'Routine deleted',
  'mail.settings': 'Mail settings changed',
  'report.settings': 'Morning report changed',
  'mcp.key': 'MCP key changed',
  'push.subscribe': 'Push device added',
  'push.unsubscribe': 'Push device removed',
}

const PAGE = 50

const DETAIL_NAMES: Record<string, string> = {
  changed: 'Changed',
  fields: 'Fields',
  mode: 'Mode',
  agents: 'Agents',
  issues: 'Issues',
  settings: 'Settings',
  enabled: 'On',
  template: 'Template',
  provider: 'Provider',
  at: 'Time',
}

/** One line per detail: "field: old → new", lists joined, everything else as it was stored. */
function describe(detail: Record<string, any>) {
  return Object.entries(detail ?? {}).map(([key, value]) => {
    const name = DETAIL_NAMES[key] ?? key
    if (value && typeof value === 'object' && 'from' in value && 'to' in value)
      return `${name}: ${value.from} → ${value.to}`
    if (Array.isArray(value)) return `${name}: ${value.join(', ') || '–'}`
    return `${name}: ${typeof value === 'object' ? JSON.stringify(value) : value}`
  })
}

/** Read-only list of the owner's changes, newest first (server/audit.ts). */
export function AuditLog(props: { onClose: () => void }) {
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [more, setMore] = createSignal(false)

  async function load() {
    const last = entries().at(-1)
    const page = await api.get<Entry[]>(`/audit?limit=${PAGE}${last ? `&before=${last.id}` : ''}`)
    setEntries([...entries(), ...page])
    setMore(page.length === PAGE)
  }
  onMount(() => load().catch(fail))

  return (
    <Modal title="Audit log" wide onClose={props.onClose}>
      <p class="muted">
        Who changed which settings, access, agents and routines. Secret values never show up
        here, only that they changed. Entries stay for 180 days.
      </p>
      <Show when={entries().length} fallback={<p class="muted">No entries yet.</p>}>
        <table class="audit">
          <thead>
            <tr>
              <th>Time</th>
              <th>Who</th>
              <th>What</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <For each={entries()}>
              {(entry) => (
                <tr>
                  <td class="audit-time">{new Date(entry.at).toLocaleString('en-US')}</td>
                  <td>{entry.actor}</td>
                  <td>
                    {ACTIONS[entry.action] ?? entry.action}
                    <Show when={entry.target}>
                      <div class="muted mono">{entry.target}</div>
                    </Show>
                  </td>
                  <td class="audit-detail">
                    <For each={describe(entry.detail)}>{(line) => <div>{line}</div>}</For>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={more()}>
        <footer class="audit-more">
          <button onClick={() => load().catch(fail)}>Load older</button>
        </footer>
      </Show>
    </Modal>
  )
}
