# AgentDeck

A self-hosted board for teams of AI coding agents. You create a project, give it agents that run
through Claude Code, Codex or opencode, and file issues. The agents pick them up, work in their own
git checkout, hand work to reviewers and land the result, while you watch every run live.

AgentDeck is small on purpose: one Node process, one SQLite file, no external services.

## Features

- **Projects instead of organisations.** Each project has its own repository, agents, board and
  settings.
- **Agents through the CLIs you already use.** Claude Code, Codex CLI and opencode run as
  subprocesses; Deepseek runs through a built-in agent loop against its API, and Claude Managed
  Agents run the agent loop at Anthropic with the tools on your server. Per provider you choose
  subscription or API key, and Claude and Codex can be logged in from the web interface.
- **Templates.** Ready-made teams (SaaS MVP, game studio, blog with a daily article) create a
  project with agents, first issues and a planning routine in one step. New projects start paused.
- **One branch per issue.** Agents work in git worktrees, either one per issue or one fixed checkout
  per agent so build caches survive.
- **Reviews and landing.** Issues can go through a chain of reviewers. Finished work is merged
  locally or opened as a pull request, with checks and protected paths. A project can ask for proof
  (e.g. screenshots) before a branch that touches certain paths lands.
- **Branch preview.** When work goes to review, AgentDeck can start the app from the issue's branch
  and take a desktop and a phone screenshot with Playwright. Owner and reviewer see the result
  without starting anything.
- **Code changes and git view.** Each issue shows its commits and diff against the base branch,
  including uncommitted work while an agent is still on it. A graph per project shows the base
  branch, one lane per issue branch, what has landed and which agent works where.
- **Dependencies and blocker priority.** Issues can wait on other issues. An issue that holds up
  others starts first, boosted by how many it holds up through the whole chain. Rings of issues
  that wait on each other are resolved: the deputy agent decides which dependency goes, otherwise
  AgentDeck removes the newest one.
- **Waiting reasons.** Every issue that does not start says why: a blocker, a retry, a busy agent,
  the project limit, no provider left, or quota being saved.
- **Self-healing.** A failed run is sorted by kind of failure. A rate limit or a broken login rests
  the provider and does not count as a failed attempt; a missing tool or an overfull context gets a
  hint for the next run; the same unexplained error twice moves the issue to another provider.
- **Lessons.** Build commands, pitfalls and tools that had to be installed are recorded per project,
  by agents, by self-healing or by you. Every run reads the newest ones.
- **Quota pacing.** AgentDeck reads how full the subscription windows are and when they reset. With
  little left and the reset far away it runs one issue at a time and holds back big ones; shortly
  before a reset with plenty left, big issues go first.
- **Cost cap per issue.** An issue that used more than the project allows (dollars or tokens) is
  parked instead of eating everyone else's budget. You can grant it another round.
- **Routines.** Recurring issues at a set time, e.g. a daily report, or a planner that only fires
  when nothing in the project is open.
- **Watchdog and autonomy.** Stuck issues are handed to a deputy agent or parked in the backlog, so
  nothing waits forever. A parked issue that blocks open work goes back into the queue. Run budgets
  cap what a single run may spend.
- **Live run log.** Follow what an agent is doing while it works.
- **Issue search and issue page.** Search across all projects by key, number or words. Each issue
  has its own page with dependencies, history of changes, comments, screenshots and code.
- **Usage, outcomes and dashboard.** Tokens per agent (new and cached), quotas over time, what got
  done, and what the runs achieved: per agent how much of its work landed and how often reviewers
  approved it, per model how often a run ended with a usable result.
- **Built-in MCP connections.** GitHub, PixelLab, ElevenLabs, Recraft and Meshy, assigned per agent.
- **ADHD mode.** Per project, agents answer with one result line and at most three bullets.
- **Owner notifications.** When an issue waits for a human, AgentDeck sends a web push to your
  devices and, if set up, a mail through AgentMail.
- **Morning report.** Once a day at a set time, one look at the last 24 hours across all projects:
  one line per project, parked and finished work first. Sent by push and mail.
- **Showcase.** An optional read-only public page per project at `/show/<slug>` that shows the
  agents at work, for a demo or a job application. Never code, costs or comments.
- **Housekeeping.** Old run logs, finished branches, temp files and CLI sessions are cleaned up once
  a day; checkouts that grew too big lose their build output before their next run.
- **Skill for Claude Code.** Describe a project in one sentence and let Claude set it up in
  AgentDeck.

## Quick start

Requires Node.js 24 or newer.

```
npm install
npm start            # builds the UI and serves it on http://localhost:8790
npm run dev:mock     # same on port 8799, with a mock agent instead of real CLIs
```

While working on the UI, run `npm run server` and `npm run dev` in a second terminal.

## Running with Docker

```
echo "AGENTDECK_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build

# log in to each CLI once; the logins are kept in the "home" volume
docker compose exec agentdeck claude
docker compose exec agentdeck codex login
docker compose exec agentdeck opencode auth login
```

Repositories the agents should work on go to `/srv/agentdeck/repos` on the host and appear as
`/repos/<name>` in the container. That path is what you enter in the project.

The image contains Git, Node, Python 3 with venv, uv, a C compiler and a virtual display with
software OpenGL for agents that render or screenshot what they build. Agents may install more with
`sudo apt-get install` inside the container; those packages last until the container is rebuilt, so
anything needed permanently belongs in the Dockerfile. Python versions and packages installed with
uv live in the `home` volume and survive.

### Behind a reverse proxy

The compose file binds the port to 127.0.0.1. Put a reverse proxy with authentication in front
(e.g. nginx with Authelia or oauth2-proxy). Live events need unbuffered responses:

```
location / {
    # ... your authentication ...
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Remote-User $user;
}
location /api/events {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Remote-User $user;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

`AGENTDECK_TRUST_PROXY=1` lets requests with a `Remote-User` header in without a token. It is only
safe while the port is reachable through the proxy alone and the proxy sets that header itself.

### Showcase behind Authelia

The showcase is reachable without a login on purpose. If Authelia guards the whole domain, it needs
an exception for exactly these paths, or nobody sees the page:

```
access_control:
  rules:
    - domain: agents.example.com
      resources: ['^/show/[\w-]+$', '^/api/public/[\w-]+$', '^/icon\.svg$']
      policy: bypass
```

The page shows agents, states and counts, and issue titles only when switched on. Code, comments,
costs and settings never leave the login. "New link" invalidates the old one at once.

## Configuration

| Variable                      | Default         | Meaning                                                       |
| ----------------------------- | --------------- | ------------------------------------------------------------- |
| `PORT`, `HOST`                | 8790, 127.0.0.1 | Server address                                                |
| `AGENTDECK_DATA`              | `./data`        | Database, worktrees, working folders                          |
| `AGENTDECK_TOKEN`             | empty           | If set, the API requires `Authorization: Bearer …`            |
| `AGENTDECK_SECRET`            | empty           | Key for stored API keys; falls back to `data/secret.key`      |
| `AGENTDECK_TRUST_PROXY`       | off             | `1`: trust the `Remote-User` header from a reverse proxy      |
| `AGENTDECK_CACHE_MB`          | 256             | SQLite page cache in RAM                                      |
| `AGENTDECK_MOCK`              | off             | `1`: adds a "Mock" provider for testing without real usage    |
| `AGENTDECK_PUBLIC_URL`        | empty           | Public address for links in mails and as the web push sender  |
| `AGENTDECK_CHECKOUT_LIMIT_GB` | 10              | Checkouts above this size lose their build output on next run |

## Providers and access

Under "Providers and access" you pick subscription or API key per provider. For Claude and Codex
AgentDeck can start the CLI's login and show you the link and code. The same dialog holds the keys
for the MCP connections, which you then assign to individual agents.

API keys are stored encrypted in the database.

## Faster runs: check after approval

What measurements on a real project with six agents showed, and what AgentDeck does about it:

- **Check command only before landing** (project settings, precheck): reviewers see finished work
  at once. The check command runs once after the last approval on the merged state, and only green
  is pushed. Red takes the merge back and returns to the maker with the output. Makers and reviewers
  are told in their prompt not to run the full test suite themselves. Before, the same tests ran at
  the maker, at the QA reviewer and before the review.
- **Ticket format**: agents get in their prompt what an issue looks like (Goal, Task, Files, Done
  when, Out of scope, Notes). The agent API rejects an issue without Task, Files and Done when.
  That way smaller models are enough for makers; the strong ones stay with planning and review.
- **One reviewer instead of a chain**: two reviewers in a row cost one whole extra run per issue.
  Only those who must judge should review; what a test can decide, the test decides.
- **Dependencies as blockers**: the scheduler only sees `blocked_by`. A sentence like "waits for X
  to be built" in the description lets the issue start too early. And work that sits only in a group
  opened later does not start, even if everything else waits for it.

The lever with the biggest effect was none of the model or test tricks, but the question why only
one run was going when ten were allowed.

## Claude Code skill

```
cp -r skill/agentdeck ~/.claude/skills/
export AGENTDECK_URL=https://your-domain   AGENTDECK_TOKEN=…
```

Then a sentence like "Set up a project in AgentDeck for …" in Claude Code is enough.

## Importing from another tracker

`POST /api/import` creates a project from a JSON description and keeps issue numbers, dates and
comments (see `server/importer.ts`). The imported project starts paused.

## Project layout

| Path                     | Contents                                                      |
| ------------------------ | ------------------------------------------------------------- |
| `server/db.ts`           | SQLite schema and access (WAL, large page cache)              |
| `server/core.ts`         | Settings, board cache, events, usage, routing                 |
| `server/adapters.ts`     | Starting the agent CLIs and reading their output              |
| `server/engine.ts`       | Scheduler, hand-over between agents, watchdog                 |
| `server/landing.ts`      | Merge or pull request, check command before the push          |
| `server/checklist.ts`    | Acceptance checklist per issue: "Done when" plus templates    |
| `server/precheck.ts`     | Precheck before review: proof files, merge, check command     |
| `server/ticket.ts`       | Ticket format agents follow when they create issues           |
| `server/auth.ts`         | Subscription or API key per provider, login from the UI       |
| `server/apiAgent.ts`     | Built-in agent for providers with a plain chat API (Deepseek) |
| `server/managedAgent.ts` | Claude Managed Agents with the tools running on this server   |
| `server/mcp.ts`          | Built-in MCP connections                                      |
| `server/blueprint.ts`    | Creating a project from a JSON description                    |
| `server/importer.ts`     | Taking over a project from another tracker                    |
| `server/recovery.ts`     | Self-healing: kind of failure, resting providers, hints       |
| `server/lessons.ts`      | What a project has learned, read by every run                 |
| `server/pacing.ts`       | Spending quota along the subscription windows                 |
| `server/blockers.ts`     | Blocker priority and dependency rings                         |
| `server/issueCap.ts`     | Cost cap per issue                                            |
| `server/preview.ts`      | Starting a branch's app and taking screenshots                |
| `server/diff.ts`         | Code changes of an issue (branch diff, uncommitted work)      |
| `server/gitGraph.ts`     | Data for the git graph: branches, commits, agents             |
| `server/search.ts`       | Issue search across all projects                              |
| `server/stats.ts`        | Usage and outcome metrics                                     |
| `server/push.ts`         | Web push to your devices                                      |
| `server/report.ts`       | Morning report across all projects                            |
| `server/showcase.ts`     | Public showcase of a project at `/show/…`                     |
| `server/templates.ts`    | Ready-made teams for new projects                             |
| `server/housekeeping.ts` | Daily cleanup of logs, branches, temp files and sessions      |
| `server/main.ts`         | HTTP API, live events (SSE), serving the UI                   |
| `web/src`                | Web interface (SolidJS)                                       |
| `skill/agentdeck`        | Skill and CLI that let an AI build projects in AgentDeck      |

Stack: Node 24 (runs TypeScript directly, `node:sqlite`), Hono, SolidJS, Vite, server-sent events.

## Load test

```
AGENTDECK_MOCK=1 AGENTDECK_MOCK_MS=300 AGENTDECK_DATA=./data-load PORT=8796 node server/main.ts
node scripts/loadtest.mjs http://localhost:8796 5000 40
```

Creates 5000 issues, measures reads and writes, and lets 40 mock agents work through 600 issues
while 100 clients follow the live events. The "read board" times include unpacking and parsing in
the test client; the server itself answers from RAM.

## License

MIT, see [LICENSE](LICENSE). Anyone may use, change and share AgentDeck as they like.
