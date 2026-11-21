import { createSignal } from 'solid-js'
import { api } from './api'

/** Shown when the server is protected by a token and this browser has no session yet. */
export function Login() {
  const [token, setToken] = createSignal('')
  const [wrong, setWrong] = createSignal(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    try {
      await api.post('/login', { token: token() })
      location.reload()
    } catch {
      setWrong(true)
    }
  }

  return (
    <div class="overlay">
      <form class="modal form" onSubmit={submit}>
        <h2>Sign in</h2>
        <p class="muted">This server is protected. Enter the access token (AGENTDECK_TOKEN).</p>
        <input
          type="password"
          autocomplete="current-password"
          autofocus
          placeholder="Access token"
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
        />
        {wrong() && <p class="bad-text">That token is wrong.</p>}
        <footer>
          <span class="spacer" />
          <button class="primary" type="submit" disabled={!token()}>
            Sign in
          </button>
        </footer>
      </form>
    </div>
  )
}
