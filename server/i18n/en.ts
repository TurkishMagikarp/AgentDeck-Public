// English for every German text the server passes to t(). One file per area of the server.
import { en_api } from './en.api.ts'
import { en_engine } from './en.engine.ts'
import { en_landing } from './en.landing.ts'
import { en_prompts } from './en.prompts.ts'
import { en_services } from './en.services.ts'

export const en: Record<string, string> = {
  ...en_api,
  ...en_engine,
  ...en_landing,
  ...en_prompts,
  ...en_services,
}
