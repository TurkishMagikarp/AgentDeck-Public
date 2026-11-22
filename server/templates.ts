// Ready-made teams. A template is a blueprint without key and name; the owner adds those and a
// repository, and the project runs with one click.
import { applyBlueprint } from './blueprint.ts'

type Template = { id: string; name: string; summary: string; blueprint: any }

const PLANNER_ROUTINE = {
  name: 'Plan the next steps',
  agent: 'Lead',
  schedule: 'interval',
  every_minutes: 60,
  only_when_idle: true,
  prompt:
    'Nothing is open any more. Read where the project stands (repository, finished issues, lessons) and use the board commands to create the next 3 to 6 small, checkable issues, status todo, with acceptance criteria and a reviewer. Then close this issue with done.',
}

const REVIEWER = {
  name: 'Reviewer',
  role: 'Code review and quality',
  provider: 'anthropic',
  instructions:
    "You check other agents' work against the issue: acceptance criteria met, tests run, nothing changed outside the task. Concrete objections instead of general remarks.",
}

const TEMPLATES: Template[] = [
  {
    id: 'saas',
    name: 'SaaS MVP',
    summary:
      'Lead plans, two developers build, a reviewer approves. Starts with scaffold, data model and a first page.',
    blueprint: {
      project: {
        description: 'A web application as a minimum viable product. Start small, keep every stage running.',
        settings: { autonomous: true, maxConcurrent: 2 },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Architect and planner',
          provider: 'anthropic',
          instructions:
            'You make the architecture decisions, record them in docs/ARCHITECTURE.md and break work into small issues. You only write code when an issue is assigned to you.',
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
          instructions: 'User interface, accessible and usable on a phone too. Every change with tests.',
        },
        REVIEWER,
      ],
      issues: [
        {
          title: 'Set up the project scaffold and architecture',
          description:
            'Choose the stack, create the scaffold, get build and tests running, decisions in docs/ARCHITECTURE.md.\n\nDone when: `npm test` (or its equivalent) passes and the README describes how to start.',
          status: 'todo',
          priority: 2,
          assignee: 'Lead',
          reviewers: ['Reviewer'],
        },
        {
          title: 'Data model and first API',
          description:
            'Model the core objects, an API to create and read them. Done when: tests cover both paths.',
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
      routines: [PLANNER_ROUTINE],
    },
  },
  {
    id: 'game',
    name: 'Game studio',
    summary:
      'Game designer, programmer and artist with PixelLab and ElevenLabs. The reviewer plays every change.',
    blueprint: {
      project: {
        description: 'A small game that stays playable from the start. Core loop first, then content.',
        settings: { autonomous: true, maxConcurrent: 2, workspace: 'agent' },
      },
      agents: [
        {
          name: 'Lead',
          role: 'Game designer and planner',
          provider: 'anthropic',
          instructions:
            'You keep the game concept in docs/DESIGN.md up to date and break it into small, playable steps.',
        },
        {
          name: 'Programmer',
          role: 'Gameplay programmer',
          provider: 'anthropic',
          instructions: 'Gameplay and tech. The game must start after every change.',
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
          ...REVIEWER,
          instructions: `${REVIEWER.instructions} Start the game and try the change.`,
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
            'The core loop from DESIGN.md with placeholder graphics. Done when: it can be played for a minute.',
          status: 'todo',
          assignee: 'Programmer',
          reviewers: ['Reviewer'],
          blocked_by: [1],
        },
        {
          title: 'First graphics and sounds',
          description:
            'Player character, one enemy, three sounds in the style from DESIGN.md. Done when: they are in the game.',
          status: 'todo',
          assignee: 'Artist',
          reviewers: ['Reviewer'],
          blocked_by: [2],
        },
      ],
      routines: [PLANNER_ROUTINE],
    },
  },
  {
    id: 'blog',
    name: 'Blog with a daily article',
    summary: 'Every morning the writer drafts an article, and the editor checks it before it is published.',
    blueprint: {
      project: {
        description:
          'A blog. Articles live as Markdown in the repository. Topic and tone are in docs/EDITORIAL.md.',
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
          instructions: 'You check facts, sources, tone and spelling. Name the changes concretely.',
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
            'Write the article of the day following docs/EDITORIAL.md. Take the next open topic and cross it off the list. Reviewer: Editor.',
        },
      ],
    },
  },
]

export const listTemplates = () =>
  TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    summary: template.summary,
    agents: template.blueprint.agents.map((agent: any) => agent.name),
    issues: template.blueprint.issues.length,
  }))

export function applyTemplate(id: string, input: { key: string; name: string; repo_path?: string }) {
  const template = TEMPLATES.find((candidate) => candidate.id === id)
  if (!template) throw new Error('Unknown template')
  const blueprint = structuredClone(template.blueprint)
  // Paused, so the owner checks agents and providers before the first run spends anything.
  Object.assign(blueprint.project, {
    key: input.key,
    name: input.name,
    repo_path: input.repo_path ?? '',
    paused: true,
  })
  return applyBlueprint(blueprint)
}
