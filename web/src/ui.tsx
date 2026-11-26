import type { JSX, ParentProps } from 'solid-js'
import { For, onCleanup, onMount, splitProps } from 'solid-js'
import { language, locale, setLanguage, t } from './i18n'
import { Icon } from './icons'

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** `popover` anchors the dialog next to the sidebar on wide screens, like a menu; phones keep it centred. */
export function Modal(props: ParentProps<{ title: string; onClose: () => void; wide?: boolean; popover?: boolean }>) {
  let dialog: HTMLDivElement | undefined
  // The control that opened the dialog gets the focus back when it closes.
  const opener = document.activeElement as HTMLElement | null

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return props.onClose()
    if (e.key !== 'Tab' || !dialog) return
    // Tab stays inside the dialog: from the last control it wraps to the first, and back.
    const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    if (!controls.length) return
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      e.preventDefault()
      first.focus()
    }
  }
  onMount(() => {
    document.addEventListener('keydown', onKey)
    // Focus lands on the first field if there is one, otherwise on the dialog itself.
    const field = dialog?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')
    ;(field ?? dialog)?.focus()
  })
  onCleanup(() => {
    document.removeEventListener('keydown', onKey)
    if (opener?.isConnected) opener.focus()
  })

  return (
    <div class="overlay" classList={{ popover: props.popover }} onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={dialog}
        class="modal"
        classList={{ wide: props.wide }}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabindex="-1"
      >
        <header>
          <h2>{props.title}</h2>
          <button class="ghost icon-button" onClick={props.onClose} aria-label={t('Schließen')}>
            <Icon name="close" />
          </button>
        </header>
        {props.children}
      </div>
    </div>
  )
}

// Lets a clickable card open with Enter or Space, like a real button.
export function onActivateKey(action: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    action()
  }
}

export function Field(props: ParentProps<{ label: string; hint?: string }>) {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small>{props.hint}</small>}
    </label>
  )
}

export function Toggle(props: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  title?: string
}) {
  return (
    <label class="toggle" title={props.title}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span>{props.label}</span>
    </label>
  )
}

type SelectProps<T extends string> = {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
} & Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'>

export function Select<T extends string>(props: SelectProps<T>) {
  const [own, rest] = splitProps(props, ['value', 'options', 'onChange'])
  return (
    <select {...rest} value={own.value} onChange={(e) => own.onChange(e.currentTarget.value as T)}>
      {own.options.map(([value, label]) => (
        <option value={value} selected={value === own.value}>
          {label}
        </option>
      ))}
    </select>
  )
}

export function initials(name: string) {
  const parts = name.split(/[\s-_]+/).filter(Boolean)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase()
}

export function formatTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + ' M'
  if (n >= 1_000) return Math.round(n / 1_000) + ' k'
  return String(n)
}

export function timeAgo(timestamp: number) {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return t('gerade eben')
  if (minutes < 60) return t('vor {n} min', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('vor {n} h', { n: hours })
  return new Date(timestamp).toLocaleDateString(locale())
}

/** DE / EN switch; the choice is remembered in this browser. */
export function LanguageSwitch() {
  return (
    <div class="segmented language-switch" role="group" aria-label={t('Sprache')}>
      <For each={LANGUAGES}>
        {([code, label]) => (
          <button
            classList={{ active: language() === code }}
            aria-pressed={language() === code}
            lang={code}
            onClick={() => setLanguage(code)}
          >
            {label}
          </button>
        )}
      </For>
    </div>
  )
}

const LANGUAGES = [
  ['de', 'Deutsch'],
  ['en', 'English'],
] as const
