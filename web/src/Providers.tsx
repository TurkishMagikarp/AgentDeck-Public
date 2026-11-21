import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js'
import { api } from './api'
import { fail } from './store'
import { Modal } from './ui'

type AccessMode = 'subscription' | 'apikey'

type ProviderAccess = {
  id: string
  label: string
  modes: AccessMode[]
  canLogin: boolean
  mode: AccessMode
  hasKey: boolean
  ready: boolean
  hasSubscriptionToken: boolean
}

type LoginState = {
  state: 'idle' | 'waiting' | 'done' | 'failed'
  url?: string
  code?: string
  needsCode?: boolean
  message?: string
}

type McpConnection = { id: string; label: string; description: string; keyLabel: string; hasKey: boolean }

const MODE_LABELS: Record<AccessMode, string> = { subscription: 'Subscription', apikey: 'API key' }

export function Providers(props: { onClose: () => void }) {
  const [providers, { refetch }] = createResource(() => api.get<ProviderAccess[]>('/providers'))
  const [connections, { refetch: reloadConnections }] = createResource(() => api.get<McpConnection[]>('/mcp'))

  return (
    <Modal title="Providers and access" onClose={props.onClose} wide>
      <p class="muted intro">
        Applies to all projects. In subscription mode AgentDeck uses each CLI's login on this server. In API
        key mode you pay per token.
      </p>
      <div class="provider-list">
        <For each={providers()}>{(provider) => <ProviderRow provider={provider} onChange={refetch} />}</For>
      </div>

      <h3 class="modal-section">Email to you</h3>
      <p class="muted intro">
        When an issue waits for a human, AgentDeck sends an email through AgentMail. You can turn this off per
        project.
      </p>
      <MailSettings />

      <h3 class="modal-section">MCP connections</h3>
      <p class="muted intro">
        Once a key is stored, you can assign the connection to individual agents. It works with Claude Code,
        Codex and opencode.
      </p>
      <div class="provider-list">
        <For each={connections()}>
          {(connection) => <ConnectionRow connection={connection} onChange={reloadConnections} />}
        </For>
      </div>
    </Modal>
  )
}

function ProviderRow(props: { provider: ProviderAccess; onChange: () => void }) {
  const provider = () => props.provider
  const [key, setKey] = createSignal('')

  async function save(mode: AccessMode, apiKey?: string) {
    try {
      await api.put(`/providers/${provider().id}`, { mode, apiKey })
      setKey('')
      props.onChange()
    } catch (err) {
      fail(err)
    }
  }

  async function saveSubscriptionToken(subscriptionToken: string) {
    try {
      await api.put(`/providers/${provider().id}`, { mode: 'subscription', subscriptionToken })
      setKey('')
      props.onChange()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <section class="provider">
      <header>
        <strong>{provider().label}</strong>
        <Show when={provider().mode === 'apikey'}>
          <span class="badge" classList={{ bad: !provider().hasKey }}>
            {provider().hasKey ? 'Key stored' : 'Key missing'}
          </span>
        </Show>
        <span class="spacer" />
        <div class="segmented" role="group" aria-label="Access type">
          <For each={provider().modes}>
            {(mode) => (
              <button classList={{ active: provider().mode === mode }} onClick={() => save(mode)}>
                {MODE_LABELS[mode]}
              </button>
            )}
          </For>
        </div>
      </header>

      <Switch>
        <Match when={provider().mode === 'apikey'}>
          <form
            class="key-form"
            onSubmit={(e) => {
              e.preventDefault()
              save('apikey', key())
            }}
          >
            <input
              type="password"
              autocomplete="off"
              placeholder={
                provider().hasKey ? 'Key is stored. Enter a new key to replace it' : 'Paste API key'
              }
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value)}
            />
            <button class="primary" type="submit" disabled={!key().trim()}>
              Save
            </button>
            <Show when={provider().hasKey}>
              <button type="button" class="ghost danger" onClick={() => save('apikey', '')}>
                Remove
              </button>
            </Show>
          </form>
        </Match>
        <Match when={provider().mode === 'subscription'}>
          <SubscriptionLogin provider={provider()} />
          <Show when={provider().id === 'anthropic'}>
            <form
              class="key-form"
              onSubmit={(e) => {
                e.preventDefault()
                saveSubscriptionToken(key())
              }}
            >
              <input
                type="password"
                autocomplete="off"
                placeholder={
                  provider().hasSubscriptionToken
                    ? 'Subscription token is stored. Enter a new one to replace it'
                    : 'For servers: long-lived subscription token from "claude setup-token"'
                }
                value={key()}
                onInput={(e) => setKey(e.currentTarget.value)}
              />
              <button class="primary" type="submit" disabled={!key().trim()}>
                Save
              </button>
              <Show when={provider().hasSubscriptionToken}>
                <button type="button" class="ghost danger" onClick={() => saveSubscriptionToken('')}>
                  Remove
                </button>
              </Show>
            </form>
          </Show>
        </Match>
      </Switch>
    </section>
  )
}

type Mail = { inbox: string; to: string; hasKey: boolean }

function MailSettings() {
  const [mail, { mutate }] = createResource(() => api.get<Mail>('/mail'))
  const [key, setKey] = createSignal('')
  const [sent, setSent] = createSignal(false)

  async function save(change: { inbox?: string; to?: string; apiKey?: string }) {
    try {
      mutate(await api.put<Mail>('/mail', change))
      setKey('')
    } catch (err) {
      fail(err)
    }
  }

  async function test() {
    try {
      await api.post('/mail/test')
      setSent(true)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <section class="provider">
      <div class="row">
        <label class="field">
          <span>AgentMail inbox (sender)</span>
          <input value={mail()?.inbox ?? ''} onChange={(e) => save({ inbox: e.currentTarget.value })} />
        </label>
        <label class="field">
          <span>Recipient</span>
          <input
            type="email"
            value={mail()?.to ?? ''}
            onChange={(e) => save({ to: e.currentTarget.value })}
          />
        </label>
      </div>
      <form
        class="key-form"
        onSubmit={(e) => {
          e.preventDefault()
          save({ apiKey: key() })
        }}
      >
        <input
          type="password"
          autocomplete="off"
          placeholder={mail()?.hasKey ? 'Key is stored. Enter a new key to replace it' : 'AgentMail API key'}
          value={key()}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <button class="primary" type="submit" disabled={!key().trim()}>
          Save
        </button>
        <button type="button" onClick={test} disabled={!mail()?.hasKey}>
          {sent() ? 'Sent' : 'Send test email'}
        </button>
      </form>
    </section>
  )
}

function ConnectionRow(props: { connection: McpConnection; onChange: () => void }) {
  const [key, setKey] = createSignal('')

  async function save(apiKey: string) {
    try {
      await api.put(`/mcp/${props.connection.id}`, { apiKey })
      setKey('')
      props.onChange()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <section class="provider">
      <header>
        <strong>{props.connection.label}</strong>
        <span class="muted">{props.connection.description}</span>
        <span class="spacer" />
        <span class="badge" classList={{ off: !props.connection.hasKey }}>
          {props.connection.hasKey ? 'connected' : 'off'}
        </span>
      </header>
      <form
        class="key-form"
        onSubmit={(e) => {
          e.preventDefault()
          save(key())
        }}
      >
        <input
          type="password"
          autocomplete="off"
          placeholder={
            props.connection.hasKey ? 'Stored. Enter a new value to replace it' : props.connection.keyLabel
          }
          value={key()}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <button class="primary" type="submit" disabled={!key().trim()}>
          Save
        </button>
        <Show when={props.connection.hasKey}>
          <button type="button" class="ghost danger" onClick={() => save('')}>
            Remove
          </button>
        </Show>
      </form>
    </section>
  )
}

function SubscriptionLogin(props: { provider: ProviderAccess }) {
  const path = () => `/providers/${props.provider.id}`
  const [status, { refetch: recheck }] = createResource(path, (p) =>
    api.get<{ loggedIn: boolean | null; detail: string }>(`${p}/status`),
  )
  const [login, setLogin] = createSignal<LoginState>({ state: 'idle' })
  const [pasted, setPasted] = createSignal('')

  let poll: ReturnType<typeof setInterval> | undefined
  const stopPolling = () => clearInterval(poll)
  onCleanup(stopPolling)

  async function start() {
    // The CLIs drop the current login as soon as a new one starts, even if it is cancelled.
    const replaceWarning =
      'This removes the current login right away, even if you cancel. Running agents on this provider will fail until you log in again. Continue?'
    if (status()?.loggedIn && !confirm(replaceWarning)) return
    try {
      setLogin(await api.post<LoginState>(`${path()}/login`))
      stopPolling()
      poll = setInterval(refresh, 2000)
    } catch (err) {
      fail(err)
    }
  }

  async function refresh() {
    const next = await api.get<LoginState>(`${path()}/login`).catch(() => null)
    if (!next) return
    setLogin(next)
    if (next.state !== 'waiting') {
      stopPolling()
      recheck()
    }
  }

  async function sendCode(e: SubmitEvent) {
    e.preventDefault()
    try {
      await api.post(`${path()}/login/code`, { code: pasted().trim() })
      setPasted('')
    } catch (err) {
      fail(err)
    }
  }

  async function cancel() {
    stopPolling()
    await api.del(`${path()}/login`).catch(() => {})
    setLogin({ state: 'idle' })
  }

  return (
    <div class="login">
      <p class="login-status">
        <Show when={!status.loading} fallback={<span class="muted">Checking login…</span>}>
          <Switch fallback={<span class="muted login-detail">{status()?.detail || 'Status unknown'}</span>}>
            <Match when={status()?.loggedIn === true}>
              <span class="ok">Logged in</span> <span class="muted">{status()?.detail}</span>
            </Match>
            <Match when={status()?.loggedIn === false}>
              <span class="bad-text">Not logged in</span>
            </Match>
          </Switch>
        </Show>
      </p>

      <Show
        when={props.provider.canLogin}
        fallback={
          <p class="muted">
            Log in on the server in a terminal: <code>opencode auth login</code>
          </p>
        }
      >
        <Switch>
          <Match when={login().state === 'waiting'}>
            <ol class="login-steps">
              <li>
                <Show when={login().url} fallback="Waiting for the link…">
                  <a href={login().url} target="_blank" rel="noreferrer">
                    Open login page
                  </a>
                </Show>
              </li>
              <Show
                when={login().needsCode}
                fallback={
                  <li>
                    Enter this code there: <code class="device-code">{login().code || '…'}</code>
                  </li>
                }
              >
                <li>
                  <form class="key-form" onSubmit={sendCode}>
                    <input
                      placeholder="Paste the code from the login page"
                      autocomplete="off"
                      value={pasted()}
                      onInput={(e) => setPasted(e.currentTarget.value)}
                    />
                    <button class="primary" type="submit" disabled={!pasted().trim()}>
                      Confirm
                    </button>
                  </form>
                </li>
              </Show>
            </ol>
            <button class="ghost" onClick={cancel}>
              Cancel
            </button>
          </Match>
          <Match when={login().state === 'failed'}>
            <p class="bad-text">Login failed. {login().message}</p>
            <button onClick={start}>Try again</button>
          </Match>
          <Match when={true}>
            <button onClick={start}>{status()?.loggedIn ? 'Log in again' : 'Log in'}</button>
          </Match>
        </Switch>
      </Show>
    </div>
  )
}
