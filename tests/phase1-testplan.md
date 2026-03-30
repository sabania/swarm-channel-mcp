# Phase 1 Testplan — QA

**Datum:** 2026-03-30
**Ziel:** Verify dass alle Phase 1 Fixes korrekt implementiert sind
**Vorbedingung:** RC Build deployed, Service neu gestartet, mindestens 2 Agents online

---

## T1: Object.assign Fix (PATCH /agents/:id)

**Was wurde gefixt:** PATCH erlaubte Überschreiben von geschützten Feldern (status, registeredAt, lastSeen)

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T1.1 | PATCH mit status-Feld | curl PATCH mit `{"status":"offline"}` | status bleibt unverändert ODER 400 error |
| T1.2 | PATCH mit registeredAt | curl PATCH mit `{"registeredAt":"1999-01-01"}` | registeredAt bleibt unverändert |
| T1.3 | PATCH mit lastSeen | curl PATCH mit `{"lastSeen":"1999-01-01"}` | lastSeen bleibt unverändert |
| T1.4 | PATCH mit erlaubten Feldern | curl PATCH mit `{"name":"Test","description":"new"}` | Felder werden korrekt aktualisiert |
| T1.5 | PATCH mit gemischten Feldern | curl PATCH mit `{"name":"X","status":"offline"}` | name aktualisiert, status ignoriert |
| T1.6 | PATCH ID-Change | curl PATCH mit `{"id":"new-id"}` | ID-Rename funktioniert wie bisher |

## T2: Topology Data Exposure Fix (GET /topology)

**Was wurde gefixt:** Topology-Endpoint gab interne Felder (cwd, launchCommand, interne description) zurück

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T2.1 | GET /topology | curl | Kein `cwd` in Response |
| T2.2 | GET /topology | curl | Kein `launchCommand` in Response |
| T2.3 | GET /topology | curl | `description` zeigt publicDescription (oder gefiltert) |
| T2.4 | GET /agents (list) | curl | Keine internen Felder exponiert |
| T2.5 | GET /agents/:id | curl | Gibt weiterhin volle Info an den Agent selbst (oder auch gefiltert?) |
| T2.6 | GET /agents/:id/connections | curl | Nur public views |

## T3: Adjacency Map (Edge-Operationen)

**Was wurde gefixt:** O(n) Array-Iteration ersetzt durch performante Map/Set-Struktur

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T3.1 | POST /edges | curl | Edge wird erstellt, beide Seiten notifiziert |
| T3.2 | POST /edges (duplicate) | curl | `{"ok":false}` — kein Duplikat |
| T3.3 | POST /edges (self-loop) | curl | `{"ok":false}` — kein Self-Loop |
| T3.4 | POST /edges (unknown agent) | curl | `{"ok":false}` — Agent existiert nicht |
| T3.5 | DELETE /edges | curl | Edge entfernt, beide Seiten notifiziert |
| T3.6 | DELETE /edges (non-existent) | curl | `{"ok":false}` |
| T3.7 | GET /agents/:id/connections | curl | Korrekte connected agents |
| T3.8 | Message über Edge | send_message | Zustellung funktioniert |
| T3.9 | Message ohne Edge | curl POST /messages | Wird blockiert |
| T3.10 | Remove Agent | curl DELETE | Alle Edges des Agents entfernt |
| T3.11 | Topology nach Operationen | curl GET /topology | Edges konsistent |

## T4: Async I/O (Topology-Persistenz)

**Was wurde gefixt:** Synchrone writeFileSync/renameSync ersetzt durch async Varianten

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T4.1 | Agent registrieren | curl POST /agents | topology.json wird geschrieben |
| T4.2 | Edge hinzufuegen | curl POST /edges | topology.json aktualisiert |
| T4.3 | Agent entfernen | curl DELETE /agents/:id | topology.json aktualisiert |
| T4.4 | Rapid-fire Mutations | 10x curl schnell hintereinander | Alle Mutations korrekt in File |
| T4.5 | Service Restart | Restart + check | Topology wird korrekt geladen |

## T5: Graceful Shutdown

**Was wurde gefixt:** Service hatte keinen SIGTERM/SIGINT Handler

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T5.1 | SIGTERM senden | kill + SSE beobachten | SSE-Connections sauber geschlossen |
| T5.2 | Agents nach Shutdown | list_agents nach Restart | Alle als offline markiert |
| T5.3 | Topology nach Shutdown | File lesen | Konsistenter State |

## T6: SSE Parser Fix (Plugin)

**Was wurde gefixt:** Regex-basierter Parser ersetzt durch robusteren Parser

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T6.1 | Normale Message | send_message | Korrekt empfangen |
| T6.2 | Message mit Newlines | curl mit mehrzeiligem content | Korrekt empfangen, kein Parse-Error |
| T6.3 | Message mit JSON im Content | send_message mit JSON-String | Korrekt empfangen |
| T6.4 | Lange Message (>10KB) | curl mit langem content | Korrekt empfangen |
| T6.5 | Rapid-fire Messages | 10x send_message schnell | Alle empfangen, kein Buffer-Issue |

## T7: Discover mit Query-Filtering

**Was wurde gefixt:** discover gab alle connected Agents zurueck statt zu filtern

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T7.1 | Query "backend express" | discover tool | Nur relevante Agents (service-dev) |
| T7.2 | Query "react frontend" | discover tool | Nur relevante Agents (ui-dev) |
| T7.3 | Query "nonexistent skill xyz" | discover tool | Leere Liste oder keine Treffer |
| T7.4 | Empty Query | discover tool | Error oder alle Agents |
| T7.5 | Query passt auf mehrere | discover tool | Mehrere relevante Agents, gerankt |

## T8: Input Validation (NEU — Service-Dev)

**Was wurde hinzugefuegt:** Agent-IDs und Felder werden jetzt validiert

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T8.1 | Agent ID mit Leerzeichen/Sonderzeichen | curl POST /agents/create | 400 error |
| T8.2 | XSS in Agent ID | curl POST /agents/create | 400 error |
| T8.3 | Leerer Agent Name | curl POST /agents/create | 400 error |
| T8.4 | Agent ID > 100 Zeichen | curl POST /agents/create | 400 error |

## T9: Message Size Limit (NEU — Service-Dev)

**Was wurde hinzugefuegt:** Messages > 32KB werden abgelehnt

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T9.1 | Normale kurze Message | curl POST /messages | Erlaubt |
| T9.2 | Message > 32KB | curl POST /messages | 400 error |
| T9.3 | Message knapp unter 32KB | curl POST /messages | Erlaubt |

## T2.5-T2.6: Topology Admin View (NEU)

**Loesung fuer UI-Regression:** GET /topology?full=true gibt volle Daten

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| T2.5 | GET /topology?full=true | curl | cwd vorhanden |
| T2.6 | GET /topology?full=true | curl | launchCommand vorhanden |
