import { createResource, createSignal, For, Show } from 'solid-js'
import { api } from './api'
import { Icon } from './icons'
import { t } from './i18n'

type FileChange = {
  path: string
  added: number
  removed: number
  binary: boolean
  patch: string
  cut: boolean
}
type Changes = {
  state: 'no-repo' | 'no-branch' | 'changes' | 'landed-or-empty'
  branch: string
  base: string
  commits: { hash: string; subject: string; at: number }[]
  files: FileChange[]
  uncommitted: FileChange[]
}

const total = (files: FileChange[], key: 'added' | 'removed') =>
  files.reduce((sum, file) => sum + file[key], 0)

/**
 * The code an issue changed: its branch against the base, plus what the agent has not committed
 * yet. Loads only when opened, and again whenever `version` moves (a comment, a finished run).
 */
export function Changes(props: { issueId: number; version: number }) {
  const [open, setOpen] = createSignal(false)
  const [changes, { refetch }] = createResource(
    () => (open() ? { id: props.issueId, version: props.version } : false),
    ({ id }) => api.get<Changes>(`/issues/${id}/changes`),
  )

  const summary = () => {
    const data = changes()
    if (!data) return ''
    if (data.state === 'no-repo') return t('kein Git-Repository')
    if (data.state === 'no-branch' && !data.uncommitted.length) return t('noch kein Branch')
    if (data.state === 'landed-or-empty' && !data.uncommitted.length)
      return t('nichts offen gegenüber {base}', { base: data.base })
    const files = [...data.files, ...data.uncommitted]
    const commits = data.commits.length === 1 ? t('1 Commit') : t('{n} Commits', { n: data.commits.length })
    const fileCount = files.length === 1 ? t('1 Datei') : t('{n} Dateien', { n: files.length })
    return `${commits} · ${fileCount} · +${total(files, 'added')} −${total(files, 'removed')}`
  }

  return (
    <section class="changes">
      <div class="changes-head">
        <button class="ghost" onClick={() => setOpen(!open())} aria-expanded={open()}>
          <Icon name={open() ? 'chevronDown' : 'chevronRight'} size={14} />
          {t('Code-Änderungen')}
        </button>
        <span class="muted">{changes.loading ? t('lädt…') : summary()}</span>
        <Show when={open()}>
          <button class="ghost icon-button" title={t('Neu laden')} aria-label={t('Neu laden')} onClick={refetch}>
            <Icon name="refresh" size={14} />
          </button>
        </Show>
      </div>
      <Show when={open() && changes()}>
        {(data) => (
          <>
            <Show when={data().commits.length}>
              <ul class="commits">
                <For each={data().commits}>
                  {(commit) => (
                    <li>
                      <code>{commit.hash}</code> {commit.subject}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <FileList files={data().files} />
            <Show when={data().uncommitted.length}>
              <h5>{t('Noch nicht committet')}</h5>
              <FileList files={data().uncommitted} />
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}

function FileList(props: { files: FileChange[] }) {
  return (
    <ul class="files">
      <For each={props.files}>{(file) => <FileItem file={file} />}</For>
    </ul>
  )
}

function FileItem(props: { file: FileChange }) {
  const [open, setOpen] = createSignal(false)
  const lineClass = (line: string) =>
    line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''

  return (
    <li>
      <button class="file" onClick={() => setOpen(!open())} aria-expanded={open()}>
        <span class="mono">{props.file.path}</span>
        <span class="add">+{props.file.added}</span>
        <span class="del">−{props.file.removed}</span>
      </button>
      <Show when={open()}>
        <Show when={!props.file.binary} fallback={<p class="muted">{t('Binärdatei')}</p>}>
          <pre class="patch">
            <For each={props.file.patch.split('\n')}>
              {(line) => <div class={lineClass(line)}>{line || ' '}</div>}
            </For>
          </pre>
          <Show when={props.file.cut}>
            <p class="muted">{t('Gekürzt, die Datei hat mehr Änderungen.')}</p>
          </Show>
        </Show>
      </Show>
    </li>
  )
}
