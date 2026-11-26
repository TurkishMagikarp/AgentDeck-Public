// English texts, keyed by the German source text. One module per group of UI files keeps the work apart.
import { en_app } from './en.app.ts'
import { en_settings } from './en.settings.ts'
import { en_issue } from './en.issue.ts'
import { en_mission } from './en.mission.ts'
import { en_providers } from './en.providers.ts'
import { en_agents } from './en.agents.ts'
import { en_board } from './en.board.ts'
import { en_misc } from './en.misc.ts'

export const en: Record<string, string> = {
  ...en_app,
  ...en_settings,
  ...en_issue,
  ...en_mission,
  ...en_providers,
  ...en_agents,
  ...en_board,
  ...en_misc,
}
