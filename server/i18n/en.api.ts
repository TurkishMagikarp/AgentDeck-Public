// HTTP routes, logins, users, the agents' board API, the sandbox and the egress proxy
// (main.ts, auth.ts, users.ts, roles.ts, agentApi.ts, core.ts, sandbox.ts, egress.ts, audit.ts).
export const en_api: Record<string, string> = {
  // connections on demand
  keine: 'none',
  'Keine Verbindung "{id}" für diesen Agenten. Möglich: {possible}':
    'No connection "{id}" for this agent. Possible: {possible}',
  'Braucht die MCP-Werkzeuge von {name}.': 'Needs the MCP tools of {name}.',

  // login, roles, confirming a change
  'Zu viele Fehlversuche. Bitte in {wait} s erneut versuchen.': 'Too many failed attempts. Please try again in {wait} s.',
  'Token stimmt nicht': 'Wrong token',
  'Das Token stimmt nicht.': 'The token is wrong.',
  'Fremde Herkunft': 'Request from another site',
  'Dafür fehlt die Berechtigung ({needs} nötig, du hast {has}).':
    'You do not have permission for this ({needs} needed, you have {has}).',
  Lesen: 'View',
  Bedienen: 'Operate',
  Verwalten: 'Manage',
  'Befehle lassen sich hinter dem Proxy nur ändern, wenn auf dem Server auch AGENTDECK_TOKEN gesetzt ist.':
    'Behind the proxy, commands can only be changed when AGENTDECK_TOKEN is set on the server as well.',
  'Diese Änderung betrifft Befehle, die der Server ausführt. Bitte mit dem Zugangs-Token bestätigen.':
    'This change affects commands the server runs. Please confirm with the access token.',

  // requests in general
  'nicht gefunden': 'not found',
  'ungültige id': 'invalid id',
  'JSON erwartet': 'JSON expected',
  'Anfrage zu groß (max. 1 MB)': 'Request too large (max. 1 MB)',

  // users
  'Name: 1–60 Zeichen, Buchstaben, Ziffern, Leerzeichen, . _ @ -':
    'Name: 1–60 characters, letters, digits, spaces, . _ @ -',
  'Unbekannte Rolle': 'Unknown role',
  'Dieser Name ist für das System reserviert': 'This name is reserved for the system',
  'Diesen Namen gibt es schon': 'This name already exists',

  // mission control, projects
  'action: stop oder resume': 'action: stop or resume',
  'Projekt-Key existiert bereits': 'Project key already exists',
  'Projekt nicht gefunden': 'Project not found',
  'Projekt gelöscht': 'Project deleted',

  // agents and skills
  'unbekannte Effort-Stufe': 'unknown effort level',
  'unbekannter Provider': 'unknown provider',
  'ungültiger Modellname': 'invalid model name',
  'ungültiger Anbieter-Override': 'invalid provider override',
  'Name fehlt': 'Name is missing',
  'Unbekannter Anbieter': 'Unknown provider',
  'unbekannter Anbieter': 'unknown provider',
  'Agent gelöscht': 'Agent deleted',

  // issues
  'Titel fehlt': 'Title is missing',
  'Weitere Runde des Kosten-Deckels freigegeben.': 'Another round of the cost cap approved.',
  'ungültiger Stand': 'invalid commit',
  'ungültige Datei': 'invalid file',
  'unbekannter Status': 'unknown status',
  'Nur wer verwaltet, darf das Kostenlimit erhöhen.': 'Only someone who manages may raise the cost cap.',
  'Lauf gestoppt, Issue wurde manuell geändert.': 'Run stopped, the issue was changed by hand.',
  'Lauf manuell gestoppt.': 'Run stopped by hand.',
  'Issue gelöscht': 'Issue deleted',
  'Kommentar leer': 'Comment is empty',
  Du: 'You',

  // live feed
  blockiert: 'blocked',
  'Zugriff auf {target} verweigert': 'Access to {target} refused',
  Netzwerk: 'Network',

  // webhooks, replay, statistics
  'Webhook nicht gefunden': 'Webhook not found',
  'Höchstens 10 Webhooks pro Projekt': 'At most 10 webhooks per project',
  'unbekannte Art': 'unknown kind',
  'Zeitraum: from und to als JJJJ-MM-TT angeben': 'Range: give from and to as YYYY-MM-DD',
  'Zeitraum: das Ende liegt vor dem Anfang': 'Range: the end is before the start',
  'Zeitraum: höchstens {days} Tage': 'Range: at most {days} days',

  // push, mail, blueprints
  'Push funktioniert auf diesem Gerät.': 'Push works on this device.',
  '[AgentDeck] Testmail': '[AgentDeck] Test mail',
  'Wenn du das liest, kann AgentDeck dir Mails schicken.': 'If you can read this, AgentDeck can send you mail.',
  'Beschreibung fehlt': 'Description is missing',
  'KI-Aufruf fehlgeschlagen: {error}': 'AI call failed: {error}',

  // audit log
  geändert: 'changed',
  'apiKey entfernt': 'apiKey removed',

  // provider access and logins
  'Diese Zugangsart gibt es für den Anbieter nicht': 'This provider does not offer that kind of access',
  'Codex hat den API-Key nicht angenommen': 'Codex did not accept the API key',
  'Für diesen Anbieter ist kein API-Key hinterlegt': 'No API key is stored for this provider',
  '{cli} ist nicht installiert': '{cli} is not installed',
  'über hinterlegtes Abo-Token': 'with the stored subscription token',
  'über {method}': 'with {method}',
  '{n} Zugänge hinterlegt': '{n} credentials stored',
  'Für diesen Anbieter gibt es keinen Login über das Tool': 'This provider has no login through the tool',
  'Kein laufender Login': 'No login in progress',
  'Der Code sieht nicht richtig aus': 'The code does not look right',

  // routing: why a provider was skipped
  'in dieser Umgebung deaktiviert': 'switched off in this environment',
  'nicht eingerichtet': 'not set up',
  '{reason} bis {time}': '{reason} until {time}',
  '{left} % übrig, Stopp bei {stop} %': '{left}% left, stop at {stop}%',
  'Modelllimit erreicht ({model})': 'Model limit reached ({model})',
  'erneuter Lauf nach wiederholtem Fehler zurückgestellt': 'another run put off after repeated failures',

  // watchdog default
  'Prüfe, ob die Aufgabe vollständig umgesetzt wurde, ob Tests ausgeführt wurden und ob nichts außerhalb des Auftrags geändert wurde.':
    'Check whether the task was done completely, whether tests were run and whether nothing outside the task was changed.',

  // board API for agents
  'Dieses Lauf-Token ist nicht (mehr) gültig': 'This run token is not valid (any more)',
  'Kein Agent namens "{name}" in diesem Projekt': 'No agent named "{name}" in this project',
  'Issue nicht gefunden': 'Issue not found',
  'Issue {number} wartet nicht auf {blocker}': 'Issue {number} does not wait for {blocker}',
  'Wartet nicht mehr auf {issue}.': 'No longer waits for {issue}.',
  'Systempakete installiert: {names}': 'System packages installed: {names}',
  'Die Beschreibung braucht die Abschnitte {sections}. Schreib das Issue so, dass ein Junior es ohne Rückfrage erledigen kann (Format: siehe "How to write an issue" in deinem Prompt), und leg es erneut an.':
    'The description needs the sections {sections}. Write the issue so that a junior can do it without asking back (format: see "How to write an issue" in your prompt), and file it again.',
  'Ähnliches offenes Issue vorhanden: {list}. Kommentiere dort, statt ein neues anzulegen. Nur wenn deins wirklich etwas anderes ist: --force yes.':
    'A similar open issue exists: {list}. Comment there instead of filing a new one. Only if yours really is something else: --force yes.',
  'Angelegt von {agent} während {issue}.': 'Filed by {agent} during {issue}.',

  // sandbox
  'Sandbox: {dir} gehört keinem Projektnutzer, der Lauf startet nicht':
    'Sandbox: {dir} belongs to no project user, the run does not start',
  'Sandbox für {key}: {error}': 'Sandbox for {key}: {error}',
  'Pakete installiert AgentDeck nur im Container': 'AgentDeck installs packages only in the container',
  'Ungültiger Paketname': 'Invalid package name',
  'kein Projektnutzer': 'no project user',
  '{file} liegt nicht im Projekt-Home': '{file} is not inside the project home',

  // egress proxy
  'Kopfzeilen zu groß': 'headers too large',
  'keine HTTP-Anfrage': 'not an HTTP request',
  'der Proxy gilt nur für Projekte mit Allowlist': 'the proxy only serves projects with an allowlist',
  'ungültiges Ziel': 'invalid target',
  'nur http:// oder CONNECT': 'only http:// or CONNECT',
  '{target} steht nicht auf der Allowlist des Projekts': "{target} is not on the project's allowlist",
  '{target} zeigt auf eine interne Adresse': '{target} points to an internal address',
  '{target} nicht auflösbar': '{target} cannot be resolved',
  '{target} nicht erreichbar': '{target} cannot be reached',
}
