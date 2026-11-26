// Two languages on the server, the same way as in the web UI: the German text in the code is the
// key, t('Geparkt: {reason}', { reason }) returns the English entry when English is asked for and
// the German text otherwise. A missing entry shows German instead of breaking anything.
//
// Which language applies comes from where the text is going:
// - an answer to a request: the language of the person asking (header X-AgentDeck-Lang),
// - a comment, a mail or a prompt for a project: that project's language (settings.language),
// - anything else: the language of the instance (AGENTDECK_LANG, or what the first start chose).
import { AsyncLocalStorage } from 'node:async_hooks'
import { en } from './i18n/en.ts'

export type Lang = 'de' | 'en'

export const isLang = (value: unknown): value is Lang => value === 'de' || value === 'en'

const scope = new AsyncLocalStorage<Lang>()
let instance: Lang = isLang(process.env.AGENTDECK_LANG) ? process.env.AGENTDECK_LANG : 'en'

export const instanceLang = () => instance
export const setInstanceLang = (lang: Lang) => void (instance = lang)

/** The language of the work running right now. */
export const currentLang = (): Lang => scope.getStore() ?? instance

/** Runs `work` in a language; everything it starts, awaits or schedules keeps that language. */
export const withLang = <T>(lang: Lang | undefined, work: () => T): T => scope.run(lang ?? instance, work)

/** The language a project's agents and server notes use. */
export const langOf = (project: { settings?: { language?: unknown } } | null | undefined): Lang =>
  isLang(project?.settings?.language) ? project.settings.language : instance

/** Runs `work` in the language of a project. */
export const forProject = <T>(project: Parameters<typeof langOf>[0], work: () => T): T =>
  withLang(langOf(project), work)

const fill = (text: string, params?: Record<string, string | number>) =>
  params ? text.replace(/\{(\w+)\}/g, (whole, name) => String(params[name] ?? whole)) : text

/** Translate a German source text into one language. "Von||Autor": the part after || only tells keys apart. */
export function tIn(lang: Lang, text: string, params?: Record<string, string | number>): string {
  const german = text.split('||')[0]
  return fill(lang === 'en' ? (en[text] ?? german) : german, params)
}

/**
 * Translate a German source text into the current language. Placeholders are written {name}.
 * Call it where the text is produced, never in a module-level constant: the language is only
 * known while a request or a project's work runs.
 */
export const t = (text: string, params?: Record<string, string | number>) => tIn(currentLang(), text, params)

/**
 * Both forms of a text without placeholders, for comparing against what was stored earlier:
 * a comment written while the project was German still has to be found after a switch.
 */
export const variants = (text: string): string[] => [...new Set([tIn('de', text), tIn('en', text)])]

/** Picks one of two texts that are too long or too structured for a key, such as a prompt. */
export const say = <T>(texts: { de: T; en: T }): T => texts[currentLang()]

/** The language a request asks for: the UI's header first, then the browser's preference. */
export function requestLang(header: (name: string) => string | undefined): Lang {
  const chosen = header('x-agentdeck-lang')
  if (isLang(chosen)) return chosen
  const accepted = header('accept-language')?.trim().toLowerCase()
  // Scripts and Node's fetch send "*": no preference, so the instance decides.
  if (!accepted || accepted.startsWith('*')) return instance
  return accepted.startsWith('de') ? 'de' : 'en'
}
