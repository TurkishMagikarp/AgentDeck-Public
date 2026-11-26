import { createResource, createSignal, Show } from 'solid-js'
import { api } from './api'
import { t } from './i18n'
import { fail } from './store'

type PushInfo = { publicKey: string; devices: number }
type Report = { at: string; preview: string }

/** The VAPID key comes base64url encoded, the browser wants the raw bytes. */
function keyBytes(base64url: string) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window

async function currentSubscription() {
  const registration = await navigator.serviceWorker.register('/sw.js')
  return { registration, subscription: await registration.pushManager.getSubscription() }
}

export function PushSettings() {
  const [info, { refetch }] = createResource(() => api.get<PushInfo>('/push'))
  const [here, { mutate: setHere }] = createResource(async () =>
    pushSupported() ? !!(await currentSubscription()).subscription : false,
  )
  const [busy, setBusy] = createSignal(false)

  async function turnOn() {
    setBusy(true)
    try {
      if ((await Notification.requestPermission()) !== 'granted')
        throw new Error(t('Benachrichtigungen sind im Browser blockiert'))
      const { registration } = await currentSubscription()
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(info()!.publicKey),
      })
      await api.post('/push/subscribe', { subscription: subscription.toJSON(), device: navigator.userAgent })
      setHere(true)
      refetch()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    setBusy(true)
    try {
      const { subscription } = await currentSubscription()
      if (subscription) {
        await api.post('/push/unsubscribe', { endpoint: subscription.endpoint })
        await subscription.unsubscribe()
      }
      setHere(false)
      refetch()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="provider">
      <Show
        when={pushSupported()}
        fallback={
          <p class="muted">
            {t('Dieser Browser kann keine Push-Nachrichten empfangen. Auf dem iPhone erst „Zum Home-Bildschirm“.')}
          </p>
        }
      >
        <div class="key-form">
          <span class="grow">
            {here()
              ? t('Dieses Gerät bekommt Push-Nachrichten.')
              : t('Dieses Gerät bekommt keine Push-Nachrichten.')}{' '}
            <span class="muted">{t('Geräte insgesamt: {n}', { n: info()?.devices ?? 0 })}</span>
          </span>
          <Show
            when={here()}
            fallback={
              <button class="primary" disabled={busy() || !info()} onClick={turnOn}>
                {t('Push aktivieren')}
              </button>
            }
          >
            <button disabled={busy()} onClick={() => api.post('/push/test').catch(fail)}>
              {t('Test-Push')}
            </button>
            <button class="ghost" disabled={busy()} onClick={turnOff}>
              {t('Abmelden')}
            </button>
          </Show>
        </div>
      </Show>
    </section>
  )
}

export function ReportSettings() {
  const [report, { mutate }] = createResource(() => api.get<Report>('/report'))
  const [showPreview, setShowPreview] = createSignal(false)
  const [sent, setSent] = createSignal(false)

  function save(at: string) {
    api.put<Report>('/report', { at }).then(mutate).catch(fail)
  }

  function sendNow() {
    api
      .post('/report/send')
      .then(() => setSent(true))
      .catch(fail)
  }

  return (
    <section class="provider">
      <div class="key-form">
        <label class="grow">
          {t('Morgenbericht um')}{' '}
          <input type="time" value={report()?.at ?? ''} onChange={(e) => save(e.currentTarget.value)} />
          <span class="muted"> {report()?.at ? '' : t('(aus)')}</span>
        </label>
        <button class="ghost" onClick={() => setShowPreview(!showPreview())}>
          {showPreview() ? t('Vorschau schließen') : t('Vorschau')}
        </button>
        <button onClick={sendNow}>{sent() ? t('Gesendet') : t('Jetzt senden')}</button>
      </div>
      <Show when={showPreview()}>
        <pre class="report-preview">{report()?.preview}</pre>
      </Show>
    </section>
  )
}
