import { createSignal } from 'solid-js'

export type Theme = 'system' | 'dark' | 'light'

const KEY = 'agentdeck.theme'
const saved = (): Theme => {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'dark' || value === 'light' ? value : 'system'
  } catch {
    return 'system'
  }
}

export const [theme, setThemeSignal] = createSignal<Theme>(saved())

function apply(next: Theme) {
  if (next === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = next
}

export function setTheme(next: Theme) {
  setThemeSignal(next)
  apply(next)
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // Private windows may refuse storage; the choice then lasts until the tab closes.
  }
}

/** Dark, light, system, dark again. */
export const nextTheme = (current: Theme): Theme =>
  current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system'

apply(theme())
