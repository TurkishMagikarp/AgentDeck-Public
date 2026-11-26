// Ready-made teams. A template is a blueprint without key and name; the owner adds those and a
// repository, and the project runs with one click. Every template exists in German and English.
import { applyBlueprint } from './blueprint.ts'
import { currentLang, isLang, t, type Lang } from './i18n.ts'

type Template = { id: string; name: string; summary: string; blueprint: any }

const PLANNER_ROUTINE = {
  name: 'Nächste Schritte planen',
  agent: 'Lead',
  schedule: 'interval',
  every_minutes: 60,
  only_when_idle: true,
  prompt:
    'Nichts ist mehr offen. Lies den Stand des Projekts (Repository, erledigte Issues, Gelerntes) und lege mit den Board-Befehlen die nächsten 3 bis 6 kleinen, prüfbaren Issues an, Status todo, mit Akzeptanzkriterien und Prüfer. Schließe dieses Issue dann mit done.',
}

const REVIEWER = {
  name: 'Prüfer',
  role: 'Code-Review und Qualität',
  provider: 'anthropic',
  instructions:
    'Du prüfst fremde Arbeit gegen das Issue: Akzeptanzkriterien erfüllt, Tests gelaufen, nichts außerhalb des Auftrags geändert. Konkrete Einwände statt allgemeiner Hinweise.',
}

const GERMAN: Template[] = [
  {
    id: 'saas',
    name: 'SaaS-MVP',
    summary:
      'Lead plant, zwei Entwickler bauen, ein Prüfer gibt frei. Startet mit Gerüst, Datenmodell und erster Seite.',
    blueprint: {
      project: {
        description:
          'Eine Web-Anwendung als Minimum Viable Product. Klein anfangen, jede Stufe lauffähig halten.',
        settings: { autonomous: true, maxConcurrent: 2 },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Architekt und Planer',
          provider: 'anthropic',
          instructions:
            'Du triffst die Architekturentscheidungen, hältst sie in docs/ARCHITEKTUR.md fest und zerlegst Arbeit in kleine Issues. Code schreibst du nur, wenn ein Issue dir zugewiesen ist.',
        },
        {
          name: 'Backend',
          role: 'Backend-Entwickler',
          provider: 'anthropic',
          instructions: 'Server, Datenmodell und API. Jede Änderung mit Tests.',
        },
        {
          name: 'Frontend',
          role: 'Frontend-Entwickler',
          provider: 'anthropic',
          instructions: 'Oberfläche, barrierearm und auch auf dem Handy bedienbar. Jede Änderung mit Tests.',
        },
        REVIEWER,
      ],
      issues: [
        {
          title: 'Projektgerüst und Architektur festlegen',
          description:
            'Stack wählen, Gerüst anlegen, Build und Tests lauffähig machen, Entscheidungen in docs/ARCHITEKTUR.md.\n\nFertig, wenn: `npm test` (oder Gegenstück) läuft grün und die README beschreibt den Start.',
          status: 'todo',
          priority: 2,
          assignee: 'Lead',
          reviewers: ['Prüfer'],
        },
        {
          title: 'Datenmodell und erste API',
          description:
            'Kernobjekte modellieren, eine API zum Anlegen und Lesen. Fertig, wenn: Tests decken beide Wege ab.',
          status: 'todo',
          assignee: 'Backend',
          reviewers: ['Prüfer'],
          blocked_by: [1],
        },
        {
          title: 'Erste Seite gegen die API',
          description:
            'Eine Seite, die Objekte anlegt und auflistet. Fertig, wenn: sie gegen die echte API läuft und getestet ist.',
          status: 'todo',
          assignee: 'Frontend',
          reviewers: ['Prüfer'],
          blocked_by: [2],
        },
      ],
      routines: [PLANNER_ROUTINE],
    },
  },
  {
    id: 'game',
    name: 'Spielestudio',
    summary:
      'Game-Designer, Programmierer und Artist mit PixelLab und ElevenLabs. Prüfer spielt jede Änderung an.',
    blueprint: {
      project: {
        description:
          'Ein kleines Spiel, das von Anfang an spielbar bleibt. Erst der Kern-Loop, dann Inhalte.',
        settings: { autonomous: true, maxConcurrent: 2, workspace: 'agent' },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Game-Designer und Planer',
          provider: 'anthropic',
          instructions:
            'Du hältst das Spielkonzept in docs/DESIGN.md aktuell und zerlegst es in kleine, spielbare Schritte.',
        },
        {
          name: 'Programmierer',
          role: 'Gameplay-Programmierer',
          provider: 'anthropic',
          instructions: 'Gameplay und Technik. Nach jeder Änderung muss das Spiel starten.',
        },
        {
          name: 'Artist',
          role: 'Grafik und Sound',
          provider: 'anthropic',
          mcp: ['pixellab', 'elevenlabs'],
          instructions:
            'Sprites mit PixelLab, Sounds mit ElevenLabs. Einheitlicher Stil, Assets unter assets/.',
        },
        {
          ...REVIEWER,
          instructions: `${REVIEWER.instructions} Starte das Spiel und probiere die Änderung aus.`,
        },
      ],
      issues: [
        {
          title: 'Spielkonzept auf einer Seite',
          description:
            'Genre, Kern-Loop, Steuerung, Stil. Fertig, wenn: docs/DESIGN.md beschreibt einen spielbaren ersten Schritt.',
          status: 'todo',
          priority: 2,
          assignee: 'Lead',
        },
        {
          title: 'Kern-Loop spielbar',
          description:
            'Der Kern-Loop aus DESIGN.md mit Platzhaltergrafik. Fertig, wenn: man ihn eine Minute lang spielen kann.',
          status: 'todo',
          assignee: 'Programmierer',
          reviewers: ['Prüfer'],
          blocked_by: [1],
        },
        {
          title: 'Erste Grafiken und Sounds',
          description:
            'Spielfigur, ein Gegner, drei Sounds im Stil aus DESIGN.md. Fertig, wenn: sie im Spiel eingebunden sind.',
          status: 'todo',
          assignee: 'Artist',
          reviewers: ['Prüfer'],
          blocked_by: [2],
        },
      ],
      routines: [PLANNER_ROUTINE],
    },
  },
  {
    id: 'blog',
    name: 'Blog mit täglichem Artikel',
    summary:
      'Jeden Morgen schreibt die Redaktion einen Artikel, das Lektorat prüft ihn vor der Veröffentlichung.',
    blueprint: {
      project: {
        description:
          'Ein Blog. Artikel liegen als Markdown im Repository. Thema und Ton stehen in docs/REDAKTION.md.',
        settings: { autonomous: true, maxConcurrent: 1 },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Chefredaktion',
          provider: 'anthropic',
          instructions: 'Du pflegst docs/REDAKTION.md (Themen, Ton, Zielgruppe) und die Themenliste.',
        },
        {
          name: 'Redaktion',
          role: 'Autor',
          provider: 'anthropic',
          instructions:
            'Du schreibst einen Artikel pro Issue, 600 bis 1200 Wörter, mit Quellen. Keine erfundenen Fakten, kein Thema doppelt.',
        },
        {
          name: 'Lektorat',
          role: 'Lektorat und Faktencheck',
          provider: 'anthropic',
          instructions: 'Du prüfst Fakten, Quellen, Ton und Rechtschreibung. Änderungen konkret benennen.',
        },
      ],
      issues: [
        {
          title: 'Redaktionsleitfaden anlegen',
          description:
            'Thema, Zielgruppe, Ton, Format eines Artikels, 20 Themenideen. Fertig, wenn: docs/REDAKTION.md steht.',
          status: 'todo',
          priority: 2,
          assignee: 'Lead',
        },
      ],
      routines: [
        {
          name: 'Artikel des Tages',
          agent: 'Redaktion',
          schedule: 'daily',
          at: '07:00',
          prompt:
            'Schreib den Artikel des Tages nach docs/REDAKTION.md. Nimm das nächste offene Thema und streich es von der Liste. Prüfer: Lektorat.',
        },
      ],
    },
  },
]

const PLANNER_ROUTINE_EN = {
  name: 'Plan next steps',
  agent: 'Lead',
  schedule: 'interval',
  every_minutes: 60,
  only_when_idle: true,
  prompt:
    'Nothing is open any more. Read the state of the project (repository, finished issues, lessons) and file the next 3 to 6 small, checkable issues with the board commands, status todo, with acceptance criteria and a reviewer. Then close this issue with done.',
}

const REVIEWER_EN = {
  name: 'Reviewer',
  role: 'Code review and quality',
  provider: 'anthropic',
  instructions:
    'You check the work of others against the issue: acceptance criteria met, tests run, nothing changed outside the task. Concrete objections instead of general remarks.',
}

const ENGLISH: Template[] = [
  {
    id: 'saas',
    name: 'SaaS MVP',
    summary:
      'A lead plans, two developers build, a reviewer approves. Starts with the skeleton, the data model and a first page.',
    blueprint: {
      project: {
        description: 'A web application as a minimum viable product. Start small, keep every stage runnable.',
        settings: { autonomous: true, maxConcurrent: 2 },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Architect and planner',
          provider: 'anthropic',
          instructions:
            'You make the architecture decisions, record them in docs/ARCHITECTURE.md and split work into small issues. You write code only when an issue is assigned to you.',
        },
        {
          name: 'Backend',
          role: 'Backend developer',
          provider: 'anthropic',
          instructions: 'Server, data model and API. Every change with tests.',
        },
        {
          name: 'Frontend',
          role: 'Frontend developer',
          provider: 'anthropic',
          instructions: 'The interface, accessible and usable on a phone too. Every change with tests.',
        },
        REVIEWER_EN,
      ],
      issues: [
        {
          title: 'Set up the project skeleton and architecture',
          description:
            'Choose the stack, create the skeleton, get build and tests running, record decisions in docs/ARCHITECTURE.md.\n\nDone when: `npm test` (or its counterpart) passes and the README describes how to start.',
          status: 'todo',
          priority: 2,
          assignee: 'Lead',
          reviewers: ['Reviewer'],
        },
        {
          title: 'Data model and first API',
          description:
            'Model the core objects, one API to create and read them. Done when: tests cover both paths.',
          status: 'todo',
          assignee: 'Backend',
          reviewers: ['Reviewer'],
          blocked_by: [1],
        },
        {
          title: 'First page against the API',
          description:
            'A page that creates and lists objects. Done when: it runs against the real API and is tested.',
          status: 'todo',
          assignee: 'Frontend',
          reviewers: ['Reviewer'],
          blocked_by: [2],
        },
      ],
      routines: [PLANNER_ROUTINE_EN],
    },
  },
  {
    id: 'game',
    name: 'Game studio',
    summary:
      'Game designer, programmer and artist with PixelLab and ElevenLabs. The reviewer plays every change.',
    blueprint: {
      project: {
        description: 'A small game that stays playable from the start. First the core loop, then content.',
        settings: { autonomous: true, maxConcurrent: 2, workspace: 'agent' },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Game designer and planner',
          provider: 'anthropic',
          instructions:
            'You keep the game concept in docs/DESIGN.md up to date and split it into small, playable steps.',
        },
        {
          name: 'Programmer',
          role: 'Gameplay programmer',
          provider: 'anthropic',
          instructions: 'Gameplay and technology. The game must start after every change.',
        },
        {
          name: 'Artist',
          role: 'Graphics and sound',
          provider: 'anthropic',
          mcp: ['pixellab', 'elevenlabs'],
          instructions:
            'Sprites with PixelLab, sounds with ElevenLabs. One consistent style, assets under assets/.',
        },
        {
          ...REVIEWER_EN,
          instructions: `${REVIEWER_EN.instructions} Start the game and try the change.`,
        },
      ],
      issues: [
        {
          title: 'Game concept on one page',
          description:
            'Genre, core loop, controls, style. Done when: docs/DESIGN.md describes a playable first step.',
          status: 'todo',
          priority: 2,
          assignee: 'Lead',
        },
        {
          title: 'Core loop playable',
          description:
            'The core loop from DESIGN.md with placeholder graphics. Done when: it can be played for one minute.',
          status: 'todo',
          assignee: 'Programmer',
          reviewers: ['Reviewer'],
          blocked_by: [1],
        },
        {
          title: 'First graphics and sounds',
          description:
            'Player character, one enemy, three sounds in the style from DESIGN.md. Done when: they are built into the game.',
          status: 'todo',
          assignee: 'Artist',
          reviewers: ['Reviewer'],
          blocked_by: [2],
        },
      ],
      routines: [PLANNER_ROUTINE_EN],
    },
  },
  {
    id: 'blog',
    name: 'Blog with a daily article',
    summary: 'Every morning the writer drafts an article, and the editor checks it before it is published.',
    blueprint: {
      project: {
        description:
          'A blog. Articles are Markdown files in the repository. Topic and tone are in docs/EDITORIAL.md.',
        settings: { autonomous: true, maxConcurrent: 1 },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Editor in chief',
          provider: 'anthropic',
          instructions: 'You maintain docs/EDITORIAL.md (topics, tone, audience) and the list of topics.',
        },
        {
          name: 'Writer',
          role: 'Author',
          provider: 'anthropic',
          instructions:
            'You write one article per issue, 600 to 1200 words, with sources. No invented facts, no topic twice.',
        },
        {
          name: 'Editor',
          role: 'Copy editing and fact check',
          provider: 'anthropic',
          instructions: 'You check facts, sources, tone and spelling. Name changes concretely.',
        },
      ],
      issues: [
        {
          title: 'Write the editorial guide',
          description:
            'Topic, audience, tone, format of an article, 20 topic ideas. Done when: docs/EDITORIAL.md exists.',
          status: 'todo',
          priority: 2,
          assignee: 'Lead',
        },
      ],
      routines: [
        {
          name: 'Article of the day',
          agent: 'Writer',
          schedule: 'daily',
          at: '07:00',
          prompt:
            'Write the article of the day following docs/EDITORIAL.md. Take the next open topic and strike it from the list. Reviewer: Editor.',
        },
      ],
    },
  },
]

const TEMPLATES: Record<Lang, Template[]> = { de: GERMAN, en: ENGLISH }

/** The templates as the person asking reads them. */
export const listTemplates = () =>
  TEMPLATES[currentLang()].map((template) => ({
    id: template.id,
    name: template.name,
    summary: template.summary,
    agents: template.blueprint.agents.map((agent: any) => agent.name),
    issues: template.blueprint.issues.length,
  }))

/**
 * Creates a project from a template. The team is written in the language of the new project:
 * the one given, otherwise the language of whoever creates it.
 */
export function applyTemplate(
  id: string,
  input: { key: string; name: string; repo_path?: string; language?: Lang },
) {
  const language = isLang(input.language) ? input.language : currentLang()
  const template = TEMPLATES[language].find((candidate) => candidate.id === id)
  if (!template) throw new Error(t('Unbekannte Vorlage'))
  const blueprint = structuredClone(template.blueprint)
  // Paused, so the owner checks agents and providers before the first run spends anything.
  Object.assign(blueprint.project, {
    key: input.key,
    name: input.name,
    repo_path: input.repo_path ?? '',
    paused: true,
  })
  blueprint.project.settings = { ...blueprint.project.settings, language }
  return applyBlueprint(blueprint)
}
