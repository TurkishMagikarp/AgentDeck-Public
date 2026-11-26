import { createSignal, For, Show } from 'solid-js'
import { Modal } from './ui'
import { t } from './i18n'

/** Names of the settings the server runs as shell commands, as the settings page calls them. */
const FIELD_LABELS: Record<string, string> = {
  'precheck.command': 'Prüfbefehl',
  'precheck.quickCommand': 'Schneller Prüfbefehl',
  'preview.command': 'Startbefehl der Vorschau',
}

type Pending = { message: string; fields: string[]; resolve: (token: string | null) => void }
const [pending, setPending] = createSignal<Pending | null>(null)

/**
 * Asks for the access token before a change to a command the server runs (see server/reauth.ts).
 * Resolves null when the dialog is closed. The token lives only in this request, never in storage.
 */
export function askConfirmToken(message: string, fields: string[] = []) {
  return new Promise<string | null>((resolve) => {
    pending()?.resolve(null)
    setPending({ message, fields, resolve })
  })
}

export function ConfirmToken() {
  const [token, setToken] = createSignal('')
  const finish = (value: string | null) => {
    const current = pending()
    setPending(null)
    setToken('')
    current?.resolve(value)
  }

  return (
    <Show when={pending()}>
      {(current) => (
        <Modal title={t('Änderung bestätigen')} onClose={() => finish(null)}>
          <form
            class="form"
            onSubmit={(e) => {
              e.preventDefault()
              if (token()) finish(token())
            }}
          >
            <p>{current().message}</p>
            <Show when={current().fields.length}>
              <p class="muted">
                {t('Betroffen:')}{' '}
                <For each={current().fields}>
                  {(field, index) => (
                    <>
                      {index() ? ', ' : ''}
                      {FIELD_LABELS[field] ? t(FIELD_LABELS[field]) : field}
                    </>
                  )}
                </For>
              </p>
            </Show>
            <input
              type="password"
              autocomplete="current-password"
              autofocus
              placeholder={t('Zugangs-Token (AGENTDECK_TOKEN)')}
              value={token()}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
            <footer>
              <span class="spacer" />
              <button type="button" onClick={() => finish(null)}>
                {t('Abbrechen')}
              </button>
              <button class="primary" type="submit" disabled={!token()}>
                {t('Bestätigen')}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </Show>
  )
}
