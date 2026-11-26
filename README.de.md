# AgentDeck

English: [README.md](README.md)

Agenten-Teams auf einem gemeinsamen Board. Projekte statt Organisationen, Agenten über Claude Code,
Codex und opencode, Usage-Routing pro Projekt und ein konfigurierbarer Watchdog.

## Lokal starten

```
npm install
npm start            # baut die UI und startet auf http://localhost:8790
npm run dev:mock     # wie oben auf Port 8799, mit Mock-Agent statt echter CLIs
npm run demo         # zum Ansehen: fertiges Team mit Mock-Agenten auf http://localhost:8798
```

`npm run demo` braucht weder Login noch API-Key: Ein Vorlagen-Team arbeitet mit Mock-Agenten ein
paar Issues ab, damit Board, Mission Control, Journal und Statistiken etwas zu zeigen haben. Die
Daten liegen in `data-demo` und lassen sich danach löschen.

Während der UI-Entwicklung: `npm run server` und in einem zweiten Terminal `npm run dev`.

## Aufbau

| Pfad                  | Inhalt                                                          |
| --------------------- | --------------------------------------------------------------- |
| `server/db.ts`        | SQLite-Schema und Zugriff (WAL, großer Page-Cache)              |
| `server/core.ts`      | Einstellungen, Board-Cache, Events, Usage-Berechnung, Routing   |
| `server/adapters.ts`  | Start und Auswertung der Agenten-CLIs                           |
| `server/engine.ts`    | Scheduler, Übergabe zwischen Agenten, Watchdog                  |
| `server/auth.ts`      | Abo oder API-Key pro Anbieter, Login über die Oberfläche        |
| `server/apiAgent.ts`  | Eigener Agent für Anbieter mit reiner Chat-API (Deepseek)       |
| `server/mcp.ts`       | Eingebaute MCP-Verbindungen                                     |
| `server/blueprint.ts` | Projekt aus einer JSON-Beschreibung anlegen                     |
| `server/recovery.ts`  | Selbstheilung: Fehlerart erkennen, Anbieter pausieren, Hinweise |
| `server/lessons.ts`   | Gelerntes pro Projekt, das jeder Lauf mitliest                  |
| `server/pacing.ts`    | Kontingent nach Abo-Fenster einteilen                           |
| `server/preview.ts`   | App eines Branches starten und fotografieren                    |
| `server/push.ts`      | Web Push aufs Handy                                             |
| `server/report.ts`    | Morgenbericht über alle Projekte                                |
| `server/showcase.ts`  | Öffentliches Schaufenster eines Projekts unter `/show/…`        |
| `server/templates.ts` | Fertige Teams für neue Projekte                                 |
| `server/issueCap.ts`  | Kosten-Deckel pro Issue                                         |
| `server/checklist.ts` | Abnahme-Checkliste pro Issue: „Done when“ plus Vorlagen         |
| `server/precheck.ts`  | Vorcheck vor dem Review: Nachweise, Merge, Prüfbefehl           |
| `server/landing.ts`   | Landung: Merge oder Pull Request, Prüfbefehl vor dem Push       |
| `server/gates.ts`     | Freigabe-Regeln vor der Landung (Abhängigkeiten, Infrastruktur) |
| `server/githubWebhook.ts` | GitHub-Webhooks: Signatur prüfen, wartende Pull Requests anstoßen |
| `server/ticket.ts`    | Ticket-Format, das Agenten beim Anlegen von Issues einhalten    |
| `server/diff.ts`      | Code-Änderungen eines Issues (Branch-Diff, nicht Committetes)   |
| `server/gitGraph.ts`  | Daten für den Git-Graphen: Branches, Commits, Agenten           |
| `server/audit.ts`     | Änderungsprotokoll: wer was an Einstellungen geändert hat       |
| `server/arena.ts`     | Arena: mehrere Agenten am selben Issue, eine Jury wählt          |
| `server/deckMcp.ts`   | AgentDeck als MCP-Server: Boards lesen, Issues anlegen und steuern |
| `server/intake.ts`    | GitHub-Issues mit Label aufs Board übernehmen                   |
| `server/metrics.ts`   | Zahlen für Prometheus unter `/api/metrics`                      |
| `server/reauth.ts`    | Token-Bestätigung für Einstellungen, die als Befehl laufen      |
| `server/main.ts`      | HTTP-API, Live-Events (SSE), Auslieferung der UI                |
| `web/src`             | Oberfläche (SolidJS)                                            |
| `skill/agentdeck`     | Skill und CLI, mit denen eine KI Projekte in AgentDeck aufbaut  |

## Umgebungsvariablen

| Variable                 | Standard        | Bedeutung                                                                                            |
| ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`, `HOST`           | 8790, 127.0.0.1 | Adresse des Servers                                                                                  |
| `AGENTDECK_DATA`         | `./data`        | Datenbank, Worktrees, Arbeitsordner                                                                  |
| `AGENTDECK_TOKEN`        | leer            | Pflicht (außer mit Proxy oder `AGENTDECK_ALLOW_OPEN=1`); API verlangt `Authorization: Bearer …`      |
| `AGENTDECK_TRUST_PROXY`  | aus             | `1`: Anfragen mit `Remote-User`-Header (Authelia) sind erlaubt, wenn auch `X-AgentDeck-Proxy` stimmt |
| `AGENTDECK_PROXY_SECRET` | leer            | Pflicht mit `TRUST_PROXY` (mind. 16 Zeichen); nginx sendet es als `X-AgentDeck-Proxy`                |
| `AGENTDECK_ALLOW_OPEN`   | aus             | `1`: Start ohne Token erlauben (nur lokal; im Mock-Modus automatisch)                                |
| `AGENTDECK_CACHE_MB`     | 256             | SQLite-Page-Cache im RAM                                                                             |
| `AGENTDECK_MOCK`         | aus             | `1`: zusätzlicher Anbieter „Mock“ zum Testen ohne Verbrauch                                          |
| `AGENTDECK_PUBLIC_URL`   | leer            | Öffentliche Adresse für Links in Mails und als Push-Absender                                         |
| `AGENTDECK_GITHUB_WEBHOOK_SECRET` | leer   | Secret der GitHub-Webhooks (mind. 16 Zeichen), siehe „Freigaben und GitHub-Webhooks“                 |
| `AGENTDECK_LANG`         | siehe „Sprachen“ | `de` oder `en`: Sprache der Instanz                                                              |

## Sprachen

AgentDeck gibt es auf Deutsch und Englisch.

- **Oberfläche:** Jede Person stellt die Sprache in ihrem Browser um (Umschalter „Sprache“). Die Wahl
  gilt nur für diesen Browser.
- **Projekt:** Die Projekteinstellung „Sprache der Agenten“ (`settings.language`) legt fest, in
  welcher Sprache die Agenten ihre Prompts bekommen und in welcher der Server seine Notizen an die
  Issues des Projekts schreibt.
- **Instanz:** `AGENTDECK_LANG=de|en` setzt die Vorgabe für den Morgenbericht und für neue Projekte.
  Ohne die Variable startet eine neue Instanz auf Englisch; eine Instanz, die schon Projekte hatte,
  bleibt auf Deutsch.
- **Texte ergänzen:** Im Code steht der deutsche Text als Schlüssel (`t('…')`), die englische
  Fassung kommt in `server/i18n/en.*.ts` oder `web/src/i18n/en.*.ts`. Fehlt ein Eintrag, schlagen
  `test/i18n.test.ts` und `test/i18nServer.test.ts` fehl.

Die Skripte `npm run demo` und `scripts/seed-demo.mjs` lesen `AGENTDECK_LANG` ebenfalls (Vorgabe
`en`) und legen das Demo-Projekt in dieser Sprache an.

## Mit Docker auf einem Server

```
echo "AGENTDECK_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build

# einmalig in jedem CLI anmelden, die Logins liegen im Volume "home"
docker compose exec agentdeck claude
docker compose exec agentdeck codex login
docker compose exec agentdeck opencode auth login
```

Repos, an denen Agenten arbeiten sollen, liegen unter `/srv/agentdeck/repos` und heißen im Container
`/repos/<name>`. Diesen Pfad trägst du im Projekt ein.

Im Image sind Git, Node, Python 3 mit venv, uv und ein C-Compiler enthalten. Systempakete holt
ein Agent mit `agentdeck install <paket>`; der Server installiert sie aus den Debian-Quellen. Sie
halten bis zum nächsten Neuaufbau des Containers. Was dauerhaft gebraucht wird, gehört ins
Dockerfile. Mit uv installierte Python-Versionen und Pakete liegen im Home des Projekts unter
`/data/homes` und bleiben erhalten.

### Sandbox

Im Container läuft jedes Projekt unter einem eigenen Linux-Nutzer (`ad-<key>`, z. B. `ad-shop`).
Ihm gehören Repo, Worktrees und sein Home unter `/data/homes`, sonst nichts. Agenten haben kein
`sudo`, lesen weder Datenbank noch Schlüssel noch die Logins des Servers und sehen keine anderen
Projekte. Auch Git-Befehle des Servers laufen als Projektnutzer, damit Hooks oder Git-Einstellungen,
die ein Agent ins Repo schreibt, nichts außerhalb des Projekts erreichen.

- Der Server (`node`) darf per sudo nur zwei Dinge: Befehle als Projektnutzer starten und
  `/usr/local/sbin/agentdeck-sandbox` als root ausführen (Nutzer anlegen, Pakete installieren,
  Läufe stoppen). Siehe `docker/sudoers` und `server/sandbox.ts`.
- Repos unter `/repos` gehen beim ersten Start an den Projektnutzer über (`chown`). Ein Repo gehört
  genau einem Projekt; ein zweites Projekt mit demselben Pfad startet nicht.
- Alle Projekte laufen im selben Container, getrennt durch Linux-Nutzer, nicht durch eigene
  Container.
- Die CLI-Logins bleiben im Volume `home` des Servers. Jeder Lauf bekommt eine Kopie, ein
  erneuertes Token geht danach zurück und gleich an die anderen laufenden Projekte. Zurück kommen
  nur die Token-Dateien, nie Einstellungen (`.claude.json`, `config.toml`).
- Ins Projekt-Home kommen außerdem `.gitconfig`, der gh-Login (auch aus `GH_CONFIG_DIR`, nicht für
  Projekte mit eigenem GitHub-Token) sowie Skills, Plugins und die opencode-Konfiguration des
  Servers, sobald sie sich ändern.
- Pakete installieren Agenten mit `agentdeck install <paket>`, nicht mit sudo.
- Für Claude ist `claude setup-token` am robustesten.
- Außerhalb des Containers (Windows, `npm start`) ist die Sandbox aus; `AGENTDECK_SANDBOX=1`
  schaltet sie auf Linux ein.

#### Netzwerk-Allowlist pro Projekt

In den Projekteinstellungen unter „Netzwerk der Agenten“ lässt sich ein Projekt von „Offen“ (Standard,
wie bisher) auf „Nur erlaubte Hosts“ stellen. Dann gilt:

- Der Projektnutzer erreicht per Firewall (iptables/ip6tables, Regel pro uid) nur noch `127.0.0.1`
  bzw. `::1`: den AgentDeck-Server und dessen Egress-Proxy. Alles andere wird abgewiesen, auch DNS.
- Die Läufe bekommen `HTTP_PROXY`/`HTTPS_PROXY` (und Kleinschreibung, `ALL_PROXY`, `NO_PROXY`)
  auf den Proxy unter `127.0.0.1:8791` (`AGENTDECK_EGRESS_PORT`). Der Proxy erkennt das Projekt an
  der uid der Verbindung (vom Kernel, nicht vom Client) und lässt nur Hosts der Liste durch.
- Einträge: `github.com` (genau dieser Host), `*.example.com` (nur Subdomains), `host:8443`,
  IP-Adressen (`192.0.2.7`, `[2001:db8::1]`). Ohne Port gelten 80 und 443. Ein Hostname, der auf
  eine interne Adresse zeigt (Loopback, privates Netz, Link-Local), wird abgewiesen; interne Ziele
  gehen nur als IP-Eintrag.
- Vorgabe: die Endpunkte von Claude Code und Codex, GitHub, npm und PyPI. Zuletzt blockierte Ziele
  zeigt die Einstellungsseite zum Freigeben an.
- Git über SSH geht mit Allowlist nicht, Git über HTTPS schon. `agentdeck install` läuft über den
  Server und ist nicht betroffen.

Die Firewall-Regeln setzt der Sandbox-Helfer (`agentdeck-sandbox egress`). Dafür braucht der
Container die Capability `NET_ADMIN`; im `docker-compose.yml` steht deshalb:

```yaml
    cap_add:
      - NET_ADMIN
```

Fehlt sie (oder iptables im Image), bleibt das Projekt offen, der Server schreibt es ins Log und die
Einstellungsseite zeigt „Firewall nicht verfügbar“. Die Capability gilt nur für root im Container,
also für den Helfer; Server und Agenten laufen ohne sie.

nginx braucht für die Live-Events ungepufferte Antworten:

```
location / {
    # … Anmeldung davor, z. B. Authelia oder oauth2-proxy …
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Remote-User $user;
    proxy_set_header X-Real-IP $remote_addr;
}
location /api/events {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Remote-User $user;
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

`AGENTDECK_TRUST_PROXY=1` ist nur sicher, solange der Port ausschließlich über nginx erreichbar ist
(im Compose-File ist er an 127.0.0.1 gebunden) und nginx den Header `Remote-User` selbst setzt.
nginx muss zusätzlich `proxy_set_header X-AgentDeck-Proxy <AGENTDECK_PROXY_SECRET>;` senden.
Sonst könnte jeder lokale Prozess, auch ein Agent, den Header fälschen.

Fehlversuche mit dem Board-Token (Login-Formular, `Authorization: Bearer`) werden gebremst: zehn pro
Client, danach einer pro Minute, insgesamt höchstens einer alle sechs Sekunden. Wer schon
angemeldet ist (Cookie), wird nie gesperrt. Hinter nginx zählt `X-Real-IP`, aber nur zusammen mit
dem Proxy-Secret; sonst teilen sich alle Clients die Adresse des Proxys.

## Zugänge

Unter „Anbieter und Zugänge“ wählst du pro Anbieter Abo oder API-Key. Claude und Codex lassen sich
dort direkt anmelden: Das Tool startet den Login des CLI und zeigt Link und Code an. Deepseek läuft
über einen eigenen kleinen Agenten direkt gegen die API. Im selben Dialog hinterlegst du die Keys
für die MCP-Verbindungen (GitHub, PixelLab, ElevenLabs, Recraft, Meshy) und weist sie danach
einzelnen Agenten zu.

API-Keys liegen verschlüsselt in der Datenbank. Der Schlüssel dazu kommt aus `AGENTDECK_SECRET`
oder, wenn die Variable fehlt, aus `secret.key` im Datenordner.

### Anbieter-Reihenfolge und RTK

In **Verbrauch → Anbieter-Reihenfolge** legt jedes Projekt seine Prioritäten für Arbeit und
Reviews fest. Ohne Override nimmt AgentDeck den ersten verfügbaren Anbieter und berücksichtigt
dessen Stoppwert und Modelllimits. Unter **Agenten** kann ein Anbieter ausdrücklich bevorzugt
werden (`provider_override: true`). Nur für solche Overrides gelten die Einstellungen fürs
Ausweichen und die Ausweichreserve. Bestehende Agenten ohne explizites Override-Flag übernehmen
die Projektreihenfolge; ihre gespeicherten Anbieter- und Modellwerte bleiben als Modellreferenz erhalten.
Übersprungene Anbieter und Gründe stehen am Issue.

Das Docker-Image bringt RTK für die Shell-Befehle von Claude Code, Codex, OpenCode und
Deepseek mit. Unterstützte Befehle werden umgeschrieben, andere laufen unverändert. Die Statistik
unter **Verbrauch** zählt pro Projekt und Agent, unabhängig davon, welcher Anbieter den Lauf
ausführt. Claude Managed Agents bleiben in der Projekt-Sandbox deaktiviert.

Autonome Projekte füllen freie Laufplätze aus dem Backlog. Bei aktiver Gruppenreihenfolge
bleibt eine bereits aktive Gruppe zuerst dran; im Leerlauf zählt die nächste Gruppe mit
startbereiter Arbeit. Geparkte Aufgaben, offene Abhängigkeiten und Kostenlimits bleiben in Kraft.

## Änderungsprotokoll und Bestätigung

Das Änderungsprotokoll (Seitenleiste) zeigt, wer Projekteinstellungen, Agenten, Skills, Routinen,
Zugänge, MCP-Keys, Mail und Morgenbericht geändert hat und wer sich an- und abgemeldet hat. Wer:
„Owner“ mit Token oder Cookie, sonst der `Remote-User` des Proxys. Geheime Werte stehen nie darin,
nur dass sie sich geändert haben. Einträge bleiben 180 Tage, das Aufräumen läuft mit der täglichen
Housekeeping-Runde. API: `GET /api/audit?limit=50&before=<id>`.

Einstellungen, die der Server als Shell-Befehl ausführt (Prüfbefehl, schneller Prüfbefehl,
Startbefehl der Vorschau), ändern sich nur mit dem Zugangs-Token in derselben Anfrage: im Feld
`confirmToken` oder als `Authorization: Bearer …` (Skripte, Skill). Das gilt auch für Projekte aus
Blueprint oder Import. Die Oberfläche fragt dafür in einem Dialog nach dem Token. Ein falsches Token
zählt als Fehlversuch für die Sperre nach zu vielen Versuchen. Hinter dem Proxy ohne
`AGENTDECK_TOKEN` kann der Server niemanden neu prüfen: Der Proxy belegt nur, wer angemeldet ist,
nicht, dass gerade jemand davorsitzt. Befehle lassen sich dann nicht ändern, bis zusätzlich
`AGENTDECK_TOKEN` gesetzt ist (Proxy und Token funktionieren nebeneinander).

## Freigaben und GitHub-Webhooks

**Freigabe vor der Landung** (Projekteinstellungen, Landung): Statt automatisch zu landen, wartet
ein Branch auf dich, wenn er geschützte Pfade ändert, neue Abhängigkeiten hinzufügt
(`package.json`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`,
`composer.json`; reine Versionswechsel zählen nicht, eine unlesbare Datei schon), Infrastruktur-Dateien
ändert (Muster wie `Dockerfile`, `docker/**`, `.github/**`, `*.tf`) oder wenn jede Landung eine
Freigabe braucht. Das Issue steht dann auf „Wartet auf Mensch“, im Issue erscheint „Landung
freigeben“. Die Freigabe gilt für genau den angezeigten Commit und nur einmal: Ändert sich der
Branch danach, wartet er erneut. Diese Freigabe gibt nur der Besitzer, nie der Vertreter-Agent,
auch nicht in vollautonomen Projekten.

**Branch-Aufräumen auf `dev` und `pre-dev`:** Nach einer nachgewiesenen Landung räumt AgentDeck
seinen `agentdeck/KEY-N`-Branch lokal und bei veröffentlichten Landungen auch auf `origin` auf.
Die periodische Wartung prüft außerdem ältere fertige Issues. Git muss den exakten Branch-Stand
im Ziel finden, oder der zugehörige GitHub-PR muss als gemergt bestätigt sein (auch bei Squash oder
Rebase). Neuere Stände, fremde Branches und unsaubere oder nicht von AgentDeck verwaltete Checkouts
bleiben erhalten.

**GitHub-Webhooks** (Landung "Pull Request"): Ohne Webhooks fragt AgentDeck jede Minute bei GitHub
nach, ob die Checks der offenen Pull Requests fertig sind. Mit Webhooks meldet GitHub das selbst,
und die Abfrage läuft nur noch alle zehn Minuten als Rückfallebene, solange in den letzten 24
Stunden ein Webhook ankam.

1. Secret erzeugen und in die `.env` schreiben:
   `echo "AGENTDECK_GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env`, dann neu starten.
2. Im Repository auf GitHub: Settings, Webhooks, Add webhook.
   Payload URL `https://deine-domain/api/github/webhook`, Content type `application/json`,
   Secret wie oben. Events einzeln auswählen: Check runs, Check suites, Pull requests, Statuses.
3. Steht Authelia vor der Domain, braucht `^/api/github/webhook$` eine `bypass`-Regel wie das
   Schaufenster. Der Pfad prüft die Signatur `X-Hub-Signature-256` selbst.

Anfragen ohne gültige Signatur bekommen 401; wer 20-mal in zehn Minuten falsch signiert, bekommt
429, ohne dass der Inhalt noch gelesen wird. Ein Webhook sagt AgentDeck nur, wo es nachsehen soll:
Ob ein Pull Request gemergt wird, entscheidet weiterhin die Antwort von GitHub selbst.


## Arena: mehrere Agenten, ein Gewinner

Im Issue unter „Arena starten“ wählst du zwei bis vier Agenten, etwa denselben Auftrag einmal an
Claude, einmal an Codex. AgentDeck legt pro Agent einen Beitrag an: ein eigenes Issue mit eigenem
Branch, eigenen Läufen und eigenen Kosten. Das ursprüngliche Issue wartet im Backlog auf seine
Beiträge.

- Ein fertiger Beitrag wird festgehalten, statt geprüft oder gelandet zu werden. Der Vorcheck
  (Checkliste, Prüfbefehl) gilt für jeden Beitrag wie sonst auch.
- Arbeitet keiner mehr, entscheidet die Jury: ein einzelner Lauf, der Aufgabe, Checkliste,
  Zusammenfassungen und Diffs sieht, aber nicht, welcher Agent was geschrieben hat (Beitrag A, B, …).
  Anbieter der Jury ist der des Vertreter-Agenten, sonst der des ersten Beitrags.
- Der Gewinner geht den normalen Weg weiter: durch die Prüfer des Issues und in die Landung, mit
  allen Freigaben. Die anderen Beiträge werden geschlossen und nie gelandet. Landet der Gewinner,
  ist auch das ursprüngliche Issue erledigt.
- Gibt nur einer ab, gewinnt er ohne Jury. Gibt keiner ab, endet die Arena ohne Ergebnis und das
  Issue geht wieder seinen normalen Weg.
- Antwortet die Jury dreimal nicht lesbar, wählst du im Issue selbst („Diesen wählen“). In
  vollautonomen Projekten gewinnt dann der erste abgegebene Beitrag, damit nichts hängen bleibt;
  der Kommentar sagt das dazu.

Eine Arena kostet einen Lauf pro Beitrag plus den der Jury. Sie lohnt sich für Aufgaben, bei denen
der Ansatz offen ist, und zum Vergleich von Anbietern an echter Arbeit. API:
`POST /api/issues/:id/arena` mit `{"agents": [ids]}`, `GET /api/issues/:id/arena`,
`POST /api/issues/:id/arena/pick` mit `{"entry": id}`.

## GitHub-Issues übernehmen

Projekteinstellungen, „GitHub-Issues übernehmen“: Repository (`owner/name`), Label (Vorgabe
`agentdeck`) und wohin das Issue kommt. Bekommt ein offenes Issue im Repository das Label, legt
AgentDeck es mit Titel, Text und Link im Projekt an. Dasselbe Issue wird pro Projekt nur einmal
übernommen, Pull Requests und geschlossene Issues nie.

- Voraussetzung ist der GitHub-Webhook von oben, zusätzlich mit dem Event **Issues**.
- Es zählt das Setzen des Labels, nicht das Öffnen: Ein Label vergibt auf GitHub nur, wer im
  Repository mindestens Triage-Rechte hat. Fremde können ein Issue schreiben, aber nicht an die
  Agenten geben.
- Der Text stammt trotzdem von außen. Vorgabe ist deshalb das Backlog; „To do“ startet die
  Agenten sofort und passt zu Repositories, in denen nur das eigene Team Issues schreibt.

## AgentDeck als MCP-Server

Unter `/api/mcp-server` spricht AgentDeck das Model Context Protocol (Streamable HTTP). Jeder
MCP-Client kann damit die Boards lesen und Issues anlegen, kommentieren, verschieben und stoppen:

```
claude mcp add --transport http agentdeck https://deine-domain/api/mcp-server   --header "Authorization: Bearer $AGENTDECK_TOKEN"
```

Danach genügt im Client ein Satz wie „Was läuft gerade in AgentDeck?“ oder „Leg im Projekt SHOP ein
Issue für den Dark Mode an“.

| Tool               | Wirkung                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `fleet_status`     | Alle Projekte: Zähler, laufende Agenten, was auf dich wartet     |
| `list_projects`    | Projekte mit Key, offenen Issues, laufenden Agenten              |
| `get_board`        | Board eines Projekts, auf Wunsch nur eine Spalte                 |
| `get_issue`        | Issue mit Beschreibung, Läufen, Blockern, letzten Kommentaren    |
| `search_issues`    | Suche über alle Projekte                                         |
| `create_issue`     | Issue anlegen (Backlog, außer `status: "todo"`)                  |
| `comment_on_issue` | Kommentar, den der Agent beim nächsten Lauf liest                |
| `move_issue`       | Spalte wechseln                                                  |
| `start_arena`      | Mehrere Agenten am selben Issue antreten lassen                  |
| `stop_run`         | Laufenden Agenten am Issue stoppen                               |

Die Tools rufen dieselben Routen wie das Board, mit dem Token des Aufrufers. Rollen,
Änderungsprotokoll, Kosten-Deckel und Freigaben gelten also unverändert: Ein Token mit der Rolle
„Lesen“ kann lesen, aber nichts anlegen. Über MCP angelegte Issues tragen „Owner (MCP)“ als
Ersteller. Hinter Authelia braucht `^/api/mcp-server$` eine `bypass`-Regel; der Pfad verlangt
dann das Bearer-Token selbst (dafür muss `AGENTDECK_TOKEN` gesetzt sein).

## Zahlen für Prometheus

`GET /api/metrics` liefert das Prometheus-Textformat, mit Bearer-Token (die Rolle „Lesen“ genügt):

```yaml
scrape_configs:
  - job_name: agentdeck
    metrics_path: /api/metrics
    authorization: { credentials_file: /etc/prometheus/agentdeck.token }
    static_configs: [{ targets: ['127.0.0.1:8790'] }]
```

Enthalten sind `agentdeck_issues{project,status}`, `agentdeck_runs_running`,
`agentdeck_runs_total{project,provider,status}`, `agentdeck_cost_usd_total`,
`agentdeck_tokens_total{kind}`, `agentdeck_quota_utilization{provider,window}` und
`agentdeck_project_paused`. Die Zähler kommen aus der Datenbank und überstehen Neustarts. Ein
Alarm auf `agentdeck_issues{status="blocked"} > 0` meldet, wenn etwas auf einen Menschen wartet.

## Schaufenster hinter Authelia

Das Schaufenster ist absichtlich ohne Login erreichbar. Steht Authelia vor der ganzen Domain, braucht
es eine Ausnahme für genau zwei Pfade, sonst sieht niemand die Seite:

```
access_control:
  rules:
    - domain: agents.example.com
      resources: ['^/show/[\w-]+$', '^/api/public/[\w-]+$', '^/icon\.svg$']
      policy: bypass
```

Die Seite zeigt Agenten, Zustände und Zahlen, Issue-Titel nur wenn eingeschaltet. Code, Kommentare,
Kosten und Einstellungen verlässt nie den Login. „Neuer Link“ macht den alten sofort ungültig.

## Skill installieren

```
cp -r skill/agentdeck ~/.claude/skills/
export AGENTDECK_URL=https://deine-domain   AGENTDECK_TOKEN=…
```

Danach genügt in Claude Code ein Satz wie „Bau mir in AgentDeck ein Projekt für …“.

## Schneller durch: prüfen nach der Freigabe

Was am 22.11.2026 an einem echten Projekt mit sechs Agenten gemessen wurde und was daraus
in AgentDeck steckt:

- **Prüfbefehl erst vor dem Landen** (Projekteinstellungen, Vorcheck): Die Prüfer sehen fertige
  Arbeit sofort. Der Prüfbefehl läuft einmal nach der letzten Freigabe auf dem gemergten Stand,
  gepusht wird nur bei Grün, Rot nimmt den Merge zurück und geht mit der Ausgabe an den Ersteller.
  Ersteller und Prüfer bekommen im Prompt gesagt, die volle Testsuite nicht selbst zu starten.
  Vorher liefen dieselben Tests beim Ersteller, beim QA-Prüfer und vor dem Review.
- **Ticket-Format**: Agenten bekommen im Prompt, wie ein Issue aussieht (Goal, Task, Files, Done
  when, Out of scope, Notes). Die Agenten-API lehnt ein Issue ohne Task, Files und Done when ab.
  So reichen für die Ersteller kleinere Modelle; die starken bleiben für Planung und Prüfung.
- **Ein Prüfer statt Kette**: Zwei Prüfer hintereinander kosteten pro Issue einen ganzen Lauf mehr.
  Prüfen soll nur, wer urteilen muss; was ein Test entscheiden kann, entscheidet der Test.
- **Abhängigkeiten als Blocker**: Der Scheduler sieht nur `blocked_by`. Ein Satz wie „wartet auf
  den Bau von X“ in der Beschreibung lässt das Issue zu früh starten. Und was nur in einer später
  geöffneten Gruppe liegt, startet nicht, auch wenn alles andere darauf wartet.

Der Hebel mit der größten Wirkung war keiner der Modell- oder Testtricks, sondern die Frage,
warum bei zehn erlaubten Läufen nur einer lief.

## Aus einem anderen Tracker übernehmen

`POST /api/import` legt ein Projekt aus einer JSON-Beschreibung an und behält dabei Issue-Nummern,
Daten und Kommentare (siehe `server/importer.ts`). Das Projekt startet pausiert.

## Lasttest

```
AGENTDECK_MOCK=1 AGENTDECK_MOCK_MS=300 AGENTDECK_DATA=./data-load PORT=8796 node server/main.ts
node scripts/loadtest.mjs http://localhost:8796 5000 40
```

Legt 5000 Issues an, misst Lese- und Schreibzugriffe und lässt 40 Mock-Agenten parallel 600 Issues
abarbeiten, während 100 Clients die Live-Events mitlesen. Die Zeiten für „Read board“ enthalten
das Entpacken und Parsen im Testclient; der Server selbst liefert das Board aus dem RAM.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Jede und jeder darf AgentDeck frei nutzen, ändern und weitergeben.
