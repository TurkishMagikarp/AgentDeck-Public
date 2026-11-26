// Services around the engine: adapters for the agent CLIs, MCP connections, usage readers,
// import, Mission Control, statistics, mail and push, the morning report, the run replay
// and the public showcase.
export const en_services: Record<string, string> = {
  // starting an agent CLI and reading its output (adapters.ts)
  'Ungültiger Modellname': 'Invalid model name',
  'Unbekannter Provider {provider}': 'Unknown provider {provider}',
  'Für diesen Anbieter ist kein API-Key hinterlegt': 'No API key is stored for this provider',
  'Sandbox: {dir} gehört keinem Projektnutzer': 'Sandbox: {dir} does not belong to a project user',
  '{cmd} konnte nicht gestartet werden: {message}': '{cmd} could not be started: {message}',
  'Exit-Code {code}': 'Exit code {code}',
  '[Bild]': '[image]',
  Fehler: 'Error',
  gestoppt: 'stopped',

  // the mock agent's answers
  'Mock-Jury: Beitrag {pick} erfüllt die Aufgabe am knappsten.':
    'Mock jury: entry {pick} solves the task most concisely.',
  'Passt: geprüft, nur ohne Status-Block (Mock).': 'Approved: checked, only without the status block (mock).',
  'Passt: geprüft (Mock).': 'Approved: checked (mock).',
  'Ändern: Test fehlt (Mock).': 'Changes: the test is missing (mock).',
  'Blockiert: wartet auf {other} (Mock).': 'Blocked: waiting for {other} (mock).',
  'Wartet.': 'Waiting.',
  'Mock-Lauf: Aufgabe simuliert umgesetzt.': 'Mock run: task carried out as a simulation.',
  'Nichts offen. Geändert: keine Dateien (Mock).': 'Nothing open. Changed: no files (mock).',
  'fehlt noch': 'still missing',
  'geprüft (Mock)': 'checked (mock)',
  'Lese Issue…': 'Reading issue…',
  'Schreibe Zusammenfassung…': 'Writing summary…',
  'Vom Mock-Agenten angelegt': 'Created by the mock agent',
  Selbstheilung: 'Self-healing',

  // MCP connections (mcp.ts, managedMcp.ts)
  'Issues, Pull Requests, Code-Suche und Actions': 'Issues, pull requests, code search and Actions',
  'Pixel-Art: Charaktere, Animationen, Tilesets': 'Pixel art: characters, animations, tilesets',
  'Sprachausgabe, Stimmen, Soundeffekte': 'Speech, voices, sound effects',
  'Bilder und Vektorgrafiken erzeugen und bearbeiten': 'Create and edit images and vector graphics',
  '3D-Modelle aus Text und Bildern': '3D models from text and images',
  'Personal Access Token': 'Personal access token',
  'API-Token': 'API token',
  'API-Key': 'API key',
  'Unbekannte Verbindung': 'Unknown connection',
  'MCP {name}: {n} Werkzeuge': 'MCP {name}: {n} tools',
  'MCP {name} nicht erreichbar: {message}': 'MCP {name} not reachable: {message}',

  // Codex usage (codexUsage.ts)
  'codex app-server antwortet nicht': 'codex app-server does not answer',
  'codex app-server Fehler': 'codex app-server error',

  // project import (importer.ts)
  'project.key: 2-8 Zeichen, A-Z/0-9': 'project.key: 2-8 characters, A-Z/0-9',
  'Projekt {key} existiert bereits': 'Project {key} already exists',
  'Agent {name}: unbekannter Anbieter "{provider}"': 'Agent {name}: unknown provider "{provider}"',
  'Agent {name}: ungültiger Modellname': 'Agent {name}: invalid model name',
  'Issue ohne gültige Nummer: {title}': 'Issue without a valid number: {title}',
  Unbekannt: 'Unknown',

  // run replay (runEvents.ts)
  '[GEHEIM: {rule}]': '[SECRET: {rule}]',
  'Token des Laufs': "the run's token",
  'Aufzeichnung gekürzt: Der Lauf hat mehr als {mb} MB erzeugt, weitere Schritte fehlen.':
    'Recording truncated: the run produced more than {mb} MB, further steps are missing.',
  'Keine Änderungen (HEAD {head}).': 'No changes (HEAD {head}).',
  'Dateien seit Laufbeginn (inkl. nicht committeter Änderungen):':
    'Files since the run started (including uncommitted changes):',
  'Neue, nicht versionierte Dateien:': 'New, untracked files:',

  // mail and push (notify.ts, push.ts)
  'Mail ist nicht eingerichtet (Postfach, Empfänger und Key)': 'Mail is not set up (inbox, recipient and key)',
  'AgentMail antwortet mit HTTP {status}': 'AgentMail answers with HTTP {status}',
  '[{project}] {key} wartet auf dich: {title}': '[{project}] {key} is waiting for you: {title}',
  'Mail an den Owner fehlgeschlagen: {message}': 'Mail to the owner failed: {message}',
  'Ungültiges Push-Abo': 'Invalid push subscription',

  // morning report (report.ts)
  'Uhrzeit im Format HH:MM': 'Time in the format HH:MM',
  'Geparkt:': 'Parked:',
  'Geparkt: {issue}': 'Parked: {issue}',
  'Fertig: {issue}': 'Done: {issue}',
  '{n} erledigt': '{n} done',
  '{n} offen': '{n} open',
  '{n} geparkt': '{n} parked',
  '1 Fehllauf': '1 failed run',
  '{n} Fehlläufe': '{n} failed runs',
  '{key} (pausiert)': '{key} (paused)',
  '{provider} pausiert bis {time}': '{provider} paused until {time}',
  'Letzte 24 h: {done} erledigt.': 'Last 24 h: {done} done.',
  'Letzte 24 h: {done} erledigt, {parked} geparkt.': 'Last 24 h: {done} done, {parked} parked.',
  'AgentDeck: Morgenbericht': 'AgentDeck: morning report',
  '[AgentDeck] Morgenbericht: {summary}': '[AgentDeck] Morning report: {summary}',

  // Mission Control: spend guard and kill switch (overview.ts)
  'Limit: Zahl zwischen 0 und 100000': 'Limit: a number between 0 and 100000',
  Ausgabenlimit: 'Spend limit',
  'AgentDeck: Ausgabenlimit erreicht': 'AgentDeck: spend limit reached',
  '{spent} $ in 24 h (Limit {cap} $). {paused} Projekte angehalten.':
    '{spent} $ in 24 h (limit {cap} $). Projects stopped: {paused}.',
  'Not-Aus: Der Eigentümer hat alle Projekte angehalten.': 'Emergency stop: the owner stopped all projects.',
  'Not-Aus: {actor} hat alle Projekte angehalten.': 'Emergency stop: {actor} stopped all projects.',
  'Das Ausgabenlimit ist noch erreicht. Erhöhe es zuerst oder warte, bis die Kosten der letzten 24 Stunden darunter fallen.':
    'The spend limit is still reached. Raise it first or wait until the cost of the last 24 hours falls below it.',

  // statistics (stats.ts)
  '(Standard)': '(default)',

  // public showcase page (showcase.ts)
  'AgentDeck Schaufenster': 'AgentDeck showcase',
  'Ein Team aus KI-Agenten, live.': 'A team of AI agents, live.',
  Agenten: 'Agents',
  'Zuletzt erledigt': 'Recently done',
  'Läuft mit AgentDeck. Aktualisiert sich alle 10 Sekunden.': 'Runs on AgentDeck. Refreshes every 10 seconds.',
  'gerade eben': 'just now',
  'vor {n} min': '{n} min ago',
  'vor {n} h': '{n} h ago',
  'Nicht gefunden': 'Not found',
  'Pausiert.': 'Paused.',
  '{n} von {all} Agenten arbeiten gerade.': '{n} of {all} agents are working right now.',
  'heute erledigt': 'done today',
  'in 7 Tagen': 'in 7 days',
  insgesamt: 'in total',
  offen: 'open',
  'Läufe heute': 'runs today',
  'arbeitet an {issue}': 'working on {issue}',
  wartet: 'waiting',
  'Noch nichts.': 'Nothing yet.',
}
