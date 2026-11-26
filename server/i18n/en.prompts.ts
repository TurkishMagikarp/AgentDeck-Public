// English for the short texts around prompts, checklists, templates, blueprints, the arena and the
// agents with a loop of our own. The long prompt texts live in server/prompts.
export const en_prompts: Record<string, string> = {
  // checklist.ts, lessons.ts, templates.ts
  'Jeder Teil von „Done when“ in der Beschreibung ist erfüllt und einzeln belegt':
    'Every part of "Done when" in the description is met and proven one by one',
  'Notiz leer': 'Empty note',
  'Unbekannte Vorlage': 'Unknown template',

  // blueprint.ts
  'blueprint.project fehlt': 'blueprint.project is missing',
  'project.key: 2-8 Zeichen, A-Z/0-9, beginnt mit Buchstabe':
    'project.key: 2-8 characters, A-Z/0-9, starts with a letter',
  'Agent {name}: unbekannter Provider "{provider}"': 'Agent {name}: unknown provider "{provider}"',
  'Agent {name}: ungültiger Modellname': 'Agent {name}: invalid model name',
  'Die KI hat kein JSON geliefert': 'The AI returned no JSON',

  // arena.ts
  entfernt: 'removed',
  'Issue nicht gefunden': 'Issue not found',
  'Ein Arena-Beitrag kann keine eigene Arena bekommen.': 'An arena entry cannot get an arena of its own.',
  'Für dieses Issue läuft schon eine Arena.': 'An arena is already running for this issue.',
  'Eine Arena startet nur aus Backlog oder To Do, bevor jemand am Issue arbeitet.':
    'An arena only starts from Backlog or To Do, before anyone works on the issue.',
  'Unbekannter oder abgeschalteter Agent in der Auswahl.': 'Unknown or disabled agent in the selection.',
  'Eine Arena braucht {min} bis {max} verschiedene Agenten.':
    'An arena needs {min} to {max} different agents.',
  'Arena gestartet: {entries} arbeiten parallel an dieser Aufgabe. Die Jury wählt den besten Beitrag, nur der geht in Prüfung und Landung.':
    'Arena started: {entries} work on this task in parallel. The jury picks the best entry, and only that one goes on to review and landing.',
  'Beitrag abgegeben. Er wartet auf die Entscheidung der Jury.':
    'Entry handed in. It waits for the decision of the jury.',
  'Beitrag gehört nicht zu dieser Arena.': 'The entry does not belong to this arena.',
  'Die Arena ist schon entschieden.': 'The arena is already decided.',
  'Dieser Beitrag wurde nicht abgegeben.': 'This entry was not handed in.',
  'Begründung: {reason}': 'Reason: {reason}',
  '{by} hat entschieden: Beitrag #{number} gewinnt.': '{by} decided: entry #{number} wins.',
  'Dieser Beitrag hat die Arena gewonnen ({by}).': 'This entry won the arena ({by}).',
  'Die Arena ging an Beitrag #{number}. Dieser Beitrag wird nicht gelandet; sein Branch bleibt vorerst zum Vergleich.':
    'The arena went to entry #{number}. This entry will not be landed; its branch stays for comparison for now.',
  'Die Arena wurde ohne Ergebnis beendet; dieser Beitrag ist geschlossen.':
    'The arena ended without a result; this entry is closed.',
  'Arena ohne Ergebnis: Kein Beitrag wurde abgegeben. Das Issue geht wieder seinen normalen Weg.':
    'Arena without a result: no entry was handed in. The issue goes its normal way again.',

  // apiAgent.ts
  'API antwortet mit HTTP {status}': 'The API answered with HTTP {status}',
  'Die API hat keine Antwort geliefert': 'The API returned no answer',
  'Nach {steps} Schritten nicht fertig geworden': 'Not finished after {steps} steps',

  // managedAgent.ts
  'Das Limit pro Lauf muss zwischen 0 und 1000 USD liegen':
    'The limit per run must be between 0 and 1000 USD',
  'Für Claude Managed Agents ist kein API-Key hinterlegt': 'No API key is stored for Claude Managed Agents',
  'Für Claude Managed Agents fehlt der Environment-Key (in der Claude Console beim Environment erzeugen)':
    'The environment key for Claude Managed Agents is missing (create it in the Claude Console at the environment)',
  'Claude Managed Agents sind in der Sandbox gesperrt: ihre Werkzeuge liefen mit den Rechten des Servers. Stell den Agenten auf einen anderen Anbieter um.':
    "Claude Managed Agents are off in the sandbox: their tools would run with the server's rights. Switch the agent to another provider.",
  'Claude Managed Agents laufen nur auf dem Linux-Server (die Werkzeuge brauchen /bin/bash)':
    'Claude Managed Agents only run on the Linux server (the tools need /bin/bash)',
  'AgentDeck-Lauf': 'AgentDeck run',
  Fehler: 'Error',
  'Fehler: {message}': 'Error: {message}',
  'Limit pro Lauf ({limit} USD) erreicht, der Lauf wurde angehalten':
    'Limit per run ({limit} USD) reached, the run was stopped',
  'Claude hat die Aufgabe abgelehnt': 'Claude refused the task',
  'Session angehalten ({reason})': 'Session stopped ({reason})',
  unbekannt: 'unknown',
  'Verbindung zur Session unterbrochen, verbinde neu…': 'Connection to the session lost, reconnecting…',
  'Keine Antwort': 'No answer',
  gestoppt: 'stopped',
}
