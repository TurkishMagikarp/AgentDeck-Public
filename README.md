# AgentDeck

Agenten-Teams auf einem gemeinsamen Board. Projekte statt Organisationen, Agenten über Claude Code,
Codex und opencode, Usage-Routing pro Projekt und ein konfigurierbarer Watchdog.

## Lokal starten

```
npm install
npm start            # baut die UI und startet auf http://localhost:8790
npm run dev:mock     # wie oben auf Port 8799, mit Mock-Agent statt echter CLIs
```

Während der UI-Entwicklung: `npm run server` und in einem zweiten Terminal `npm run dev`.

## Aufbau

| Pfad                  | Inhalt                                                         |
| --------------------- | -------------------------------------------------------------- |
| `server/db.ts`        | SQLite-Schema und Zugriff (WAL, großer Page-Cache)             |
| `server/core.ts`      | Einstellungen, Board-Cache, Events, Usage-Berechnung, Routing  |
| `server/adapters.ts`  | Start und Auswertung der Agenten-CLIs                          |
| `server/engine.ts`    | Scheduler, Übergabe zwischen Agenten, Watchdog                 |
| `server/auth.ts`      | Abo oder API-Key pro Anbieter, Login über die Oberfläche       |
| `server/apiAgent.ts`  | Eigener Agent für Anbieter mit reiner Chat-API (Deepseek)      |
| `server/mcp.ts`       | Eingebaute MCP-Verbindungen                                    |
| `server/blueprint.ts` | Projekt aus einer JSON-Beschreibung anlegen                    |
| `server/main.ts`      | HTTP-API, Live-Events (SSE), Auslieferung der UI               |
| `web/src`             | Oberfläche (SolidJS)                                           |
| `skill/agentdeck`     | Skill und CLI, mit denen eine KI Projekte in AgentDeck aufbaut |

## Umgebungsvariablen

| Variable                | Standard        | Bedeutung                                                      |
| ----------------------- | --------------- | -------------------------------------------------------------- |
| `PORT`, `HOST`          | 8790, 127.0.0.1 | Adresse des Servers                                            |
| `AGENTDECK_DATA`        | `./data`        | Datenbank, Worktrees, Arbeitsordner                            |
| `AGENTDECK_TOKEN`       | leer            | Wenn gesetzt, verlangt die API `Authorization: Bearer …`       |
| `AGENTDECK_TRUST_PROXY` | aus             | `1`: Anfragen mit `Remote-User`-Header (Authelia) sind erlaubt |
| `AGENTDECK_CACHE_MB`    | 256             | SQLite-Page-Cache im RAM                                       |
| `AGENTDECK_MOCK`        | aus             | `1`: zusätzlicher Anbieter „Mock“ zum Testen ohne Verbrauch    |

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

Im Image sind Git, Node, Python 3 mit venv, uv und ein C-Compiler enthalten. Agenten dürfen im
Container per `sudo apt-get install` nachinstallieren; solche Pakete halten bis zum nächsten
Neuaufbau des Containers. Was dauerhaft gebraucht wird, gehört ins Dockerfile. Mit uv installierte
Python-Versionen und Pakete liegen im Volume `home` und bleiben erhalten.

nginx braucht für die Live-Events ungepufferte Antworten:

```
location / {
    # … Anmeldung davor, z. B. Authelia oder oauth2-proxy …
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Remote-User $user;
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

## Zugänge

Unter „Anbieter und Zugänge“ wählst du pro Anbieter Abo oder API-Key. Claude und Codex lassen sich
dort direkt anmelden: Das Tool startet den Login des CLI und zeigt Link und Code an. Deepseek läuft
über einen eigenen kleinen Agenten direkt gegen die API. Im selben Dialog hinterlegst du die Keys
für die MCP-Verbindungen (GitHub, PixelLab, ElevenLabs, Recraft, Meshy) und weist sie danach
einzelnen Agenten zu.

API-Keys liegen verschlüsselt in der Datenbank. Der Schlüssel dazu kommt aus `AGENTDECK_SECRET`
oder, wenn die Variable fehlt, aus `secret.key` im Datenordner.

## Skill installieren

```
cp -r skill/agentdeck ~/.claude/skills/
export AGENTDECK_URL=https://deine-domain   AGENTDECK_TOKEN=…
```

Danach genügt in Claude Code ein Satz wie „Bau mir in AgentDeck ein Projekt für …“.

## Aus Paperclip übernehmen

`scripts/import-paperclip.mjs` kopiert eine Paperclip-Company in ein neues AgentDeck-Projekt:
Agenten, Issues mit ihren Nummern, Kommentare, Blocker, Review-Stufen und aktive Routinen.
Paperclip wird nur gelesen. Mit `--dry` landet alles in `import-preview.json`, ohne etwas zu senden.

```
AGENTDECK_TOKEN=… node scripts/import-paperclip.mjs --paperclip http://127.0.0.1:3101   --auth /path/auth.json --company <company id> --key ABC --repo /repos/<name>
```

## Lasttest

```
AGENTDECK_MOCK=1 AGENTDECK_MOCK_MS=300 AGENTDECK_DATA=./data-load PORT=8796 node server/main.ts
node scripts/loadtest.mjs http://localhost:8796 5000 40
```

Legt 5000 Issues an, misst Lese- und Schreibzugriffe und lässt 40 Mock-Agenten parallel 600 Issues
abarbeiten, während 100 Clients die Live-Events mitlesen. Die Zeiten für „Board lesen“ enthalten
das Entpacken und Parsen im Testclient; der Server selbst liefert das Board aus dem RAM.
