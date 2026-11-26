import { createSignal, For, onMount, Show } from 'solid-js'
import { api } from './api'
import { fail } from './store'
import { Modal } from './ui'
import { locale, t } from './i18n'

type Entry = { id: number; at: number; actor: string; action: string; target: string; detail: Record<string, any> }

const ACTIONS: Record<string, string> = {
  login: 'Angemeldet',
  'login.failed': 'Anmeldung fehlgeschlagen',
  logout: 'Abgemeldet',
  'confirm.failed': 'Bestätigung mit falschem Token',
  'confirm.refused': 'Befehlsänderung abgelehnt (kein Token gesetzt)',
  'project.create': 'Projekt angelegt',
  'project.update': 'Projekt geändert',
  'project.delete': 'Projekt gelöscht',
  'project.import': 'Projekt importiert',
  'project.template': 'Projekt aus Vorlage',
  'project.blueprint': 'Blueprint angewendet',
  'agent.create': 'Agent angelegt',
  'agent.update': 'Agent geändert',
  'agent.delete': 'Agent gelöscht',
  'agent.switch-provider': 'Anbieter gewechselt',
  'skill.create': 'Skill angelegt',
  'skill.update': 'Skill geändert',
  'skill.delete': 'Skill gelöscht',
  'provider.access': 'Zugang geändert',
  'provider.resets': 'Resets geändert',
  'provider.login': 'Login gestartet',
  'provider.login-cancel': 'Login abgebrochen',
  'routine.create': 'Routine angelegt',
  'routine.update': 'Routine geändert',
  'routine.delete': 'Routine gelöscht',
  'mail.settings': 'Mail-Einstellungen geändert',
  'report.settings': 'Morgenbericht geändert',
  'mcp.key': 'MCP-Key geändert',
  'push.subscribe': 'Push-Gerät hinzugefügt',
  'push.unsubscribe': 'Push-Gerät entfernt',
}

const PAGE = 50

const DETAIL_NAMES: Record<string, string> = {
  changed: 'Geändert',
  fields: 'Felder',
  mode: 'Modus',
  agents: 'Agenten',
  issues: 'Issues',
  settings: 'Einstellungen',
  enabled: 'An',
  template: 'Vorlage',
  provider: 'Anbieter',
  at: 'Uhrzeit',
}

/** One line per detail: "feld: alt → neu", lists joined, everything else as it was stored. */
function describe(detail: Record<string, any>) {
  return Object.entries(detail ?? {}).map(([key, value]) => {
    const name = DETAIL_NAMES[key] ? t(DETAIL_NAMES[key]) : key
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
    <Modal title={t('Änderungsprotokoll')} wide onClose={props.onClose}>
      <p class="muted">
        {t('Wer welche Einstellungen, Zugänge, Agenten und Routinen geändert hat. Geheime Werte stehen nie hier, nur dass sie sich geändert haben. Einträge bleiben 180 Tage.')}
      </p>
      <Show when={entries().length} fallback={<p class="muted">{t('Noch keine Einträge.')}</p>}>
        <table class="audit">
          <thead>
            <tr>
              <th>{t('Zeit')}</th>
              <th>{t('Wer')}</th>
              <th>{t('Was')}</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <For each={entries()}>
              {(entry) => (
                <tr>
                  <td class="audit-time">{new Date(entry.at).toLocaleString(locale())}</td>
                  <td>{entry.actor}</td>
                  <td>
                    {ACTIONS[entry.action] ? t(ACTIONS[entry.action]) : entry.action}
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
          <button onClick={() => load().catch(fail)}>{t('Ältere laden')}</button>
        </footer>
      </Show>
    </Modal>
  )
}
