---
name: agentdeck
description: Set up or extend a project in AgentDeck (the user's agent management board) from a plain-language description. Use when the user asks to build, plan or staff a project "in AgentDeck", to add agents, skills or issues to an AgentDeck project, or to check what the agents there are working on.
---

# AgentDeck

AgentDeck runs teams of coding agents on a shared Jira-style board. A project has agents, skills and issues.
Agents pick up issues in status `todo` on their own, comment in the issue and hand work over to each other.

You set a project up by writing one JSON **blueprint** and applying it. One call creates everything.

## Connection

The client script next to this file talks to the API. It reads three environment variables:

- `AGENTDECK_URL` (default `http://localhost:8790`)
- `AGENTDECK_TOKEN` (only if the server requires one)
- `AGENTDECK_LANG` (`de` or `en`, default `en`): the language of its output and of the server's answers

A German version of this file is next to it: `SKILL.de.md`.

If a call fails with `unauthorized` or a connection error, ask the user for the URL or token. Do not guess.

## Workflow

1. Read the current blueprint format and the available providers. Always do this first, the format is
   served by the running AgentDeck version:

   ```
   node <skill-dir>/agentdeck.mjs guide
   ```

2. Check what already exists, so you extend instead of duplicating:

   ```
   node <skill-dir>/agentdeck.mjs projects
   node <skill-dir>/agentdeck.mjs board <KEY>
   ```

3. Design the project from the user's description:
   - Break the goal into small issues that one agent can finish and verify in a single run. Each needs
     acceptance criteria in the description.
   - Order work with `blocked_by`, not with prose like "do this after X".
   - Keep the team small: usually a planner, one or two implementers, a reviewer. Raise `max_instances`
     only for agents whose issues are independent of each other.
   - Shared conventions (stack, testing, commit style) belong in a skill that several agents reference.
   - Use only providers the user named or that `guide` lists. If the user gave limits ("stop OpenAI at
     10 % left", "fall back to Deepseek"), express them in `project.settings.budgets` and `fallback`.
   - Set `project.settings.language` to `de` when the team should work in German, otherwise to `en`.
   - Issues that need a human decision stay in `backlog`. Everything in `todo` starts immediately.

4. Unless the user asked you to just do it, show a short summary (agents, number of issues, what starts
   right away) and get a go-ahead. Applying a blueprint with `todo` issues starts agents and spends usage.

5. Write the blueprint to a file and apply it:

   ```
   node <skill-dir>/agentdeck.mjs apply blueprint.json
   ```

   Applying a blueprint whose `project.key` already exists extends that project: agents and skills are
   matched by name and updated, issues are always added.

6. Report what was created and the board URL the script prints.
