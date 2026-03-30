# Phase 3 Testplan — Task Engine

**Datum:** 2026-03-30
**Ziel:** Verify Task Lifecycle, Delivery Guarantee, Auth Integration, Multi-Turn, Backward Compat
**Vorbedingungen:**
- Service mit Task Engine gestartet
- Mindestens 2 Agents registriert mit Edge + API Keys
- Admin-Key verfügbar

---

## TL: Task Lifecycle

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TL.1 | Create task | POST /tasks {from, to, description} | 200, task with id, status=submitted |
| TL.2 | Create task missing fields | POST /tasks (no description) | 400 error |
| TL.3 | Create task no edge | POST /tasks between unconnected | 400/403 |
| TL.4 | Get task by ID | GET /tasks/:id | 200, full task |
| TL.5 | Happy path: submitted → working | PATCH /tasks/:id {status:"working"} | 200 |
| TL.6 | Happy path: working → completed | PATCH /tasks/:id {status:"completed", result:...} | 200 |
| TL.7 | Failure path: working → failed | PATCH /tasks/:id {status:"failed", error:...} | 200 |
| TL.8 | Input path: working → input-required | PATCH /tasks/:id {status:"input-required"} | 200 |
| TL.9 | Resume: input-required → working | PATCH /tasks/:id {status:"working"} | 200 |
| TL.10 | Full input cycle: submit → work → input → work → complete | Chained PATCHes | All transitions valid |
| TL.11 | Cancel from submitted | DELETE /tasks/:id | 200, status=cancelled |
| TL.12 | Cancel from working | DELETE /tasks/:id | 200, status=cancelled |
| TL.13 | Cancel from input-required | DELETE /tasks/:id | 200, status=cancelled |
| TL.14 | Invalid: completed → working | PATCH | 400 invalid transition |
| TL.15 | Invalid: failed → working | PATCH | 400 invalid transition |
| TL.16 | Invalid: cancelled → working | PATCH | 400 invalid transition |
| TL.17 | Invalid: submitted → completed (skip working) | PATCH | 400 invalid transition |
| TL.18 | Get tasks for agent | GET /agents/:id/tasks | Array of tasks |
| TL.19 | Filter by status | GET /agents/:id/tasks?status=submitted | Only matching tasks |
| TL.20 | Task not found | GET /tasks/nonexistent | 404 |

## TD: Delivery Guarantee

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TD2.1 | Task to offline agent created | POST /tasks to offline | 200, status=submitted, stored in DB |
| TD2.2 | Offline agent's tasks queryable | GET /agents/:id/tasks | Task visible |
| TD2.3 | Agent reconnects, receives task | SSE listen after connect | task_created event received |
| TD2.4 | Task survives service restart | Create → restart → GET | Task still exists |
| TD2.5 | Status update notifies creator | PATCH status → check creator SSE | task_updated event |
| TD2.6 | Multiple tasks queued for offline | Create 3 tasks → agent connects | All 3 received |

## TAU: Auth Integration

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TAU.1 | Create task without token | POST /tasks no auth | 401 |
| TAU.2 | Create task with valid token | POST /tasks + Bearer | 200 |
| TAU.3 | Sender mismatch | POST /tasks from=other + own token | 403 |
| TAU.4 | Only sender can see task | GET /tasks/:id with unrelated agent token | 403 |
| TAU.5 | Only receiver can see task | GET /tasks/:id with receiver token | 200 |
| TAU.6 | Admin sees all tasks | GET /tasks/:id with admin key | 200 |
| TAU.7 | Only receiver updates status | PATCH /tasks/:id with sender token | 403 |
| TAU.8 | Receiver updates status | PATCH /tasks/:id with receiver token | 200 |
| TAU.9 | Sender or admin cancels | DELETE /tasks/:id with sender token | 200 |
| TAU.10 | Unrelated agent cannot cancel | DELETE /tasks/:id with other token | 403 |

## TMT: Multi-Turn Conversations

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TMT.1 | Create task with initial message | POST /tasks {description, message} | Task + first message |
| TMT.2 | Receiver replies | POST /tasks/:id/messages {content} | Message added |
| TMT.3 | Sender replies back | POST /tasks/:id/messages {content} | Message added |
| TMT.4 | Get all messages | GET /tasks/:id/messages | All messages in order |
| TMT.5 | Messages have correct sender | GET /tasks/:id/messages | Each message has from field |
| TMT.6 | Only participants can post | POST /tasks/:id/messages with other token | 403 |
| TMT.7 | Messages after completion | POST /tasks/:id/messages on completed task | 400 |
| TMT.8 | Multiple rapid messages | 5x POST /tasks/:id/messages | All stored, correct order |

## TBC: Backward Compatibility

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TBC.1 | POST /messages still works (fire-and-forget) | curl POST /messages | Same behavior as Phase 1+2 |
| TBC.2 | Phase 1 test suite passes | bash tests/phase1-tests.sh | 33/33 PASS |
| TBC.3 | Existing endpoints unchanged | GET /agents, GET /topology, etc. | Same behavior |
| TBC.4 | SSE still delivers messages | send_message via MCP | Received via channel |
| TBC.5 | Edge operations unchanged | POST/DELETE /edges | Same behavior |
