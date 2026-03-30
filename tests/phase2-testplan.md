# Phase 2 Testplan — Auth & Security

**Datum:** 2026-03-30
**Ziel:** Verify Token-basierte Authentifizierung, Autorisierung und Message-Spoofing-Fix
**Vorbedingungen:**
- Service gestartet mit SWARM_AUTH_MODE=enforce (default für Tests)
- Mindestens 2 Agents registriert mit bekannten API Keys
- Admin-Key bekannt (SWARM_ADMIN_KEY env var oder generiert)

---

## TA: Token-Generierung bei Registration

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TA.1 | POST /agents mit id/name/desc | curl | Response enthält `apiKey` Feld |
| TA.2 | apiKey Format | curl | Non-empty String, ausreichende Länge (>=32 chars) |
| TA.3 | apiKey ist unique pro Agent | 2x register | Verschiedene Keys |
| TA.4 | POST /agents/create (UI) | curl | Response enthält `apiKey` |
| TA.5 | Reconnect mit altem Key | POST /agents/:id/connect + Bearer | Funktioniert ohne neuen Key |

## TB: Auth auf allen Endpoints (enforce mode)

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TB.1 | GET /agents ohne Token | curl | 401 Unauthorized |
| TB.2 | GET /agents mit gültigem Token | curl + Bearer | 200 OK |
| TB.3 | GET /agents mit ungültigem Token | curl + Bearer "invalid" | 401 |
| TB.4 | GET /topology ohne Token | curl | 401 |
| TB.5 | POST /messages ohne Token | curl | 401 |
| TB.6 | POST /edges ohne Token | curl | 401 |
| TB.7 | DELETE /agents/:id ohne Token | curl | 401 |
| TB.8 | PATCH /agents/:id ohne Token | curl | 401 |
| TB.9 | GET /health ohne Token | curl | 200 (health should be public) |
| TB.10 | GET /events/:id ohne Token | curl SSE | 401 |
| TB.11 | POST /agents (register) ohne Token | curl | 200 (registration must be open) |

## TC: Message Spoofing Fix

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TC.1 | POST /messages from=eigene-id (korrekt) | curl + Bearer | 200, delivered |
| TC.2 | POST /messages from=andere-id (spoof) | curl + Bearer | 403 Forbidden |
| TC.3 | POST /messages/broadcast from=eigene-id | curl + Bearer | 200 |
| TC.4 | POST /messages/broadcast from=andere-id | curl + Bearer | 403 |
| TC.5 | Message via Plugin send_message | MCP tool | Funktioniert (Plugin setzt from automatisch) |

## TD: Admin vs Agent Scope

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TD.1 | Agent löscht sich selbst | curl DELETE + eigener Token | 200 OK (oder 403?) |
| TD.2 | Agent löscht anderen Agent | curl DELETE + eigener Token | 403 Forbidden |
| TD.3 | Agent erstellt Edge | curl POST /edges + eigener Token | 403 (nur Admin) |
| TD.4 | Agent entfernt Edge | curl DELETE /edges + eigener Token | 403 (nur Admin) |
| TD.5 | Agent ändert eigene Properties | curl PATCH + eigener Token | 200 OK |
| TD.6 | Agent ändert fremde Properties | curl PATCH + eigener Token | 403 |
| TD.7 | Agent ruft topology?full=true ab | curl + eigener Token | 403 (nur Admin) |
| TD.8 | Admin löscht Agent | curl DELETE + Admin-Key | 200 OK |
| TD.9 | Admin erstellt Edge | curl POST /edges + Admin-Key | 200 OK |
| TD.10 | Admin ändert fremde Properties | curl PATCH + Admin-Key | 200 OK |

## TE: Auth Modes (SWARM_AUTH_MODE)

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TE.1 | mode=off: Request ohne Token | curl | 200 OK (alles erlaubt) |
| TE.2 | mode=off: Spoofed Message | curl | 200 (kein Check) |
| TE.3 | mode=warn: Request ohne Token | curl + check logs | 200 OK, aber Warning in Log |
| TE.4 | mode=warn: Spoofed Message | curl + check logs | 200, Warning in Log |
| TE.5 | mode=enforce: Request ohne Token | curl | 401 |
| TE.6 | mode=enforce: Spoofed Message | curl | 403 |

## TF: Admin-Key

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TF.1 | Admin-Key auf Agent-Endpoint | curl + Admin Bearer | 200 OK |
| TF.2 | Admin-Key auf Admin-Endpoint | curl + Admin Bearer | 200 OK |
| TF.3 | Admin-Key kann Messages senden als jeder | curl + Admin Bearer | 200 (Admin bypass) |
| TF.4 | Agent-Key auf Admin-Endpoint | curl + Agent Bearer | 403 |
| TF.5 | SWARM_ADMIN_KEY env var | Service start | Key wird aus Env geladen |

## TG: SSE Auth

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TG.1 | GET /events/:id ohne Token | curl SSE | 401 |
| TG.2 | GET /events/:id?token=valid | curl SSE | 200, SSE stream starts |
| TG.3 | GET /events/:id?token=invalid | curl SSE | 401 |
| TG.4 | GET /events/:id?token=other-agents-key | curl SSE | 403 (nicht dein Stream) |
| TG.5 | GET /events/:id mit Bearer Header | curl SSE | 200 (alternative Auth) |

## TH: Key-Persistenz

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TH.1 | Agent registrieren, Key merken | curl | apiKey in Response |
| TH.2 | Service restart | restart | Service startet sauber |
| TH.3 | Request mit altem Key | curl + Bearer | 200 OK (Key überlebt Restart) |
| TH.4 | Keys in topology.json | File lesen | Keys gespeichert (oder separates File) |
| TH.5 | Keys NICHT in GET /topology | curl | Keine apiKey Felder in Response |
