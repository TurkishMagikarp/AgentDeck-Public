import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import { fail } from './store'
import { Modal } from './ui'
import { locale, t } from './i18n'

type Role = 'viewer' | 'operator' | 'admin'
type User = { id: number; name: string; role: Role; created_at: number; last_used_at: number | null }

export const ROLE_LABELS: Record<Role, string> = { viewer: 'Lesen', operator: 'Bedienen', admin: 'Verwalten' }
const ROLE_HINTS: Record<Role, string> = {
  viewer: 'sieht Board, Issues und Zahlen',
  operator: 'arbeitet am Board: Issues, Kommentare, Läufe stoppen, Landungen freigeben',
  admin: 'alles, auch Projekte, Agenten, Anbieter, Keys und Benutzer',
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
    if (!confirm(t('{name} entfernen? Das Token gilt danach nicht mehr.', { name: user.name }))) return
    await api.del(`/users/${user.id}`)
    await load()
  }

  return (
    <Modal title={t('Benutzer')} wide onClose={props.onClose}>
      <p class="muted">
        {t('Jeder Benutzer meldet sich mit seinem eigenen Token an. Das Board-Token bleibt der Zugang des Besitzers. Hinter dem Proxy zählt der Name, den der Proxy meldet.')}
      </p>
      <Show when={created()}>
        {(fresh) => (
          <div class="notice">
            {t('Token für')} <strong>{fresh().name}</strong>
            {t(', wird nur jetzt angezeigt:')}
            <pre class="mono">{fresh().token}</pre>
            <button onClick={() => setCreated(null)}>{t('Notiert')}</button>
          </div>
        )}
      </Show>
      <Show when={users().length} fallback={<p class="muted">{t('Noch keine Benutzer.')}</p>}>
        <table class="audit">
          <thead>
            <tr>
              <th>Name</th>
              <th>{t('Rolle')}</th>
              <th>{t('Zuletzt aktiv')}</th>
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
                        {(option) => <option value={option}>{t(ROLE_LABELS[option])}</option>}
                      </For>
                    </select>
                  </td>
                  <td class="audit-time">
                    {user.last_used_at ? new Date(user.last_used_at).toLocaleString(locale()) : '–'}
                  </td>
                  <td>
                    <button class="ghost" onClick={() => remove(user).catch(fail)}>
                      {t('Entfernen')}
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
            {(option) => <option value={option}>{t(ROLE_LABELS[option])}</option>}
          </For>
        </select>
        <button type="submit">{t('Anlegen')}</button>
      </form>
      <p class="muted">{t(ROLE_LABELS[role()])}: {t(ROLE_HINTS[role()])}.</p>
    </Modal>
  )
}
