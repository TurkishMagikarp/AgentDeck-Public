# AgentDeck: Forgejo-backed pull requests

Deutsch: [forgejo-landing.de.md](forgejo-landing.de.md)

Forgejo owns code and PRs. CI can live elsewhere: in the setup this was written for, a separate
repository holds only the workflow definitions, its runners fetch one Forgejo commit over a
read-only SSH gateway, and a timer on the host dispatches the builds and publishes the required
contexts as commit statuses.

AgentDeck defaults to its existing GitHub behavior. To opt in, the operator mounts
`/run/agentdeck-forgejo/projects.json` and the per-project Forgejo tokens read-only, server-readable
but not readable by project users. Do not put secrets in compose environment variables, checked-in
files, project settings, the Git URL or agent instructions. Example **without** secrets:

```json
{
  "SHOP": {
    "api": "http://forgejo-internal:3000/api/v1/",
    "repository": "owner/example",
    "origin": "ssh://git@forgejo-internal:2222/owner/example.git",
    "tokenFile": "/run/agentdeck-forgejo/shop.token",
    "requiredChecks": [
      "ci/rust",
      "ci/godot",
      "ci/windows",
      "ci/macos"
    ]
  }
}
```

Keep Forgejo API and SSH on a private Docker network shared with AgentDeck. Authelia remains in
front of the public Forgejo site. The AgentDeck server's API token belongs to a non-admin with
access limited to this repository. Git runs as `ad-shop`; pin the Forgejo SSH host key in that
project user's home and use a separate, repository-specific SSH credential. Never reuse the host's
administrator key or the read-only GitHub CI key.

## Cutover

1. Verify the CI baseline is green in Forgejo and all four contexts refer to the same commit.
   Compare GitHub and Forgejo `main`, the currently open PR numbers, heads and base branches.
   Do not force-push divergent work. Preserve the old origin for rollback.
2. Pause the project and let running jobs finish. Protect Forgejo `main` against direct pushes and
   require the four contexts. Test the service account's API reads and the project user's Git
   access before changing `origin`. Keep private sources and tokens out of deployment packages.
3. Deploy the AgentDeck build with the private mount and network. Change only the target project's
   `origin`, including any push URL; clear its old GitHub token-file setting. Git operations on
   `/repos/shop` must run as `ad-shop`, not as root. Do not change other projects' remotes.
4. Imported waiting PRs without a stored `pr_sha` are held for review. Never fill a missing
   approval with whatever SHA is currently on the remote. Re-review and resubmit through
   AgentDeck. A PR must match the configured repository, expected branch and base, exact approved
   commit and all four check contexts before AgentDeck merges that SHA.
5. Verify a real issue through PR and status handling before retiring the old GitHub standard CI.
   Keep the old repo private and available until the owner confirms it can be deleted. The legacy
   Windows schedule is already in the central CI repo and is not a merge gate.

## Rollback

Pause the project. If Forgejo accepted new commits or PR changes, reconcile them before repointing
anything. Restore the original project remote, GitHub token-file setting and previous AgentDeck
deployment or remove only that project's Forgejo config. Verify Git and PR reads, then resume.
Do not restore a whole live AgentDeck database over unrelated projects.
