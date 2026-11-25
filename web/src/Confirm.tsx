import { createSignal, For, Show } from 'solid-js'
import { Modal } from './ui'

/** Names of the settings the server runs as shell commands, as the settings page calls them. */
const FIELD_LABELS: Record<string, string> = {
  'precheck.command': 'Check command',
  'precheck.quickCommand': 'Quick check command',
  'preview.command': 'Start command of the preview',
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
        <Modal title="Confirm change" onClose={() => finish(null)}>
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
                Affected:{' '}
                <For each={current().fields}>
                  {(field, index) => (
                    <>
                      {index() ? ', ' : ''}
                      {FIELD_LABELS[field] ?? field}
                    </>
                  )}
                </For>
              </p>
            </Show>
            <input
              type="password"
              autocomplete="current-password"
              autofocus
              placeholder="Access token (AGENTDECK_TOKEN)"
              value={token()}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
            <footer>
              <span class="spacer" />
              <button type="button" onClick={() => finish(null)}>
                Cancel
              </button>
              <button class="primary" type="submit" disabled={!token()}>
                Confirm
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </Show>
  )
}
