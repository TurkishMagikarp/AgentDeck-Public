// Landing, checks before it, webhooks, intake and the views built from them (landing.ts,
// forgejoLanding.ts, precheck.ts, gates.ts, secretScan.ts, webhooks.ts, githubWebhook.ts, intake.ts,
// dossier.ts, gitGraph.ts, workspace.ts, preview.ts).
export const en_landing: Record<string, string> = {
  // landing: notes on the issue
  'Die GitHub-Token-Datei {file} fehlt oder ist leer.': 'The GitHub token file {file} is missing or empty.',
  'Der Branch ändert {files}, aber deine Zusammenfassung enthält keinen Nachweis ({markers}). Bitte nachholen und erneut abgeben.':
    'The branch changes {files}, but your summary contains no proof ({markers}). Please add it and submit again.',
  ' oder ': ' or ',
  'Wartet auf deine Freigabe vor der Landung ({reasons}). Mit „Landung freigeben“ landet genau der Stand {tip}; ändert sich der Branch danach, braucht er eine neue Freigabe.':
    'Waiting for your approval before landing ({reasons}). "Approve landing" lands exactly commit {tip}; if the branch changes after that, it needs a new approval.',
  'Landung fehlgeschlagen: {error}': 'Landing failed: {error}',
  'Im Repository ist "{checkedOut}" ausgecheckt, gelandet wird aber auf "{base}".':
    'The repository has "{checkedOut}" checked out, but landing goes to "{base}".',
  'Der Branch lässt sich nicht konfliktfrei in {base} mergen. Bitte {base} in den Branch mergen, die Konflikte lösen und erneut abgeben.':
    'The branch does not merge into {base} without conflicts. Please merge {base} into the branch, resolve the conflicts and submit again.',
  'Der Stand war grün, aber {base} hat sich während des Tests bewegt oder das Repository hat lokale Änderungen. Nichts wurde gelandet.':
    'The check was green, but {base} moved during the test or the repository has local changes. Nothing was landed.',
  'Lokal in {base} gemergt ({commit}), aber der Push ist fehlgeschlagen.':
    'Merged into {base} locally ({commit}), but the push failed.',
  'In {base} gelandet ({commit}).': 'Landed in {base} ({commit}).',
  'In {base} gelandet ({commit}, `{command}` grün).': 'Landed in {base} ({commit}, `{command}` green).',

  // landing: trace steps
  'Landung eingereiht (Modus {mode}).': 'Landing queued (mode {mode}).',
  'Der Issue hat keinen Branch (z. B. ein Bericht): nichts zu landen.':
    'The issue has no branch (a report, for example): nothing to land.',
  'Prüfe Stand {tip} gegen {base}.': 'Checking commit {tip} against {base}.',
  'Prüfe Stand {tip} gegen {base}. Eine Freigabe für genau diesen Stand liegt vor.':
    'Checking commit {tip} against {base}. An approval for exactly this commit exists.',
  'Keine neuen Commits gegenüber {base}: schon gelandet.': 'No new commits compared to {base}: already landed.',
  '{n} geänderte Datei(en): {files}': '{n} changed file(s): {files}',
  'Nachweise fehlen, zurück an den Maker.': 'Proof is missing, back to the maker.',
  'Geheimnis-Scan: {n} Fund(e), Landung gestoppt.': 'Secret scan: {n} finding(s), landing stopped.',
  'Geheimnis-Scan: nichts gefunden.': 'Secret scan: nothing found.',
  'Freigabe-Gate ({n}) mit Freigabe des Owners überschritten.': 'Approval gate ({n}) passed with the owner\'s approval.',
  'Freigabe-Gate hält die Landung an: {reasons}': 'Approval gate holds the landing: {reasons}',
  '{base} von origin aktualisiert.': '{base} updated from origin.',
  'Pull von origin/{base} nicht möglich, weiter mit dem lokalen Stand.':
    'Could not pull origin/{base}, continuing with the local state.',
  'Merge von {tip} in {base} (Test-Arbeitsbaum) hat Konflikte.':
    'Merging {tip} into {base} (test worktree) has conflicts.',
  '{tip} in {base} gemergt, im Test-Arbeitsbaum ({base} selbst unberührt).':
    '{tip} merged into {base}, in the test worktree ({base} itself untouched).',
  'Starte Projektprüfung "{command}" (max. {minutes} min).': 'Starting project check "{command}" (max. {minutes} min).',
  'Projektprüfung rot nach {seconds} s: {line}': 'Project check red after {seconds} s: {line}',
  'Projektprüfung grün nach {seconds} s.': 'Project check green after {seconds} s.',
  '{base} ließ sich nicht auf {tip} vorrücken (hat sich bewegt oder lokale Änderungen). Nichts gelandet.':
    '{base} could not be advanced to {tip} (it moved or has local changes). Nothing landed.',
  '{base} auf {tip} vorgerückt (fast-forward, nur der getestete Stand).':
    '{base} advanced to {tip} (fast-forward, only the tested commit).',
  'Merge von {tip} in {base} hat Konflikte.': 'Merging {tip} into {base} has conflicts.',
  '{tip} direkt in {base} gemergt (keine Projektprüfung eingestellt).':
    '{tip} merged directly into {base} (no project check configured).',
  'Push nach origin/{base} fehlgeschlagen. Lokal gelandet ({commit}).':
    'Push to origin/{base} failed. Landed locally ({commit}).',
  'Nach origin/{base} gepusht.': 'Pushed to origin/{base}.',
  'Branch {branch} auf Stand {tip} nach origin (Forgejo) gepusht.':
    'Branch {branch} pushed to origin (Forgejo) at commit {tip}.',
  'Branch {branch} auf Stand {tip} nach origin gepusht.': 'Branch {branch} pushed to origin at commit {tip}.',

  // landing: pull requests on GitHub
  'Pull Request #{number} hat genau den Stand {tip} schon in {base} gemergt.':
    'Pull request #{number} has already merged exactly commit {tip} into {base}.',
  'Pull Request #{number} ist schon gemergt.': 'Pull request #{number} is already merged.',
  'Pull Request #{number} ist offen und wartet auf Checks (Stand {tip}).':
    'Pull request #{number} is open and waits for checks (commit {tip}).',
  'Pull Request #{number} ist offen und wartet auf seine Checks.': 'Pull request #{number} is open and waits for its checks.',
  'Pull Request #{number} ist gemergt.': 'Pull request #{number} is merged.',
  'Pull Request #{number} wurde ohne Merge geschlossen.': 'Pull request #{number} was closed without a merge.',
  'Pull Request #{number} wurde geschlossen, ohne zu mergen.': 'Pull request #{number} was closed without merging.',
  'Pull Request #{number} zeigt {head} statt des geprüften Stands {tip}. Nichts gemergt.':
    'Pull request #{number} points at {head} instead of the reviewed commit {tip}. Nothing merged.',
  'Pull Request #{number} zeigt nicht mehr den geprüften Stand {tip}. Nichts wurde gemergt.':
    'Pull request #{number} no longer points at the reviewed commit {tip}. Nothing was merged.',
  'Checks im Pull Request #{number} rot: {failed}.': 'Checks in pull request #{number} red: {failed}.',
  'Checks im Pull Request #{number} sind fehlgeschlagen: {failed}.': 'Checks in pull request #{number} failed: {failed}.',
  'Checks grün; Pull Request #{number} per {method} gemergt (nur Commit {commit}).':
    'Checks green; pull request #{number} merged with {method} (only commit {commit}).',
  'Pull Request #{number} gemergt.': 'Pull request #{number} merged.',

  // landing: pull requests on Forgejo
  'Der Git-Remote origin stimmt nicht mit der Forgejo-Landing-Konfiguration überein.':
    'The git remote origin does not match the Forgejo landing configuration.',
  'Für den übernommenen PR #{number} fehlt ein geprüfter Commit. Bitte neu prüfen und abgeben.':
    'The adopted PR #{number} has no reviewed commit. Please review and submit again.',
  'Forgejo-PR #{number} ist gemergt.': 'Forgejo PR #{number} is merged.',
  'Forgejo-PR #{number} gehört nicht zum erwarteten Branch und Ziel.':
    'Forgejo PR #{number} does not belong to the expected branch and target.',
  'Forgejo-PR #{number} zeigt nicht mehr den geprüften Commit. Nichts wurde gemergt.':
    'Forgejo PR #{number} no longer points at the reviewed commit. Nothing was merged.',
  'Forgejo-PR #{number} wurde geschlossen, ohne zu mergen.': 'Forgejo PR #{number} was closed without merging.',
  'Checks im Forgejo-PR #{number} rot: {failed}.': 'Checks in Forgejo PR #{number} red: {failed}.',
  'Checks im Forgejo-PR #{number} sind fehlgeschlagen: {failed}.': 'Checks in Forgejo PR #{number} failed: {failed}.',
  'Checks grün; Forgejo-PR #{number} per {method} gemergt (nur Commit {commit}).':
    'Checks green; Forgejo PR #{number} merged with {method} (only commit {commit}).',
  'Forgejo-PR #{number} gemergt.': 'Forgejo PR #{number} merged.',
  'Ungültige Forgejo-Landing-Konfiguration.': 'Invalid Forgejo landing configuration.',
  'Forgejo-Landing-Token fehlt oder ist ungültig.': 'The Forgejo landing token is missing or invalid.',
  'Forgejo-API: HTTP {status}.': 'Forgejo API: HTTP {status}.',
  'Ungültiger Commit für Forgejo-Landung.': 'Invalid commit for the Forgejo landing.',
  'Zu viele offene Forgejo-Pull-Requests.': 'Too many open Forgejo pull requests.',
  'Der Forgejo-Pull-Request passt nicht zum geprüften Branch und Commit.':
    'The Forgejo pull request does not match the reviewed branch and commit.',
  'Ungültige Forgejo-Pull-Request-Nummer.': 'Invalid Forgejo pull request number.',
  'Ungültiger Commit für Forgejo-CI.': 'Invalid commit for Forgejo CI.',
  'Ungültiger Forgejo-Merge.': 'Invalid Forgejo merge.',

  // precheck
  '{base} lässt sich nicht konfliktfrei in den Branch mergen. Konflikte in: {files}. Merge {base} in deinen Branch, löse die Konflikte so, dass beide Seiten erhalten bleiben, und gib erneut ab.':
    '{base} does not merge into the branch without conflicts. Conflicts in: {files}. Merge {base} into your branch, resolve the conflicts so that both sides are kept, and submit again.',
  '{base} lässt sich nicht konfliktfrei in den Branch mergen. Merge {base} in deinen Branch, löse die Konflikte so, dass beide Seiten erhalten bleiben, und gib erneut ab.':
    '{base} does not merge into the branch without conflicts. Merge {base} into your branch, resolve the conflicts so that both sides are kept, and submit again.',
  'Die Projektprüfung `{command}` ist auf dem gemergten Stand nach {minutes} Minuten abgebrochen. Behebe das und gib erneut ab.':
    'The project check `{command}` was stopped on the merged state after {minutes} minutes. Fix that and submit again.',
  'Die Projektprüfung `{command}` ist auf dem gemergten Stand fehlgeschlagen (Exit-Code {code}). Behebe das und gib erneut ab.':
    'The project check `{command}` failed on the merged state (exit code {code}). Fix that and submit again.',
  'Diese Nachweis-Dateien aus deiner Checkliste fehlen in deinem Commit: {files}. Erzeuge und committe sie (Pfad relativ zum Repo) und gib erneut ab.':
    'These proof files from your checklist are missing in your commit: {files}. Create and commit them (path relative to the repo) and submit again.',
  '1 Nachweis-Datei vorhanden': '1 proof file present',
  '{n} Nachweis-Dateien vorhanden': '{n} proof files present',
  'Nicht committete Änderungen in {files}. Committe, was zum Issue gehört, verwirf den Rest und gib erneut ab.':
    'Uncommitted changes in {files}. Commit what belongs to the issue, discard the rest and submit again.',
  'Dein Branch enthält Arbeit aus anderen Branches, die noch nicht in {base} gelandet ist: {branches}. Nimm sie wieder heraus (neu von {base} abzweigen und nur deine Commits übernehmen). Brauchst du diese Arbeit, merge den Branch nicht, sondern melde <status>blocked</status> mit "wartet auf ..." und dem Issue: dann geht es von selbst weiter, sobald es gelandet ist.':
    'Your branch contains work from other branches that has not landed in {base} yet: {branches}. Take it out again (branch off {base} anew and carry over only your commits). If you need that work, do not merge the branch but report <status>blocked</status> with "waiting for ..." and the issue: it then continues on its own once that has landed.',
  'mit {base} konfliktfrei': 'no conflicts with {base}',
  'keine Geheimnisse': 'no secrets',
  '`{command}` grün': '`{command}` green',
  'Vorcheck bestanden: {checks}.': 'Precheck passed: {checks}.',

  // approval gates
  '{file} (nicht lesbar)': '{file} (not readable)',
  'geschützte Dateien: {files}': 'protected files: {files}',
  'Infrastruktur-Dateien: {files}': 'infrastructure files: {files}',
  'neue Abhängigkeiten: {names}': 'new dependencies: {names}',
  'jede Landung braucht deine Freigabe': 'every landing needs your approval',
  ' und {n} weitere': ' and {n} more',

  // secret scan
  'privater Schlüssel': 'private key',
  'Passwort oder Token im Code': 'password or token in the code',
  'Anthropic-API-Key': 'Anthropic API key',
  'OpenAI-/DeepSeek-API-Key': 'OpenAI/DeepSeek API key',
  'GitHub-Token': 'GitHub token',
  'AWS-Access-Key': 'AWS access key',
  'Google-API-Key': 'Google API key',
  'Slack-Token': 'Slack token',
  'Stripe-Key': 'Stripe key',
  'npm-Token': 'npm token',
  '{start}… ({n} Zeichen)': '{start}… ({n} characters)',
  'Dein Branch enthält, was wie ein Geheimnis aussieht (API-Key, Token oder privater Schlüssel):\n{findings}\n\nNimm es aus dem Code und aus allen Commits heraus: Ein Commit, der es nur wieder löscht, reicht nicht, die Historie wird mitgepusht. Zweige dazu neu von {base} ab und übernimm deine Arbeit ohne das Geheimnis. Werte, die der Code braucht, kommen aus Umgebungsvariablen. Für Testdaten nimm erkennbar falsche Werte (mit "example" darin). Gib dann erneut ab.':
    'Your branch contains what looks like a secret (API key, token or private key):\n{findings}\n\nTake it out of the code and out of all commits: a commit that only deletes it again is not enough, the history is pushed too. Branch off {base} anew and carry over your work without the secret. Values the code needs come from environment variables. For test data use values that are clearly fake (with "example" in them). Then submit again.',
  'Der Branch enthält, was wie ein Geheimnis aussieht, deshalb landet er nicht automatisch:\n{findings}\n\nIst es echt: den Key beim Anbieter sperren und ersetzen, dann das Issue zurückgeben. Ist es ein Fehlalarm: selbst prüfen und mergen.':
    'The branch contains what looks like a secret, so it does not land automatically:\n{findings}\n\nIf it is real: revoke and replace the key at the provider, then hand the issue back. If it is a false alarm: check and merge it yourself.',

  // outgoing webhooks
  'In Arbeit': 'In progress',
  Blockiert: 'Blocked',
  Erledigt: 'Done',
  'Zur Prüfung': 'In review',
  'Lauf fehlgeschlagen': 'Run failed',
  'Wartet auf dich': 'Waiting for you',
  'Test von AgentDeck': 'Test from AgentDeck',
  'Ungültige Webhook-Adresse': 'Invalid webhook address',
  'Zugangsdaten gehören nicht in die Webhook-Adresse': 'Credentials do not belong in the webhook address',
  'Nur https-Adressen sind erlaubt': 'Only https addresses are allowed',
  'Adresse im privaten Netz ist nicht erlaubt': 'An address in a private network is not allowed',
  'Host nicht gefunden': 'Host not found',
  'Zeitüberschreitung (5 s)': 'Timed out (5 s)',
  'Mindestens ein Ereignis wählen': 'Choose at least one event',
  '{reason} nach {attempt} Versuch(en)': '{reason} after {attempt} attempt(s)',
  'Webhook nicht gefunden, bitte neu anlegen': 'Webhook not found, please create it again',
  'Der Empfänger antwortet mit HTTP {status}': 'The receiver answers with HTTP {status}',

  // GitHub webhook and issue intake
  'Webhook nicht eingerichtet': 'Webhook not set up',
  'zu viele ungültige Anfragen': 'too many invalid requests',
  'zu groß': 'too large',
  'JSON erwartet': 'JSON expected',
  'GitHub-Issue #{number}': 'GitHub issue #{number}',
  'Quelle: [{issue}]({url}), gemeldet von {author} auf GitHub.':
    'Source: [{issue}]({url}), reported by {author} on GitHub.',
  unbekannt: 'unknown',
  '… (gekürzt)': '… (truncated)',

  // dossier and feed
  '[GEHEIM: ': '[SECRET: ',
  'Aufzeichnung gekürzt': 'Recording truncated',
  'Lauf #{id} ({model}): {status}': 'Run #{id} ({model}): {status}',
  Landung: 'Landing',
  '{n} Lauf/Läufe fehlgeschlagen': '{n} run(s) failed',
  '{n} Geheimnis(se) in der Aufzeichnung geschwärzt': '{n} secret(s) redacted in the recording',
  '{n} Abruf(e) ins Netz': '{n} network request(s)',
  '{n} Fehlerschritt(e) im Verlauf': '{n} error step(s) in the history',
  '{n} Lauf/Läufe nur teilweise aufgezeichnet (Größenlimit), weitere Schritte fehlen':
    '{n} run(s) only partly recorded (size limit), further steps are missing',
  '{n} Lauf/Läufe ohne Aufzeichnung': '{n} run(s) without a recording',

  // git view, workspace, preview
  '(Issue gelöscht)': '(issue deleted)',
  'Netzwerk-Allowlist ohne Firewall, kein Lauf gestartet': 'Network allowlist without a firewall, no run started',
  'Netzwerk-Allowlist ohne Firewall, kein Lauf gestartet: {error}':
    'Network allowlist without a firewall, no run started: {error}',
  'Der Vorschau-Befehl hat sich beendet, bevor die App antwortete':
    'The preview command exited before the app answered',
  'Die App antwortete nicht innerhalb von {seconds} s': 'The app did not answer within {seconds} s',
  'Der Browser für Playwright fehlt. Einmal `npx {playwright} install chromium` im Projekt ausführen.':
    'The browser for Playwright is missing. Run `npx {playwright} install chromium` once in the project.',
}
