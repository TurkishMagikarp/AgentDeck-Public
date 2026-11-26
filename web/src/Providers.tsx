import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js'
import { api } from './api'
import { fail } from './store'
import { PushSettings, ReportSettings } from './Notifications'
import { Modal } from './ui'
import { t } from './i18n'

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
  managed?: { environmentId: string; hasEnvironmentKey: boolean; runLimitUsd: number }
}

type LoginState = {
  state: 'idle' | 'waiting' | 'done' | 'failed'
  url?: string
  code?: string
  needsCode?: boolean
  message?: string
}

type McpConnection = { id: string; label: string; description: string; keyLabel: string; hasKey: boolean }

const MODE_LABELS: Record<AccessMode, string> = { subscription: 'Abo', apikey: 'API-Key' }

export function Providers(props: { onClose: () => void }) {
  const [providers, { refetch }] = createResource(() => api.get<ProviderAccess[]>('/providers'))
  const [connections, { refetch: reloadConnections }] = createResource(() => api.get<McpConnection[]>('/mcp'))

  return (
    <Modal title={t('Anbieter und Zugänge')} onClose={props.onClose} wide>
      <p class="muted intro">
        {t('Gilt für alle Projekte. Im Abo-Modus nutzt AgentDeck den Login des jeweiligen CLI auf diesem Server, im API-Key-Modus wird pro Token abgerechnet.')}
      </p>
      <div class="provider-list">
        <For each={providers()}>{(provider) => <ProviderRow provider={provider} onChange={refetch} />}</For>
      </div>

      <h3 class="modal-section">{t('Mail an dich')}</h3>
      <p class="muted intro">
        {t('Wartet ein Issue auf einen Menschen, schickt AgentDeck eine Mail über AgentMail. Pro Projekt abschaltbar.')}
      </p>
      <MailSettings />

      <h3 class="modal-section">{t('Push aufs Handy')}</h3>
      <p class="muted intro">
        {t('Dieselben Nachrichten wie die Mail, sofort und ohne Tageslimit. Pro Gerät einmal aktivieren.')}
      </p>
      <PushSettings />

      <h3 class="modal-section">{t('Morgenbericht')}</h3>
      <p class="muted intro">
        {t('Einmal am Tag eine Zeile pro Projekt mit dem, was in den letzten 24 Stunden passiert ist. Kommt per Push und, wenn eingerichtet, per Mail.')}
      </p>
      <ReportSettings />

      <h3 class="modal-section">{t('MCP-Verbindungen')}</h3>
      <p class="muted intro">
        {t('Mit hinterlegtem Key kannst du die Verbindung einzelnen Agenten zuweisen. Sie funktioniert mit Claude Code, Codex, opencode und Claude Managed Agents.')}
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
            {provider().hasKey ? t('Key hinterlegt') : t('Key fehlt')}
          </span>
        </Show>
        <span class="spacer" />
        <div class="segmented" role="group" aria-label={t('Zugangsart')}>
          <For each={provider().modes}>
            {(mode) => (
              <button classList={{ active: provider().mode === mode }} onClick={() => save(mode)}>
                {t(MODE_LABELS[mode])}
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
              aria-label={t('API-Key')}
              placeholder={
                provider().hasKey
                  ? t('Key ist hinterlegt. Neuen Key eingeben, um ihn zu ersetzen')
                  : t('API-Key einfügen')
              }
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value)}
            />
            <button class="primary" type="submit" disabled={!key().trim()}>
              {t('Speichern')}
            </button>
            <Show when={provider().hasKey}>
              <button type="button" class="ghost danger" onClick={() => save('apikey', '')}>
                {t('Entfernen')}
              </button>
            </Show>
          </form>
          <Show when={provider().managed}>
            {(managed) => (
              <ManagedSettings provider={provider().id} managed={managed()} onChange={props.onChange} />
            )}
          </Show>
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
                aria-label={t('Abo-Token')}
                placeholder={
                  provider().hasSubscriptionToken
                    ? t('Abo-Token ist hinterlegt. Neues eingeben, um es zu ersetzen')
                    : t('Für Server: langlebiges Abo-Token aus „claude setup-token“')
                }
                value={key()}
                onInput={(e) => setKey(e.currentTarget.value)}
              />
              <button class="primary" type="submit" disabled={!key().trim()}>
                {t('Speichern')}
              </button>
              <Show when={provider().hasSubscriptionToken}>
                <button type="button" class="ghost danger" onClick={() => saveSubscriptionToken('')}>
                  {t('Entfernen')}
                </button>
              </Show>
            </form>
          </Show>
        </Match>
      </Switch>
    </section>
  )
}

/**
 * Managed Agents run their tools on this server through a self-hosted environment. Its key can
 * only be generated in the Claude Console, once AgentDeck has created the environment.
 */
function ManagedSettings(props: {
  provider: string
  managed: NonNullable<ProviderAccess['managed']>
  onChange: () => void
}) {
  const [environmentKey, setEnvironmentKey] = createSignal('')
  const [limit, setLimit] = createSignal(String(props.managed.runLimitUsd))

  async function save(change: { environmentKey?: string; runLimitUsd?: number }) {
    try {
      await api.put(`/providers/${props.provider}`, { mode: 'apikey', ...change })
      setEnvironmentKey('')
      props.onChange()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <Show
        when={props.managed.environmentId}
        fallback={<p class="muted">{t('Nach dem Speichern des API-Keys legt AgentDeck das Environment an.')}</p>}
      >
        <p class="muted">
          {t('Environment')} <code>{props.managed.environmentId}</code>
          {t(': Erzeuge dafür in der Claude Console einen Environment-Key und trage ihn hier ein.')}
        </p>
        <form
          class="key-form"
          onSubmit={(e) => {
            e.preventDefault()
            save({ environmentKey: environmentKey() })
          }}
        >
          <input
            type="password"
            autocomplete="off"
            aria-label={t('Environment-Key')}
            placeholder={
              props.managed.hasEnvironmentKey
                ? t('Environment-Key ist hinterlegt. Neuen eingeben, um ihn zu ersetzen')
                : t('Environment-Key (sk-ant-oat01-…) einfügen')
            }
            value={environmentKey()}
            onInput={(e) => setEnvironmentKey(e.currentTarget.value)}
          />
          <button class="primary" type="submit" disabled={!environmentKey().trim()}>
            {t('Speichern')}
          </button>
          <Show when={props.managed.hasEnvironmentKey}>
            <button type="button" class="ghost danger" onClick={() => save({ environmentKey: '' })}>
              {t('Entfernen')}
            </button>
          </Show>
        </form>
      </Show>
      <form
        class="key-form"
        onSubmit={(e) => {
          e.preventDefault()
          save({ runLimitUsd: Number(limit()) })
        }}
      >
        <label class="muted" for="run-limit">
          {t('Höchstens pro Lauf (USD)')}
        </label>
        <input
          id="run-limit"
          type="number"
          min="0.5"
          max="1000"
          step="0.5"
          value={limit()}
          onInput={(e) => setLimit(e.currentTarget.value)}
        />
        <button type="submit" disabled={Number(limit()) === props.managed.runLimitUsd}>
          {t('Speichern')}
        </button>
      </form>
    </>
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
          <span>{t('AgentMail-Postfach (Absender)')}</span>
          <input value={mail()?.inbox ?? ''} onChange={(e) => save({ inbox: e.currentTarget.value })} />
        </label>
        <label class="field">
          <span>{t('Empfänger')}</span>
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
          aria-label={t(t('AgentMail-API-Key'))}
          placeholder={
            mail()?.hasKey
              ? t('Key ist hinterlegt. Neuen Key eingeben, um ihn zu ersetzen')
              : t('AgentMail-API-Key')
          }
          value={key()}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <button class="primary" type="submit" disabled={!key().trim()}>
          {t('Speichern')}
        </button>
        <button type="button" onClick={test} disabled={!mail()?.hasKey}>
          {sent() ? t('Gesendet') : t('Testmail')}
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
          {props.connection.hasKey ? t('verbunden') : t('aus')}
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
          aria-label={props.connection.keyLabel}
          placeholder={
            props.connection.hasKey
              ? t('Hinterlegt. Neuen Wert eingeben, um ihn zu ersetzen')
              : props.connection.keyLabel
          }
          value={key()}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <button class="primary" type="submit" disabled={!key().trim()}>
          {t('Speichern')}
        </button>
        <Show when={props.connection.hasKey}>
          <button type="button" class="ghost danger" onClick={() => save('')}>
            {t('Entfernen')}
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
      t('Die bestehende Anmeldung wird sofort entfernt, auch wenn du den Login abbrichst. Laufende Agenten dieses Anbieters schlagen bis zur neuen Anmeldung fehl. Fortfahren?')
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
        <Show when={!status.loading} fallback={<span class="muted">{t('Prüfe Login…')}</span>}>
          <Switch fallback={<span class="muted login-detail">{status()?.detail || t('Status unbekannt')}</span>}>
            <Match when={status()?.loggedIn === true}>
              <span class="ok">{t('Angemeldet')}</span> <span class="muted">{status()?.detail}</span>
            </Match>
            <Match when={status()?.loggedIn === false}>
              <span class="bad-text">{t('Nicht angemeldet')}</span>
            </Match>
          </Switch>
        </Show>
      </p>

      <Show
        when={props.provider.canLogin}
        fallback={
          <p class="muted">
            {t('Login auf dem Server im Terminal:')} <code>opencode auth login</code>
          </p>
        }
      >
        <Switch>
          <Match when={login().state === 'waiting'}>
            <ol class="login-steps">
              <li>
                <Show when={login().url} fallback={t('Warte auf den Link…')}>
                  <a href={login().url} target="_blank" rel="noreferrer">
                    {t('Anmeldeseite öffnen')}
                  </a>
                </Show>
              </li>
              <Show
                when={login().needsCode}
                fallback={
                  <li>
                    {t('Dort diesen Code eingeben:')} <code class="device-code">{login().code || '…'}</code>
                  </li>
                }
              >
                <li>
                  <form class="key-form" onSubmit={sendCode}>
                    <input
                      placeholder={t('Code von der Anmeldeseite einfügen')}
                      autocomplete="off"
                      value={pasted()}
                      onInput={(e) => setPasted(e.currentTarget.value)}
                    />
                    <button class="primary" type="submit" disabled={!pasted().trim()}>
                      {t('Bestätigen')}
                    </button>
                  </form>
                </li>
              </Show>
            </ol>
            <button class="ghost" onClick={cancel}>
              {t('Abbrechen')}
            </button>
          </Match>
          <Match when={login().state === 'failed'}>
            <p class="bad-text">{t('Login fehlgeschlagen.')} {login().message}</p>
            <button onClick={start}>{t('Erneut versuchen')}</button>
          </Match>
          <Match when={true}>
            <button onClick={start}>{status()?.loggedIn ? t('Neu anmelden') : t('Anmelden')}</button>
          </Match>
        </Switch>
      </Show>
    </div>
  )
}
