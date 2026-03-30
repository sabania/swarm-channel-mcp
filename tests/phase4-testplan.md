# Phase 4 Testplan — Agent Cards (Capabilities)

**Datum:** 2026-03-30
**Ziel:** Verify Capabilities Registration, Storage, Visibility, Discovery Filtering
**Vorbedingungen:** Service mit Agent Cards Support, 2+ Agents mit Capabilities

---

## TC: Capabilities Registration

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TC.1 | Register with capabilities | POST /agents {id,name,desc,capabilities:{skills:[...],languages:[...]}} | 200, capabilities stored |
| TC.2 | Register without capabilities | POST /agents {id,name,desc} | 200, backward compat |
| TC.3 | Capabilities structure | GET /agents/:id | capabilities object with expected fields |
| TC.4 | Empty capabilities | POST /agents {capabilities:{}} | 200, empty caps stored |
| TC.5 | Capabilities with many skills | POST /agents {capabilities:{skills:[20 items]}} | 200, all stored |

## TV: Capabilities Visibility

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TV.1 | Full View shows capabilities | GET /agents/:id | capabilities present |
| TV.2 | Public View hides capabilities | GET /topology | NO capabilities in nodes |
| TV.3 | Agent list hides capabilities | GET /agents | NO capabilities |
| TV.4 | Topology full=true shows capabilities | GET /topology?full=true + admin | capabilities present |
| TV.5 | Connections show capabilities | GET /agents/:id/connections | Check if caps visible or hidden |

## TU: Capabilities Update

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TU.1 | Update capabilities via PATCH | PATCH /agents/:id {capabilities:{...}} | 200, caps updated |
| TU.2 | Update caps via update_profile | update_profile MCP tool | capabilities changed |
| TU.3 | Partial update (add skill) | PATCH with new skill list | Merged or replaced |
| TU.4 | Remove capabilities | PATCH {capabilities:null} | Caps cleared |
| TU.5 | Re-register preserves capabilities | POST /agents (re-register existing) | Caps still there |

## TF: Discovery Filtering by Capabilities

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TF.1 | Filter by skill | GET /agents/:id/connections?skills=typescript | Only matching agents |
| TF.2 | Filter by multiple skills | connections?skills=typescript,react | Agents matching ANY/ALL |
| TF.3 | Filter no match | connections?skills=nonexistent | Empty list |
| TF.4 | Filter by language | connections?languages=python | Only matching |
| TF.5 | Discover with capability query | discover tool "typescript development" | Matched by caps + description |
| TF.6 | Filter case insensitive | connections?skills=TypeScript | Same as lowercase |

## TBC: Backward Compatibility

| # | Test | Methode | Erwartung |
|---|------|---------|-----------|
| TBC.1 | Old agents (no caps) still work | Register without capabilities | Same behavior |
| TBC.2 | Old agents appear in discovery | connections query | Old agents still listed |
| TBC.3 | Tasks still work | POST /tasks | Same behavior as Phase 3 |
| TBC.4 | Phase 1 test suite | bash tests/phase1-tests.sh | Still passes |
| TBC.5 | Messages still work | POST /messages | Same behavior |
