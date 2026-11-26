# AgentDeck: Pull Requests über Forgejo

English: [forgejo-landing.md](forgejo-landing.md)

Code und Pull Requests liegen in Forgejo. Die CI kann woanders laufen: In dem Aufbau, für den
dieser Text entstand, enthält ein eigenes Repository nur die Workflow-Definitionen, seine Runner
holen genau einen Forgejo-Commit über ein SSH-Gateway mit Lesezugriff, und ein Timer auf dem Host
stößt die Builds an und veröffentlicht die verlangten Kontexte als Commit-Status.

AgentDeck arbeitet in der Vorgabe wie bisher mit GitHub. Wer umstellen will, bindet
`/run/agentdeck-forgejo/projects.json` und die Forgejo-Token der Projekte nur lesbar ein: lesbar für
den Server, nicht für die Projektnutzer. Secrets gehören nicht in Umgebungsvariablen der
Compose-Datei, nicht in eingecheckte Dateien, nicht in Projekteinstellungen, nicht in die Git-URL
und nicht in Anweisungen an Agenten. Beispiel **ohne** Secrets:

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

Forgejo-API und SSH bleiben in einem privaten Docker-Netz, das Forgejo mit AgentDeck teilt. Vor der
öffentlichen Forgejo-Seite steht weiterhin Authelia. Das API-Token des AgentDeck-Servers gehört
einem Konto ohne Adminrechte, dessen Zugriff auf dieses eine Repository begrenzt ist. Git läuft als
`ad-shop`; der SSH-Hostschlüssel von Forgejo wird im Home dieses Projektnutzers fest hinterlegt, und
der Nutzer bekommt einen eigenen SSH-Zugang nur für dieses Repository. Nie den Administratorschlüssel
des Hosts oder den lesenden GitHub-CI-Schlüssel wiederverwenden.

## Umstellung

1. Prüfen, dass die CI-Ausgangslage in Forgejo grün ist und alle vier Kontexte zum selben Commit
   gehören. `main` auf GitHub und in Forgejo vergleichen, dazu die Nummern, Heads und Basis-Branches
   der offenen PRs. Auseinandergelaufene Arbeit nicht mit Force-Push überschreiben. Das alte
   `origin` für den Rückweg aufbewahren.
2. Das Projekt pausieren und laufende Jobs zu Ende laufen lassen. `main` in Forgejo gegen direkte
   Pushes schützen und die vier Kontexte verlangen. Die API-Lesezugriffe des Dienstkontos und den
   Git-Zugriff des Projektnutzers testen, bevor `origin` geändert wird. Private Quellen und Token
   gehören nicht in Deployment-Pakete.
3. Den AgentDeck-Build mit dem privaten Mount und dem Netz ausrollen. Nur das `origin` des
   Zielprojekts ändern, eine Push-URL eingeschlossen; dessen alte Einstellung für die
   GitHub-Token-Datei leeren. Git-Befehle auf `/repos/shop` laufen als `ad-shop`, nicht als root.
   Die Remotes anderer Projekte bleiben unverändert.
4. Übernommene wartende PRs ohne gespeicherte `pr_sha` werden zur Prüfung angehalten. Eine fehlende
   Freigabe nie mit der SHA füllen, die gerade auf dem Remote liegt. Neu prüfen und über AgentDeck
   neu einreichen. Ein PR muss zum eingestellten Repository, zum erwarteten Branch und zur Basis,
   zum exakt freigegebenen Commit und zu allen vier Check-Kontexten passen, bevor AgentDeck diese
   SHA mergt.
5. Ein echtes Issue durch PR und Statusbehandlung laufen lassen, bevor die alte Standard-CI auf
   GitHub abgeschaltet wird. Das alte Repository bleibt privat und verfügbar, bis der Besitzer
   bestätigt, dass es gelöscht werden kann. Der alte Windows-Zeitplan liegt schon im zentralen
   CI-Repository und ist keine Bedingung für den Merge.

## Rückweg

Das Projekt pausieren. Hat Forgejo neue Commits oder PR-Änderungen angenommen, diese erst
abgleichen, bevor irgendetwas umgehängt wird. Das ursprüngliche Remote des Projekts, die Einstellung
für die GitHub-Token-Datei und das vorherige AgentDeck-Deployment wiederherstellen oder nur die
Forgejo-Konfiguration dieses Projekts entfernen. Git- und PR-Lesezugriffe prüfen, dann fortsetzen.
Nie eine ganze laufende AgentDeck-Datenbank über fremde Projekte zurückspielen.
