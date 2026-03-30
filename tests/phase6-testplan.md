# Phase 6 Testplan — Observability

**Datum:** 2026-03-30
**Ziel:** Verify Metrics, Health Checks, Structured Logging, Request Logging
**Vorbedingungen:** Service mit Observability features

---

## TM: Metrics Endpoint (GET /metrics)

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TM.1 | Endpoint exists | GET /metrics | 200 OK |
| TM.2 | Has agents count | GET /metrics | agents.total, agents.online present |
| TM.3 | Has message stats | GET /metrics | messages.sent, messages.delivered present |
| TM.4 | Has task stats | GET /metrics | tasks.total, tasks by status |
| TM.5 | Has SSE stats | GET /metrics | sse.connections, sse.events present |
| TM.6 | Has uptime | GET /metrics | uptime > 0 |
| TM.7 | Values plausible | GET /metrics | online <= total, counts >= 0 |
| TM.8 | Metrics update after activity | Send msg → GET /metrics | Counter incremented |
| TM.9 | Metrics public (no auth needed) | GET /metrics without token | 200 (like /health) |

## TH: Health Endpoint (GET /health)

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TH.1 | Status field is "healthy" or "ok" | GET /health | status present |
| TH.2 | Has checks object | GET /health | checks.store, checks.database, checks.sse |
| TH.3 | Store check | GET /health | checks.store.status = "ok" |
| TH.4 | Database check (SQLite) | GET /health | checks.database.status = "ok" |
| TH.5 | SSE check | GET /health | checks.sse.status = "ok" |
| TH.6 | Has authMode | GET /health | authMode present |
| TH.7 | Has agent counts | GET /health | agents, totalAgents present |

## TL: Structured Logging

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TL.1 | JSON log format | Check service stdout | Each line is valid JSON |
| TL.2 | Log has level field | Check logs | level: "info"/"warn"/"error" |
| TL.3 | Log has timestamp | Check logs | ts or timestamp field |
| TL.4 | Log has message | Check logs | msg or message field |

## TR: Request Logging

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TR.1 | HTTP request logged | Send request → check logs | method, path, status in log |
| TR.2 | Duration logged | Check logs | duration or ms field |
| TR.3 | Status code logged | Check logs | Matches actual HTTP response |

## TBC: Backward Compatibility

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TBC.1 | Phase 1 tests pass | bash tests/phase1-tests.sh | All pass |
| TBC.2 | Messages still work | POST /messages | 200 |
| TBC.3 | Tasks still work | POST /tasks | 200/201 |
| TBC.4 | SSE still works | Connect SSE | Stream events |
| TBC.5 | Topology unchanged | GET /topology | Same structure |
