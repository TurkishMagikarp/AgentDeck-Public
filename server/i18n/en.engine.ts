// The scheduler and what it writes onto issues (engine.ts, recovery.ts, journal.ts, routines.ts,
// issueCap.ts). Texts that code looks for in stored comments are marked: their English must keep
// the beginning the search goes by.
export const en_engine: Record<string, string> = {
  // starting a run
  'Abnahme-Checkliste angelegt (1 Punkt).': 'Acceptance checklist created (1 item).',
  'Abnahme-Checkliste angelegt ({count} Punkte).': 'Acceptance checklist created ({count} items).',
  'Abnahme-Checkliste angelegt (1 Punkt, Vorlage „{template}“).':
    'Acceptance checklist created (1 item, template “{template}”).',
  'Abnahme-Checkliste angelegt ({count} Punkte, Vorlage „{template}“).':
    'Acceptance checklist created ({count} items, template “{template}”).',
  'Routing: {provider} gewählt. Übersprungen: {skipped}.': 'Routing: {provider} chosen. Skipped: {skipped}.',
  'Arbeitsverzeichnis konnte nicht vorbereitet werden: {error}': 'The working directory could not be prepared: {error}',
  gestoppt: 'stopped',

  // the end of a run, as the replay shows it
  'Lauf abgeschlossen': 'Run finished',
  'Lauf fehlgeschlagen': 'Run failed',
  'Lauf gestoppt': 'Run stopped',
  'Lauf {status}': 'Run {status}',
  'Tokens: {input} rein (davon {cached} aus dem Cache), {output} raus':
    'Tokens: {input} in ({cached} of them from the cache), {output} out',
  'Änderungen nicht lesbar: {error}': 'Changes could not be read: {error}',
  'Issue gelöscht': 'Issue deleted',

  // cost cap
  'Kosten-Deckel erreicht: {reason}. Das Issue ist geparkt. Mit „Weitere Runde freigeben“ oder durch Zurückschieben auf To Do darf es noch einmal so viel verbrauchen.':
    'Cost cap reached: {reason}. The issue is parked. With “Allow another round” or by moving it back to To Do it may use the same amount once more.',
  '${spent} von ${limit} verbraucht': '${spent} of ${limit} used',
  '{spent} von {limit} Tokens verbraucht': '{spent} of {limit} tokens used',

  // stuck issues: deputy, parking (markers: "Geparkt:", "Geparkt", "zur Entscheidung", "Wartet auf Mensch")
  'An {name} zur Entscheidung: {reason}\n\nLies, warum es hängt, und entscheide, wie es weitergeht.':
    'To {name} for a decision: {reason}\n\nRead why it is stuck and decide how it goes on.',
  'zur Entscheidung': 'for a decision',
  'Zur Prüfung an {name}.': 'To {name} for review.',
  'Kein weiterer Prüfer vorhanden, die Arbeit gilt als abgenommen.':
    'There is no other reviewer, the work counts as accepted.',
  'Geparkt:': 'Parked:',
  Geparkt: 'Parked',
  'Das Issue liegt im Backlog und hält nichts auf. Es kommt frühestens {when} wieder dran, sobald die offene Arbeit erledigt ist. Zurück auf To Do geschoben, startet es sofort.':
    'The issue is in the backlog and holds nothing up. It comes up again at {when} at the earliest, once the open work is done. Moved back to To Do, it starts at once.',
  'Wartete auf eine Prüfung durch einen Menschen.': 'Was waiting for a review by a human.',
  'Stand auf „Wartet auf Mensch“.': 'Was set to “Waiting for human”.',
  'Wartet auf Mensch': 'Waiting for human',

  // dependency rings
  'Ring-Abhängigkeit auflösen: {ring}': 'Resolve circular dependency: {ring}',
  'Diese Issues warten im Kreis aufeinander und starten deshalb nie (A → B heißt: A wartet auf B):':
    'These issues wait on each other in a circle and therefore never start (A → B means: A waits for B):',
  'Lies die Issues und entferne die Abhängigkeit, die am wenigsten Sinn ergibt, mit `node "$AGENTDECK_CLI" unblock <number> <blocker>`. Schließe dieses Issue dann mit `done`. Bleibt der Kreis bestehen, löst AgentDeck ihn danach selbst auf.':
    'Read the issues and remove the dependency that makes the least sense with `node "$AGENTDECK_CLI" unblock <number> <blocker>`. Then close this issue with `done`. If the circle remains, AgentDeck breaks it up itself afterwards.',
  'Steckt in einer Ring-Abhängigkeit ({ring}). {name} entscheidet in {issue}.':
    'Is part of a circular dependency ({ring}). {name} decides in {issue}.',
  'Ring-Abhängigkeit aufgelöst ({ring}): {waiter} wartet nicht mehr auf {blocker}.':
    'Circular dependency resolved ({ring}): {waiter} no longer waits for {blocker}.',
  'Prüf, ob dadurch etwas fehlt, und lege dafür bei Bedarf ein neues Issue an.':
    'Check whether something is missing because of that and create a new issue for it if needed.',

  // blockers in the backlog
  '{blocker} ließ sich nicht erledigen und hält dieses Issue nicht mehr auf. Prüf, ob ohne es etwas fehlt, und lege dafür bei Bedarf ein neues Issue an.':
    '{blocker} could not be finished and no longer holds up this issue. Check whether something is missing without it and create a new issue for it if needed.',
  'Hält nicht mehr auf: {issues}. Die warten nicht länger auf dieses Issue.':
    'No longer holds up: {issues}. They do not wait for this issue any more.',
  'Lag im Backlog, aber {count} Issues warten darauf ({issues}). Zurück in die Warteschlange. Versuch {attempt} von {max}.':
    'Was in the backlog, but other issues wait for it ({issues}; {count} in total). Back in the queue. Attempt {attempt} of {max}.',
  'Lag im Backlog, aber {count} Issues warten darauf ({issues}). Zurück in die Warteschlange, {name} entscheidet. Versuch {attempt} von {max}.':
    'Was in the backlog, but other issues wait for it ({issues}; {count} in total). Back in the queue, {name} decides. Attempt {attempt} of {max}.',

  // landing and its approval
  'Die Landung ist mehrfach gescheitert. Bitte entscheiden, wie es weitergeht.':
    'The landing failed several times. Please decide how it goes on.',
  'nicht gefunden': 'not found',
  'Das Issue wartet auf keine Freigabe.': 'The issue is not waiting for an approval.',
  'Der Branch hat sich seit dem Anhalten bewegt. Bitte neu laden und den neuen Stand prüfen.':
    'The branch has moved since it was held. Please reload and check the new state.',
  'Landung von Stand {sha} freigegeben.': 'Landing of commit {sha} approved.',
  '{actor} hat Stand {sha} freigegeben (gilt einmal, nur für diesen Commit).':
    '{actor} approved commit {sha} (valid once, for this commit only).',

  // failed runs and self-healing
  'unbekannter Fehler': 'unknown error',
  'Lauf von {name} fehlgeschlagen: {cause}': 'Run of {name} failed: {cause}',
  '{streak} Läufe in Folge ohne Ergebnis. Issue blockiert, bitte prüfen.':
    '{streak} runs in a row without a result. Issue blocked, please check.',
  'Mehrere Läufe sind ohne Ergebnis geblieben.': 'Several runs ended without a result.',
  'Dieses Issue ist zu groß: Läufen ging die Zeit aus, oder es hat mehr Tokens verbraucht, als ein Issue soll. Teile den Rest in kleinere Issues auf, statt es unverändert zurückzugeben.':
    'This issue is too big: runs ran out of time, or it used more tokens than one issue should. Split what is left into smaller issues instead of handing it back unchanged.',
  'Zweimal derselbe Fehler auf {provider}. Der nächste Lauf nimmt einen anderen Anbieter, falls einer eingerichtet ist.':
    'The same error twice on {provider}. The next run uses another provider, if one is set up.',
  '`{missing}` war in einem Lauf nicht installiert. Vor Gebrauch prüfen und bei Bedarf installieren.':
    '`{missing}` was not installed in a run. Check before use and install it if needed.',
  '{provider} hat sein Limit erreicht ({cause}). Der Anbieter pausiert bis {until}, solange übernimmt ein Ersatzanbieter, falls einer eingerichtet ist. Zählt nicht als Fehlversuch.':
    '{provider} has reached its limit ({cause}). The provider rests until {until}; a fallback provider takes over until then, if one is set up. Does not count as a failed attempt.',
  '{provider} ist nicht erreichbar oder nicht angemeldet ({cause}). Der Anbieter pausiert bis {until}. Zählt nicht als Fehlversuch.':
    '{provider} cannot be reached or is not signed in ({cause}). The provider rests until {until}. Does not count as a failed attempt.',
  'Netzwerkfehler ({cause}). Neuer Versuch in einer Minute.': 'Network error ({cause}). Next attempt in one minute.',
  'Der letzte Lauf scheiterte, weil `{missing}` fehlt. Installiere es zuerst (z. B. `sudo apt-get install -y …`, `uv pip install …` oder `npm install …`), prüfe, dass es läuft, und arbeite dann weiter. Notiere den Befehl in der Übergabe, damit die nächsten Agenten ihn kennen.':
    'The last run failed because `{missing}` is missing. Install it first (for example `sudo apt-get install -y …`, `uv pip install …` or `npm install …`), check that it runs, and then go on. Note the command in the handover, so the next agents know it.',
  'Der letzte Lauf hat das Kontextfenster gesprengt. Lies große Dateien und Logs nur ausschnittsweise (head, tail, grep) und arbeite in kleineren Schritten. Ist das Issue zu groß, teile es mit den Board-Befehlen in kleinere Issues auf und schließe dieses mit `done`.':
    'The last run overflowed the context window. Read large files and logs only in parts (head, tail, grep) and work in smaller steps. If the issue is too big, split it into smaller issues with the board commands and close this one with `done`.',
  'Limit erreicht': 'limit reached',
  'Zugang fehlt': 'no access',

  // checklist and precheck before a review (markers: "Teilabgabe", "Vorcheck bestanden")
  'Deine Abgabe enthält keinen <checklist>-Block. Melde zu jedem Punkt der Abnahme-Checkliste "ok" mit Nachweis oder "open" und gib erneut ab.':
    'Your handoff has no <checklist> block. Report "ok" with proof or "open" for every item of the acceptance checklist and hand in again.',
  Teilabgabe: 'Partial handoff',
  'Teilabgabe, offen: Punkt {items}.': 'Partial handoff, open: item {items}.',
  'Vorcheck läuft: Nachweise, Merge, Projektprüfung…': 'Precheck running: proofs, merge, project check…',
  'Vorcheck nicht möglich, die Prüfer sehen die Arbeit trotzdem: {error}':
    'Precheck not possible, the reviewers see the work anyway: {error}',
  'Vorcheck bestanden': 'Precheck passed',
  '{name} scheitert {fails}-mal in Folge am Vorcheck. Zuletzt: {note}':
    '{name} failed the precheck {fails} times in a row. Last: {note}',
  '{name} hat {streak} Teilabgaben in Folge geliefert, ohne die Checkliste abzuschließen. {note}':
    '{name} delivered {streak} partial handoffs in a row without completing the checklist. {note}',
  '{name} hat erneut teilweise abgegeben, ohne einen weiteren Punkt zu erfüllen, und nennt kein offenes Issue, auf das es wartet. {note}':
    '{name} handed in a part again without meeting another item, and names no open issue it waits for. {note}',
  'Weiter mit den offenen Punkten, ohne Zwischenprüfung.': 'Go on with the open items, without an interim review.',
  'Weiter mit den offenen Punkten.': 'Go on with the open items.',
  'Zwischenprüfung durch {name}.': 'Interim review by {name}.',

  // finished work (marker: "Wartet jetzt auf {issues} und geht")
  '(keine Zusammenfassung)': '(no summary)',
  'Übergabe von {from} an {to}.': 'Handover from {from} to {to}.',
  'Wartet jetzt auf {issues} und geht von selbst weiter, sobald das erledigt ist.':
    'Now waits for {issues} and goes on by itself once that is done.',
  'Wartet jetzt auf {issues} und geht': 'Now waits for {issues} and goes on',
  '{issues} und {count} weitere': '{issues} and {count} more',
  '{name} kommt nicht weiter: {summary}': '{name} is stuck: {summary}',
  '{name} ist fertig und bittet um deine Prüfung: {summary}': '{name} is done and asks for your review: {summary}',
  'Vorschau wird aufgenommen…': 'Taking the preview…',
  'Vorschau aufgenommen ({count} Screenshots).': 'Preview taken ({count} screenshots).',
  'Vorschau nicht möglich: {error}': 'Preview not possible: {error}',
  'Watchdog prüft das Ergebnis…': 'The watchdog checks the result…',
  'Prüfung nicht möglich: {error}': 'Check not possible: {error}',

  // reviews (marker: "{name} hat freigegeben.")
  '(keine Begründung)': '(no reason given)',
  '{name} hat freigegeben.': '{name} approved.',
  '{name} hat freigegeben. Weiter an {next}.': '{name} approved. Next: {next}.',
  '{name} hat den Zwischenstand freigegeben. Weiter mit den offenen Punkten.':
    '{name} approved the interim state. Go on with the open items.',
  '{rounds} Änderungsrunden ohne Freigabe. Bitte entscheiden, wie es weitergeht.':
    '{rounds} change rounds without an approval. Please decide how it goes on.',
  '{rounds} Änderungsrunden ohne Freigabe. Letzter Einwand: {summary}':
    '{rounds} change rounds without an approval. Last objection: {summary}',
  '{name} braucht deine Entscheidung: {summary}': '{name} needs your decision: {summary}',

  // arena
  'Erledigt durch den Gewinner-Beitrag #{number}.': 'Done by the winning entry #{number}.',
  'Als einziger Beitrag abgegeben.': 'The only entry that was handed in.',
  'Die Arena': 'The arena',
  'Die Jury': 'The jury',
  'kein Anbieter für die Jury': 'no provider for the jury',
  'Antwort nicht lesbar': 'answer not readable',
  'Die Jury kam zu keiner Entscheidung ({error}). Neuer Versuch in fünf Minuten.':
    'The jury reached no decision ({error}). Next attempt in five minutes.',
  'Die Jury war nicht erreichbar; der erste abgegebene Beitrag wurde genommen.':
    'The jury could not be reached; the first entry handed in was taken.',
  'Die Jury konnte die Arena nicht entscheiden. Bitte im Issue einen Beitrag wählen.':
    'The jury could not decide the arena. Please choose an entry in the issue.',
  'Für dieses Issue gibt es keine Arena.': 'There is no arena for this issue.',
  'Die Arena ist entschieden, der Lauf wurde gestoppt.': 'The arena is decided, the run was stopped.',

  // why an issue waits (board)
  'Wartet auf Merge von {issues}': 'Waits for the merge of {issues}',
  'Wartet auf {issues}': 'Waits for {issues}',
  'Neuer Versuch ab {when}, der letzte Lauf ist fehlgeschlagen': 'Next attempt from {when}, the last run failed',
  'Der zugewiesene Agent existiert nicht mehr': 'The assigned agent no longer exists',
  'Kein Agent frei': 'No agent free',
  '{name} ist ausgeschaltet': '{name} is switched off',
  '{name} arbeitet schon an {busy} von höchstens {max} Issues':
    '{name} already works on {busy} of at most {max} issues',
  'Projekt-Limit erreicht: {max} Läufe gleichzeitig': 'Project limit reached: {max} runs at the same time',
  'Kein Anbieter verfügbar. {skipped}': 'No provider available. {skipped}',
  'Freigegeben, Landung läuft (Merge und Test, seit {minutes} min)':
    'Approved, landing in progress (merge and test, for {minutes} min)',
  'Freigegeben, wartet auf Landung: Platz {place} in der Schlange':
    'Approved, waiting to land: place {place} in line',
  '{provider}: {reason} bis {when}': '{provider}: {reason} until {when}',
  'Agenten pausieren. {providers}.': 'Agents are paused. {providers}.',
  'Usage-Limit erreicht: kein Provider liegt über seiner Schwelle. Agenten pausieren.':
    'Usage limit reached: no provider is above its threshold. Agents are paused.',

  // watchdog
  'Keine Aktivität seit {minutes} Minuten.': 'No activity for {minutes} minutes.',
  'Lauf dauert länger als {minutes} Minuten.': 'The run takes longer than {minutes} minutes.',
  'Lauf gestoppt.': 'Run stopped.',

  // journal
  '{author} verlangt Änderungen: {reason}': '{author} asks for changes: {reason}',
  'Vorcheck rot: {failure}': 'Precheck red: {failure}',
  'Gelandet in {base} ({commit})': 'Landed in {base} ({commit})',
  'Landung rot: {failure}': 'Landing red: {failure}',
  'Landung rot, zurück an den Maker': 'Landing red, back to the maker',
  'Freigegeben von {name}': 'Approved by {name}',
  'Lauf von {agent} fehlgeschlagen ({failure})': 'Run of {agent} failed ({failure})',

  // routines
  Routinen: 'Routines',
  'Name fehlt': 'Name is missing',
  'Uhrzeit im Format HH:MM angeben': 'Enter the time as HH:MM',
}
