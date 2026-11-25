import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import { fail } from './store'
import { Modal } from './ui'

type Role = 'viewer' | 'operator' | 'admin'
type User = { id: number; name: string; role: Role; created_at: number; last_used_at: number | null }

export const ROLE_LABELS: Record<Role, string> = { viewer: 'Viewer', operator: 'Operator', admin: 'Admin' }
const ROLE_HINTS: Record<Role, string> = {
  viewer: 'sees the board, issues and numbers',
  operator: 'works the board: issues, comments, stopping runs, approving landings',
  admin: 'everything, including projects, agents, providers, keys and users',
}

/** People with their own token and role (server/users.ts, server/roles.ts). */
export function Users(props: { onClose: () => void }) {
  const [users, setUsers] = createSignal<User[]>([])
  const [name, setName] = createSignal('')
  const [role, setRole] = createSignal<Role>('viewer')
  const [created, setCreated] = createSignal<{ name: string; token: string } | null>(null)

  const load = async () => setUsers(await api.get<User[]>('/users'))
  onMount(() => load().catch(fail))

  async function add(e: Event) {
    e.preventDefault()
    const result = await api.post<{ user: User; token: string }>('/users', { name: name(), role: role() })
    setCreated({ name: result.user.name, token: result.token })
    setName('')
    await load()
  }
  async function changeRole(user: User, next: Role) {
    await api.patch(`/users/${user.id}`, { role: next })
    await load()
  }
  async function remove(user: User) {
    if (!confirm(`Remove ${user.name}? The token stops working after that.`)) return
    await api.del(`/users/${user.id}`)
    await load()
  }

  return (
    <Modal title="Users" wide onClose={props.onClose}>
      <p class="muted">
        Every user logs in with a token of their own. The board token stays the access of the
        owner. Behind the proxy, the name the proxy reports counts.
      </p>
      <Show when={created()}>
        {(fresh) => (
          <div class="notice">
            Token for <strong>{fresh().name}</strong>, shown only now:
            <pre class="mono">{fresh().token}</pre>
            <button onClick={() => setCreated(null)}>Noted</button>
          </div>
        )}
      </Show>
      <Show when={users().length} fallback={<p class="muted">No users yet.</p>}>
        <table class="audit">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Last active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={users()}>
              {(user) => (
                <tr>
                  <td>{user.name}</td>
                  <td>
                    <select
                      value={user.role}
                      onChange={(e) => changeRole(user, e.currentTarget.value as Role).catch(fail)}
                    >
                      <For each={Object.keys(ROLE_LABELS) as Role[]}>
                        {(option) => <option value={option}>{ROLE_LABELS[option]}</option>}
                      </For>
                    </select>
                  </td>
                  <td class="audit-time">
                    {user.last_used_at ? new Date(user.last_used_at).toLocaleString('en-US') : '–'}
                  </td>
                  <td>
                    <button class="ghost" onClick={() => remove(user).catch(fail)}>
                      Remove
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <form class="user-add" onSubmit={(e) => add(e).catch(fail)}>
        <input
          placeholder="Name"
          maxLength={60}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          required
        />
        <select value={role()} onChange={(e) => setRole(e.currentTarget.value as Role)}>
          <For each={Object.keys(ROLE_LABELS) as Role[]}>
            {(option) => <option value={option}>{ROLE_LABELS[option]}</option>}
          </For>
        </select>
        <button type="submit">Create</button>
      </form>
      <p class="muted">{ROLE_LABELS[role()]}: {ROLE_HINTS[role()]}.</p>
    </Modal>
  )
}
