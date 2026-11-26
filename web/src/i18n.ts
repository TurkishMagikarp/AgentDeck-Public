// Two interface languages. The source text in the code is German and doubles as the key:
// t('Abmelden') returns "Sign out" in English and the text itself in German or when no
// translation exists, so a missing entry shows German instead of breaking the page.
import { createSignal } from 'solid-js'
import { en } from './i18n/en'

export type Lang = 'de' | 'en'

const KEY = 'agentdeck.lang'

const detect = (): Lang => {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'de' || saved === 'en') return saved
  } catch {
    // Storage can be blocked; fall through to the browser language.
  }
  return navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en'
}

const [lang, setLangSignal] = createSignal<Lang>(detect())

/** The current language; reading it inside JSX or an effect makes that part follow a switch. */
export const language = lang

/**
 * Switches the language and loads the page again: boards, comments and error texts the server
 * already sent are in the old language and only come back translated on a fresh load.
 */
export function setLanguage(next: Lang) {
  if (next === lang()) return
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // Without storage a reload would forget the choice: switch in place, it lasts until the tab closes.
    setLangSignal(next)
    document.documentElement.lang = next
    return
  }
  location.reload()
}

/** Locale for dates and numbers: toLocaleString(locale()). */
export const locale = () => (lang() === 'en' ? 'en-GB' : 'de-DE')

/**
 * Translate a German source text. Placeholders are written {name} and filled from `params`.
 * Use separate keys for singular and plural ('1 Lauf' and '{n} Läufe'), never build a sentence
 * from pieces. Call it where the text is shown, not in a module-level constant, or a language
 * switch will not reach it.
 */
export function t(text: string, params?: Record<string, string | number>): string {
  // "Von||Autor": the part after || only tells translations apart; German shows the text before it.
  const base = lang() === 'en' ? (en[text] ?? text.split('||')[0]) : text.split('||')[0]
  return params ? base.replace(/\{(\w+)\}/g, (whole, name) => String(params[name] ?? whole)) : base
}

document.documentElement.lang = lang()
