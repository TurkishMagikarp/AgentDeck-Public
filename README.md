# AgentDeck

A self-hosted board for teams of AI coding agents. You create a project, give it agents that run
through Claude Code, Codex or opencode, and file issues. The agents pick them up, work in their own
git checkout, hand work to reviewers and land the result, while you watch every run live.

AgentDeck is small on purpose: one Node process, one SQLite file, no external services.

## Features

- **Projects instead of organisations.** Each project has its own repository, agents, board and
  settings.
- **Agents through the CLIs you already use.** Claude Code, Codex CLI and opencode run as
  subprocesses; Deepseek runs through a built-in agent loop against its API. Per provider you choose
  subscription or API key, and Claude and Codex can be logged in from the web interface.
- **One branch per issue.** Agents work in git worktrees, either one per issue or one fixed checkout
  per agent so build caches survive.
- **Reviews and landing.** Issues can go through a chain of reviewers. Finished work is merged
  locally or opened as a pull request, with checks and protected paths.
- **Routines.** Recurring issues at a set time, e.g. a daily report.
- **Watchdog and autonomy.** Stuck issues are handed to a deputy agent or parked in the backlog, so
  nothing waits forever. Run budgets cap what a single run may spend.
- **Live run log.** Follow what an agent is doing while it works.
- **Usage and dashboard.** Tokens per agent (new and cached), quotas over time, what got done.
- **Built-in MCP connections.** GitHub, PixelLab, ElevenLabs, Recraft and Meshy, assigned per agent.
- **ADHD mode.** Per project, agents answer with one result line and at most three bullets.
- **Owner mails.** When an issue waits for a human, AgentDeck can send a mail through AgentMail.
- **Skill for Claude Code.** Describe a project in one sentence and let Claude set it up in
  AgentDeck.
- **Paperclip import.** Move an existing Paperclip company over, with issue numbers and history.

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

## Configuration

| Variable                | Default         | Meaning                                                    |
| ----------------------- | --------------- | ---------------------------------------------------------- |
| `PORT`, `HOST`          | 8790, 127.0.0.1 | Server address                                             |
| `AGENTDECK_DATA`        | `./data`        | Database, worktrees, working folders                       |
| `AGENTDECK_TOKEN`       | empty           | If set, the API requires `Authorization: Bearer …`         |
| `AGENTDECK_SECRET`      | empty           | Key for stored API keys; falls back to `data/secret.key`   |
| `AGENTDECK_TRUST_PROXY` | off             | `1`: trust the `Remote-User` header from a reverse proxy   |
| `AGENTDECK_CACHE_MB`    | 256             | SQLite page cache in RAM                                   |
| `AGENTDECK_MOCK`        | off             | `1`: adds a "Mock" provider for testing without real usage |

## Providers and access

Under "Providers and access" you pick subscription or API key per provider. For Claude and Codex
AgentDeck can start the CLI's login and show you the link and code. The same dialog holds the keys
for the MCP connections, which you then assign to individual agents.

API keys are stored encrypted in the database.

## Claude Code skill

```
cp -r skill/agentdeck ~/.claude/skills/
export AGENTDECK_URL=https://your-domain   AGENTDECK_TOKEN=…
```

Then a sentence like "Set up a project in AgentDeck for …" in Claude Code is enough.

## Importing from Paperclip

`scripts/import-paperclip.mjs` copies one Paperclip company into a new AgentDeck project: agents,
issues with their numbers, comments, blockers, review stages and active routines. Paperclip is only
read. With `--dry` everything goes to `import-preview.json` and nothing is sent.

```
AGENTDECK_TOKEN=… node scripts/import-paperclip.mjs --paperclip http://127.0.0.1:3101 \
  --auth /path/auth.json --company <company id> --key ABC --repo /repos/<name>
```

## Project layout

| Path                  | Contents                                                      |
| --------------------- | ------------------------------------------------------------- |
| `server/db.ts`        | SQLite schema and access (WAL, large page cache)              |
| `server/core.ts`      | Settings, board cache, events, usage, routing                 |
| `server/adapters.ts`  | Starting the agent CLIs and reading their output              |
| `server/engine.ts`    | Scheduler, hand-over between agents, watchdog                 |
| `server/landing.ts`   | Merging finished work or opening pull requests                |
| `server/auth.ts`      | Subscription or API key per provider, login from the UI       |
| `server/apiAgent.ts`  | Built-in agent for providers with a plain chat API (Deepseek) |
| `server/mcp.ts`       | Built-in MCP connections                                      |
| `server/blueprint.ts` | Creating a project from a JSON description                    |
| `server/main.ts`      | HTTP API, live events (SSE), serving the UI                   |
| `web/src`             | Web interface (SolidJS)                                       |
| `skill/agentdeck`     | Skill and CLI that let an AI build projects in AgentDeck      |

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
