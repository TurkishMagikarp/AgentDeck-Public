---
name: agentdeck
description: Legt aus einer Beschreibung in normaler Sprache ein Projekt in AgentDeck (dem Agenten-Board des Nutzers) an oder erweitert es. Nimm diesen Skill, wenn der Nutzer ein Projekt "in AgentDeck" bauen, planen oder besetzen will, wenn er Agenten, Skills oder Issues zu einem AgentDeck-Projekt hinzufügen will oder wissen möchte, woran die Agenten dort arbeiten.
---

# AgentDeck

AgentDeck lässt Teams von Coding-Agenten auf einem gemeinsamen Board im Stil von Jira arbeiten. Ein Projekt
hat Agenten, Skills und Issues. Agenten nehmen sich Issues im Status `todo` selbst, kommentieren im Issue
und übergeben einander die Arbeit.

Du richtest ein Projekt ein, indem du einen **Blueprint** als JSON schreibst und anwendest. Ein Aufruf legt
alles an.

## Verbindung

Das Skript neben dieser Datei spricht mit der API. Es liest drei Umgebungsvariablen:

- `AGENTDECK_URL` (Standard `http://localhost:8790`)
- `AGENTDECK_TOKEN` (nur, wenn der Server einen verlangt)
- `AGENTDECK_LANG` (`de` oder `en`, Standard `en`): die Sprache der Ausgaben und der Antworten des Servers

Scheitert ein Aufruf mit `unauthorized` oder einem Verbindungsfehler, frag den Nutzer nach URL oder Token.
Rate nicht.

## Ablauf

1. Lies das aktuelle Blueprint-Format und die verfügbaren Anbieter. Tu das immer zuerst, denn das Format
   kommt von der laufenden AgentDeck-Version:

   ```
   node <skill-dir>/agentdeck.mjs guide
   ```

2. Sieh nach, was es schon gibt, damit du erweiterst und nichts doppelt anlegst:

   ```
   node <skill-dir>/agentdeck.mjs projects
   node <skill-dir>/agentdeck.mjs board <KEY>
   ```

3. Entwirf das Projekt aus der Beschreibung des Nutzers:
   - Zerlege das Ziel in kleine Issues, die ein Agent in einem einzigen Lauf erledigen und prüfen kann.
     Jedes braucht Abnahmekriterien in der Beschreibung.
   - Lege die Reihenfolge mit `blocked_by` fest, nicht mit Sätzen wie "mach das nach X".
   - Halte das Team klein: meist ein Planer, ein oder zwei Umsetzer, ein Prüfer. Erhöhe `max_instances`
     nur bei Agenten, deren Issues voneinander unabhängig sind.
   - Gemeinsame Regeln (Stack, Tests, Commit-Stil) gehören in einen Skill, den mehrere Agenten nennen.
   - Nimm nur Anbieter, die der Nutzer genannt hat oder die `guide` aufführt. Hat der Nutzer Grenzen
     genannt ("OpenAI bei 10 % Rest stoppen", "auf Deepseek ausweichen"), trag sie in
     `project.settings.budgets` und `fallback` ein.
   - Soll das Team auf Deutsch arbeiten, setze `project.settings.language` auf `de`, sonst auf `en`.
   - Issues, die eine menschliche Entscheidung brauchen, bleiben im `backlog`. Alles in `todo` startet
     sofort.

4. Hat der Nutzer nicht verlangt, dass du es einfach machst, zeig eine kurze Zusammenfassung (Agenten,
   Zahl der Issues, was sofort startet) und hol dir das Einverständnis. Ein Blueprint mit Issues in `todo`
   startet Agenten und verbraucht Kontingent.

5. Schreib den Blueprint in eine Datei und wende ihn an:

   ```
   node <skill-dir>/agentdeck.mjs apply blueprint.json
   ```

   Ein Blueprint, dessen `project.key` es schon gibt, erweitert dieses Projekt: Agenten und Skills werden
   über den Namen gefunden und aktualisiert, Issues kommen immer hinzu.

6. Berichte, was angelegt wurde, und nenne die Adresse des Boards, die das Skript ausgibt.
