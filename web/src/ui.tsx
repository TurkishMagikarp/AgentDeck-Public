import type { JSX, ParentProps } from 'solid-js'
import { onCleanup, onMount } from 'solid-js'

export function Modal(props: ParentProps<{ title: string; onClose: () => void; wide?: boolean }>) {
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
  onMount(() => document.addEventListener('keydown', onKey))
  onCleanup(() => document.removeEventListener('keydown', onKey))

  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal" classList={{ wide: props.wide }} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button class="ghost" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {props.children}
      </div>
    </div>
  )
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
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as T)}>
      {props.options.map(([value, label]) => (
        <option value={value} selected={value === props.value}>
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
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(timestamp).toLocaleDateString('en-US')
}
