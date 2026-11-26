import { createSignal } from 'solid-js'
import { askConfirmToken } from './Confirm'
import { language, t } from './i18n'

/** True once the server answered "unauthorized": the app then shows the login form. */
export const [needsLogin, setNeedsLogin] = createSignal(false)

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let sent = body
  for (;;) {
    const res = await fetch('/api' + path, {
      method,
      headers: {
        'x-agentdeck-lang': language(),
        ...(sent === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: sent === undefined ? undefined : JSON.stringify(sent),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 401 && path !== '/login') setNeedsLogin(true)
    // A change to a command the server runs needs the token again: ask, then send the same request
    // with it. A wrong token comes back the same way, with the reason in the message.
    if (res.status === 403 && data.confirm && sent && typeof sent === 'object') {
      const token = await askConfirmToken(data.error ?? '', data.fields ?? [])
      if (!token) throw new Error(t('Nicht gespeichert: Bestätigung abgebrochen.'))
      sent = { ...sent, confirmToken: token }
      continue
    }
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}
