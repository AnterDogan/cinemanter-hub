# demxane.com – Dienste-Hub

Startseite für alle Dienste auf dem Mac Mini und bei Cloudflare. Läuft als Cloudflare-Pages-Projekt
`cinemanter-hub` (Git-Deploy: push auf `main`).

## Aufbau

| Pfad | Zweck |
|---|---|
| `public/index.html` | Die Seite. Karten werden aus `services.json` erzeugt. |
| `public/services.json` | **Die Dienstliste.** Neuer Dienst = eine Zeile hier. Felder: `id`, `name`, `url`, `desc`, `group` (`alltag`/`apps`/`verwaltung`), `icon`, `host` (`mini`/`cloud`), optional `tag`, `check` (`plex` oder eigene Prüf-URL). |
| `functions/api/status.js` | `GET /api/status`: Dienste-Status, 24h-Verlauf, Auslastung des Mini. Prüft selbst nach, wenn die Daten älter als 3 Minuten sind. |
| `functions/api/push.js` | `POST /api/push`: nimmt die Auslastung vom Mini entgegen (Bearer `PUSH_TOKEN`) und prüft dabei alle Dienste von Cloudflare aus. |
| `functions/_lib/checks.js` | Prüf-Logik und D1-Zugriff. |
| `schema.sql` | Tabellen der D1-Datenbank `demxane-status`. |
| `mini/demxane-stats.sh` | Läuft auf dem Mini jede Minute (LaunchAgent `com.demxane.stats`), sammelt CPU, RAM, Swap, Platten, Container, Plex und schickt sie an `/api/push`. |
| `mini/com.demxane.stats.plist` | LaunchAgent dazu (`~/Library/LaunchAgents/` auf dem Mini). |
| `scripts/cf-hub-access.py` | Cloudflare Access vor die Seite stellen (Login per Google oder E-Mail-Code). |

## Geheimnisse

Beim Pages-Projekt hinterlegt (`npx wrangler pages secret put <NAME> --project-name cinemanter-hub`):
`PUSH_TOKEN` (gleicher Wert wie in `stats.env` auf dem Mini) und `PLEX_TOKEN` (Plex-Konto).

## Mini einrichten

```bash
ssh mini 'mkdir -p ~/Documents/demxane-stats'
scp mini/demxane-stats.sh mini:~/Documents/demxane-stats/
ssh mini 'printf "PUSH_TOKEN=…\n" > ~/Documents/demxane-stats/stats.env && chmod 600 ~/Documents/demxane-stats/stats.env'
scp mini/com.demxane.stats.plist mini:~/Library/LaunchAgents/
ssh mini 'launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.demxane.stats.plist'
```

Log auf dem Mini: `~/Library/Logs/demxane-stats.log`.
