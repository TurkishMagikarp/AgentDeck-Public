import { createResource, createSignal, For, Show } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from './api'
import { t } from './i18n'
import { agentById, board, fail } from './store'
import { Field, Modal, Select, Toggle } from './ui'

type Routine = {
  id?: number
  name: string
  agent_id: number | null
  prompt: string
  schedule: 'daily' | 'interval'
  at: string
  every_minutes: number
  enabled: boolean | number
  only_when_idle: boolean | number
}

// Labels are German keys; they are translated where the Select renders them.
const SCHEDULES = [
  ['daily', 'Täglich um'],
  ['interval', 'Alle … Minuten'],
] as const

const newRoutine = (): Routine => ({
  name: '',
  agent_id: board.agents[0]?.id ?? null,
  prompt: '',
  schedule: 'daily',
  at: '07:00',
  every_minutes: 60,
  enabled: true,
  only_when_idle: false,
})

function describeSchedule(routine: Routine) {
  const when =
    routine.schedule === 'daily'
      ? t('täglich um {at}', { at: routine.at })
      : t('alle {n} Minuten', { n: routine.every_minutes })
  return routine.only_when_idle ? t('{when}, wenn nichts offen ist', { when }) : when
}

export function Routines() {
  const projectId = () => board.project!.id
  const [routines, { refetch }] = createResource(projectId, (id) =>
    api.get<Routine[]>(`/projects/${id}/routines`),
  )
  const [editing, setEditing] = createSignal<Routine | null>(null)

  function close() {
    setEditing(null)
    refetch()
  }

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <h2>{t('Routinen')}</h2>
          <p class="muted">
            {t('Wiederkehrende Arbeit. Ist eine Routine fällig, legt sie ein Issue für ihren Agenten an. Solange das letzte noch offen ist, kommt kein weiteres dazu.')}
          </p>
        </div>
        <button class="primary" onClick={() => setEditing(newRoutine())}>
          {t('Routine hinzufügen')}
        </button>
      </div>

      <div class="grid">
        <For each={routines()} fallback={<p class="muted">{t('Noch keine Routinen.')}</p>}>
          {(routine) => (
            <article
              class="tile"
              classList={{ disabled: !routine.enabled }}
              onClick={() => setEditing({ ...routine })}
            >
              <strong>{routine.name}</strong>
              <p class="muted">
                {describeSchedule(routine)} · {agentById(routine.agent_id)?.name ?? t('beliebiger Agent')}
              </p>
              <p class="clamp">{routine.prompt}</p>
            </article>
          )}
        </For>
      </div>

      <Show when={editing()}>{(routine) => <RoutineForm routine={routine()} onClose={close} />}</Show>
    </div>
  )
}

function RoutineForm(props: { routine: Routine; onClose: () => void }) {
  const [draft, setDraft] = createStore<Routine>(props.routine)

  async function save(e: SubmitEvent) {
    e.preventDefault()
    try {
      if (draft.id) await api.patch(`/routines/${draft.id}`, draft)
      else await api.post(`/projects/${board.project!.id}/routines`, draft)
      props.onClose()
    } catch (err) {
      fail(err)
    }
  }

  async function remove() {
    if (!confirm(t('Routine "{name}" löschen?', { name: draft.name }))) return
    await api.del(`/routines/${draft.id}`).catch(fail)
    props.onClose()
  }

  return (
    <Modal title={draft.id ? t('Routine bearbeiten') : t('Neue Routine')} onClose={props.onClose}>
      <form class="form" onSubmit={save}>
        <div class="row">
          <Field label={t('Name')}>
            <input required value={draft.name} onInput={(e) => setDraft('name', e.currentTarget.value)} />
          </Field>
          <Field label={t('Agent')}>
            <select onChange={(e) => setDraft('agent_id', Number(e.currentTarget.value) || null)}>
              <option value="">{t('Beliebiger freier Agent')}</option>
              <For each={board.agents}>
                {(agent) => (
                  <option value={agent.id} selected={agent.id === draft.agent_id}>
                    {agent.name}
                  </option>
                )}
              </For>
            </select>
          </Field>
        </div>

        <div class="row">
          <Field label={t('Rhythmus')}>
            <Select
              value={draft.schedule}
              options={SCHEDULES.map(([value, label]) => [value, t(label)] as const)}
              onChange={(value) => setDraft('schedule', value)}
            />
          </Field>
          <Show
            when={draft.schedule === 'daily'}
            fallback={
              <Field label={t('Minuten')} hint={t('Mindestens 5')}>
                <input
                  type="number"
                  min="5"
                  value={draft.every_minutes}
                  onInput={(e) => setDraft('every_minutes', Number(e.currentTarget.value))}
                />
              </Field>
            }
          >
            <Field label={t('Uhrzeit')} hint={t('Zeitzone des Servers')}>
              <input type="time" value={draft.at} onInput={(e) => setDraft('at', e.currentTarget.value)} />
            </Field>
          </Show>
        </div>

        <Field label={t('Auftrag')} hint={t('Wird zur Beschreibung des angelegten Issues')}>
          <textarea
            rows="8"
            value={draft.prompt}
            onInput={(e) => setDraft('prompt', e.currentTarget.value)}
          />
        </Field>

        <Toggle
          label={t('Nur wenn nichts offen ist')}
          title={t('Wartet, bis kein Issue mehr in Arbeit, Review oder blockiert ist. Für Planer, die die nächste Aufgabe anlegen.')}
          checked={!!draft.only_when_idle}
          onChange={(on) => setDraft('only_when_idle', on)}
        />
        <Toggle label={t('Aktiv')} checked={!!draft.enabled} onChange={(on) => setDraft('enabled', on)} />

        <footer>
          <Show when={draft.id}>
            <button type="button" class="ghost danger" onClick={remove}>
              {t('Löschen')}
            </button>
          </Show>
          <span class="spacer" />
          <button type="button" onClick={props.onClose}>
            {t('Abbrechen')}
          </button>
          <button class="primary" type="submit">
            {t('Speichern')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
