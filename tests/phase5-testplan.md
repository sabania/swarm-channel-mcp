# Phase 5 Testplan — Typed Events + Reliable SSE

**Datum:** 2026-03-30
**Ziel:** Verify Event IDs, Reconnect Recovery, Heartbeat, Ring Buffer, Capabilities in Events
**Vorbedingungen:** Service mit Event ID support, 2+ Agents online

---

## TE: Event IDs

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TE.1 | Events have ID field | SSE stream | Each event has `id:` line |
| TE.2 | IDs are monotonically increasing | SSE stream, trigger events | id(n+1) > id(n) |
| TE.3 | IDs are numeric or sequential | SSE stream | Parseable, ordered |
| TE.4 | Different event types all have IDs | Trigger message, online, edge | All carry IDs |

## TR: Reconnect Recovery (Last-Event-ID)

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TR.1 | Connect SSE, note last event ID | curl SSE | Get baseline ID |
| TR.2 | Disconnect, trigger events | curl + send messages | Events generated while disconnected |
| TR.3 | Reconnect with Last-Event-ID header | curl SSE + Last-Event-ID | Missed events replayed |
| TR.4 | Replayed events in correct order | Check SSE stream | Sequential IDs, correct types |
| TR.5 | No duplicate events on reconnect | Compare replayed vs original | No duplicates |
| TR.6 | Last-Event-ID=0 gets all buffered | curl SSE Last-Event-ID: 0 | Full ring buffer |
| TR.7 | Last-Event-ID=latest gets nothing | curl SSE Last-Event-ID: 9999 | No replayed events |

## TH: Heartbeat

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TH.1 | SSE sends heartbeat comments | curl SSE, wait 35s | `:heartbeat` or `: ping` comment |
| TH.2 | Connection stays alive >60s | curl SSE, wait 65s | No timeout, stream alive |
| TH.3 | Heartbeat interval ~30s | Measure time between heartbeats | ~30s ± 5s |

## TB: Ring Buffer Limit

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TB.1 | Buffer stores events | Generate events, reconnect | Events available |
| TB.2 | Buffer has max size | Generate >1000 events | Oldest dropped |
| TB.3 | Last-Event-ID older than buffer | Reconnect with very old ID | Get available events, not error |

## TC: Capabilities in Events

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TC.1 | agent_online includes capabilities | SSE event on agent connect | capabilities in event data |
| TC.2 | connected_to includes capabilities | SSE event on new edge | capabilities in event data |
| TC.3 | properties_updated includes capabilities | PATCH agent caps | capabilities in event data |

## TBC: Backward Compatibility

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TBC.1 | message events still work | send_message → SSE | Same format |
| TBC.2 | agent_online/offline still work | Register/disconnect | Same format + new fields |
| TBC.3 | connected_to/disconnected_from work | Add/remove edge | Same format |
| TBC.4 | task events still work | Create task → SSE | task_created event |
| TBC.5 | Old SSE clients (no Last-Event-ID) | Connect without header | Works as before |
