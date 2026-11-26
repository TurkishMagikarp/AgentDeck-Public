import { say } from '../i18n.ts'
import { de } from './de.ts'
import { en } from './en.ts'

/** The prompt texts in the language of the work running right now. Call it where a prompt is built. */
export const prompts = () => say({ de, en })
