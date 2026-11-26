# Notes for agents working on AgentDeck

The README explains what AgentDeck does. This file has the rules for changing its code.

## Run and check

- `npm test` (node:test, 126+ tests) and `npx tsc --noEmit -p .` before every commit.
- `npm run dev:mock` starts the server with mock agents (`.env.dev`), no CLI logins needed.
- The tests switch the sandbox off (`test/no-sandbox.mjs`), also inside the image.

## The sandbox (server/sandbox.ts)

In the container (`AGENTDECK_SANDBOX=1`, Linux only) every project runs as a Linux user of its
own, `ad-<key>`, with uids from 20000. It owns the project's repo, `/data/worktrees/<KEY>`,
`/data/workspaces/<KEY>`, `/data/rtk/<KEY>`, `/data/landing/<KEY>` and its home
`/data/homes/ad-<key>`. All projects share one container; this is user separation, not a
container per project.

Rules for new code:

- **Never start a process in a project directory with `child_process` directly.** Use
  `spawnIn`, `spawnShellIn`, `execIn`, `gitIn` or `runShellIn` from `server/sandbox.ts`.
  They pick the user from the owner of the directory (`ownerOf`). A plain `git` call as the
  server would run hooks or `core.fsmonitor` an agent planted, with the server's rights.
- Code the agent controls (`agent = true`, every shell command) never falls back to the server
  user in the sandbox.
- Stop process groups with `stopGroup`, not `process.kill`: groups started through sudo can only
  be stopped by the helper.
- The env of a project user goes through `envFor`: `AGENTDECK_TOKEN`, `AGENTDECK_SECRET` and
  `AGENTDECK_PROXY_SECRET` are removed. A new server secret belongs in `SERVER_SECRETS`.
- Files for a run (MCP configs and the like) go into the project home with `placeInHome`, not
  into server folders.
- Logins: `loginsIn` copies the server's CLI logins in before a run. `loginsOut` takes back only
  `TOKEN_FILES` (JSON token files) and passes refreshed tokens on to the other running projects.
  Never add a file to `TOKEN_FILES` that can hold commands (`.claude.json`, `config.toml`,
  settings): the server runs the CLIs as itself too (blueprints), so that would let an agent run
  code as the server.
- Skills, plugins and the opencode/Godot config come from `SHARED_CONFIG` (`seedHome`), copied
  when they changed.
- Root work goes only through `docker/agentdeck-sandbox` (`ensure`, `install`, `kill`). Keep
  it small; every argument is checked there again. `docker/sudoers` allows the server nothing
  else. Changes to either: run `docker/sandbox-check.sh` in the built image (all lines PASS; the
  header says how).
- Claude Managed Agents are off in the sandbox (`startManagedRun` throws): the SDK's worker runs
  the tools inside the server process. Lift that only once the tools run as the project user.
- Agents install system packages with `agentdeck install <pkg>` (`POST /packages`), never sudo.
- Outbound network per project (`settings.egress`, `server/egress.ts`): in `allowlist` mode the helper's
  `egress` verb limits the project uid to loopback, and `envFor` points the proxy vars at the egress
  proxy, which identifies the project by the socket's uid. New server-side code that the agent
  controls must keep going through `envFor`, otherwise its traffic bypasses the proxy and fails.

## Testing the sandbox end to end

Build the image, replace `/usr/local/bin/codex` in a test container with a fake CLI that prints
Codex JSON (`thread.started`, `item.completed` agent_message, `turn.completed`) and probes what
it can reach, create projects with `repo_path` under `/repos` through the API, and read the
probes from the issue comments. Run test containers with `--init`, otherwise killed processes
stay as zombies.

## A feature is finished when it is on main

Deploying is not finishing. The deployed source once grew far apart from `main` because features
were built on side branches and snapshots, deployed, and never merged. Do not repeat that.

- Start every piece of work in a worktree of its own, cut from a freshly fetched `origin/main`.
  Never work on a copy of the deployed source that has no shared history with `main`.
- When the feature works (`npm test` and `npx tsc --noEmit -p .` are green), merge it into `main`
  and push `main` yourself, without waiting to be asked. Do this before the deploy, or right
  after it at the latest.
- Deploy only what `main` holds. If you had to deploy from a branch, merge that branch into `main`
  in the same session.
- A branch that is not merged at the end of your session is unfinished work: say so in your
  summary, with the branch name and what is missing.
- Every text a person or a model reads exists in German and English (see "Two languages").

## Two languages

Every text a person or a model reads exists in German and English.

- German is the source text and the key: `t('Geparkt: {reason}', { reason })`. The English entry
  goes into `server/i18n/en.*.ts` or `web/src/i18n/en.*.ts`. `test/i18n.test.ts` and
  `test/i18nServer.test.ts` fail on a missing entry.
- Prompts for models live side by side in `server/prompts/de.ts` and `server/prompts/en.ts`.
  What code parses (blocks, status values, checklist marks) is the same in both.
- Never call `t()` in a module-level constant. Work for a project runs in that project's language:
  enter it through `forProject(project, …)`. Requests run in the language of the person asking.
- Code that recognizes stored text (a comment that starts with "Geparkt:") matches both languages
  with `variants()`.

## Deploying

A deploy is: build the image, run the tests in it, pause the projects, restart, resume.
Host-side git on a project repo must run as the project user
(`docker exec agentdeck sudo -n -u ad-<key> git …`), otherwise git refuses (dubious ownership).
Host folders only one project uses belong to its uid.
