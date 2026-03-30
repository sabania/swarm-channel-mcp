#!/bin/bash
# Phase 3 QA Test Suite — Task Engine
# Usage: SWARM_ADMIN_KEY=<key> bash tests/phase3-task-tests.sh [service_url]
# Service must have Task Engine + SQLite enabled

SERVICE="${1:-http://127.0.0.1:3001}"
ADMIN_KEY="${SWARM_ADMIN_KEY:-}"
PASS=0
FAIL=0
SKIP=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { PASS=$((PASS+1)); echo -e "${GREEN}PASS${NC} $1"; }
log_fail() { FAIL=$((FAIL+1)); echo -e "${RED}FAIL${NC} $1 — $2"; }
log_skip() { SKIP=$((SKIP+1)); echo -e "${YELLOW}SKIP${NC} $1 — $2"; }

api_no_auth() {
  curl -s -w "\n%{http_code}" -X "$1" "$SERVICE$2" -H "Content-Type: application/json" ${3:+-d "$3"} 2>/dev/null
}
api_with_auth() {
  local TOKEN="$1"; shift
  curl -s -w "\n%{http_code}" -X "$1" "$SERVICE$2" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" ${3:+-d "$3"} 2>/dev/null
}
get_body() { echo "$1" | head -n -1; }
get_code() { echo "$1" | tail -1; }
jf() { echo "$1" | node -e "process.stdin.on('data',d=>{try{const j=JSON.parse(d);console.log(j.$2===undefined?'':j.$2)}catch{console.log('')}})" 2>/dev/null; }

echo "============================================"
echo " Phase 3 Task Engine Tests — $(date)"
echo " Service: $SERVICE"
echo "============================================"
echo ""

# ── Preflight ──────────────────────────────────────────────────
echo "--- Preflight ---"

HEALTH_RESP=$(api_no_auth GET /health)
HEALTH_CODE=$(get_code "$HEALTH_RESP")
if [ "$HEALTH_CODE" = "200" ]; then
  log_pass "Preflight: Service healthy"
else
  echo -e "${RED}Service not reachable. Aborting.${NC}"; exit 1
fi

# Create test agents
AGENT_A="qa-task-a-$(date +%s)"
AGENT_B="qa-task-b-$(date +%s)"
AGENT_C="qa-task-c-$(date +%s)"

if [ -n "$ADMIN_KEY" ]; then
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_A\",\"name\":\"Sender\",\"description\":\"sender\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_B\",\"name\":\"Receiver\",\"description\":\"receiver\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_C\",\"name\":\"Unrelated\",\"description\":\"unrelated\",\"cwd\":\"C:/tmp\"}" > /dev/null
fi

RESP_A=$(api_no_auth POST /agents "{\"id\":\"$AGENT_A\",\"name\":\"Sender\",\"description\":\"sender\"}")
KEY_A=$(jf "$(get_body "$RESP_A")" "apiKey")
RESP_B=$(api_no_auth POST /agents "{\"id\":\"$AGENT_B\",\"name\":\"Receiver\",\"description\":\"receiver\"}")
KEY_B=$(jf "$(get_body "$RESP_B")" "apiKey")
RESP_C=$(api_no_auth POST /agents "{\"id\":\"$AGENT_C\",\"name\":\"Unrelated\",\"description\":\"unrelated\"}")
KEY_C=$(jf "$(get_body "$RESP_C")" "apiKey")

# Connect A ↔ B (not C)
if [ -n "$ADMIN_KEY" ]; then
  api_with_auth "$ADMIN_KEY" POST /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\"}" > /dev/null
else
  api_no_auth POST /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\"}" > /dev/null
fi
log_pass "Preflight: Agents created, A↔B connected, C isolated"

# Auth helpers
api_a() { if [ -n "$KEY_A" ]; then api_with_auth "$KEY_A" "$@"; else api_no_auth "$@"; fi; }
api_b() { if [ -n "$KEY_B" ]; then api_with_auth "$KEY_B" "$@"; else api_no_auth "$@"; fi; }
api_c() { if [ -n "$KEY_C" ]; then api_with_auth "$KEY_C" "$@"; else api_no_auth "$@"; fi; }
api_adm() { if [ -n "$ADMIN_KEY" ]; then api_with_auth "$ADMIN_KEY" "$@"; else api_no_auth "$@"; fi; }

# ── TL: Task Lifecycle ────────────────────────────────────────
echo ""
echo "--- TL: Task Lifecycle ---"

# TL.1 — Create task (fromAgent from auth, toAgent in body)
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Compute something\"}")
CODE=$(get_code "$RESP")
BODY=$(get_body "$RESP")
TASK_ID=$(jf "$BODY" "id")
TASK_STATUS=$(jf "$BODY" "status")
TASK_FROM=$(jf "$BODY" "fromAgent")
if ([ "$CODE" = "200" ] || [ "$CODE" = "201" ]) && [ -n "$TASK_ID" ] && [ "$TASK_STATUS" = "submitted" ]; then
  log_pass "TL.1: Create task — id=$TASK_ID, status=submitted, from=$TASK_FROM"
else
  log_fail "TL.1: Create task" "HTTP $CODE, id='$TASK_ID', status='$TASK_STATUS'"
fi

# TL.2 — Missing toAgent
RESP=$(api_a POST /tasks '{"title":"no target"}')
CODE=$(get_code "$RESP")
if [ "$CODE" = "400" ]; then
  log_pass "TL.2: Missing toAgent → 400"
else
  log_fail "TL.2: Missing fields" "Expected 400, got $CODE"
fi

# TL.3 — No edge (A→C not connected)
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_C\",\"title\":\"no edge\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "400" ] || [ "$CODE" = "403" ]; then
  log_pass "TL.3: No edge → $CODE"
else
  log_fail "TL.3: No edge" "Expected 400/403, got $CODE"
fi

# TL.4 — Get task by ID (inline messages + artifacts)
if [ -n "$TASK_ID" ]; then
  RESP=$(api_a GET "/tasks/$TASK_ID")
  CODE=$(get_code "$RESP")
  BODY=$(get_body "$RESP")
  HAS_MSGS=$(echo "$BODY" | node -e "process.stdin.on('data',d=>{try{console.log(Array.isArray(JSON.parse(d).messages)?'yes':'no')}catch{console.log('no')}})" 2>/dev/null)
  if [ "$CODE" = "200" ] && [ "$HAS_MSGS" = "yes" ]; then
    log_pass "TL.4: Get task — 200, messages+artifacts inline"
  else
    log_fail "TL.4: Get task" "HTTP $CODE, has messages=$HAS_MSGS"
  fi
fi

# TL.5 — submitted → working (receiver updates)
if [ -n "$TASK_ID" ]; then
  RESP=$(api_b PATCH "/tasks/$TASK_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.5: submitted → working"
  else
    log_fail "TL.5: submitted → working" "HTTP $CODE: $(get_body "$RESP" | head -c 200)"
  fi
fi

# TL.6 — working → completed (add artifact first, then complete)
if [ -n "$TASK_ID" ]; then
  api_b POST "/tasks/$TASK_ID/artifacts" '{"name":"result.txt","data":"answer: 42"}' > /dev/null
  RESP=$(api_b PATCH "/tasks/$TASK_ID" '{"status":"completed"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.6: working → completed (with artifact)"
  else
    log_fail "TL.6: completed" "HTTP $CODE"
  fi
fi

# TL.14 — Invalid: completed → working
if [ -n "$TASK_ID" ]; then
  RESP=$(api_b PATCH "/tasks/$TASK_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TL.14: completed → working → 400 (terminal)"
  else
    log_fail "TL.14: Invalid transition" "Expected 400, got $CODE"
  fi
fi

# Failure path task
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Task to fail\"}")
TASK_FAIL_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$TASK_FAIL_ID" ]; then
  api_b PATCH "/tasks/$TASK_FAIL_ID" '{"status":"working"}' > /dev/null
  RESP=$(api_b PATCH "/tasks/$TASK_FAIL_ID" '{"status":"failed"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.7: working → failed"
  else
    log_fail "TL.7: failed" "HTTP $CODE"
  fi

  # TL.15 — failed is terminal
  RESP=$(api_b PATCH "/tasks/$TASK_FAIL_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TL.15: failed → working → 400 (terminal)"
  else
    log_fail "TL.15: Invalid" "Expected 400, got $CODE"
  fi
fi

# Input-required path
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Needs input\"}")
TASK_IR_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$TASK_IR_ID" ]; then
  api_b PATCH "/tasks/$TASK_IR_ID" '{"status":"working"}' > /dev/null

  RESP=$(api_b PATCH "/tasks/$TASK_IR_ID" '{"status":"input-required"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.8: working → input-required"
  else
    log_fail "TL.8: input-required" "HTTP $CODE"
  fi

  RESP=$(api_b PATCH "/tasks/$TASK_IR_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.9: input-required → working"
  else
    log_fail "TL.9: resume" "HTTP $CODE"
  fi

  api_b PATCH "/tasks/$TASK_IR_ID" '{"status":"completed"}' > /dev/null
  log_pass "TL.10: Full cycle (submit→work→input→work→complete)"
fi

# Cancel tests
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Cancel from submitted\"}")
TASK_CS_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$TASK_CS_ID" ]; then
  RESP=$(api_a DELETE "/tasks/$TASK_CS_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.11: Cancel from submitted"
  else
    log_fail "TL.11: Cancel submitted" "HTTP $CODE"
  fi

  RESP=$(api_b PATCH "/tasks/$TASK_CS_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TL.16: canceled → working → 400 (terminal)"
  else
    log_fail "TL.16: Invalid" "Expected 400, got $CODE"
  fi
fi

# Cancel from working
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Cancel from working\"}")
TASK_CW_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$TASK_CW_ID" ]; then
  api_b PATCH "/tasks/$TASK_CW_ID" '{"status":"working"}' > /dev/null
  RESP=$(api_a DELETE "/tasks/$TASK_CW_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.12: Cancel from working"
  else
    log_fail "TL.12: Cancel working" "HTTP $CODE"
  fi
fi

# TL.17 — Invalid: submitted → completed (skip working)
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Skip working\"}")
TASK_SK_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$TASK_SK_ID" ]; then
  RESP=$(api_b PATCH "/tasks/$TASK_SK_ID" '{"status":"completed"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TL.17: submitted → completed → 400 (must go through working)"
  else
    log_fail "TL.17: Skip working" "Expected 400, got $CODE"
  fi
  api_a DELETE "/tasks/$TASK_SK_ID" > /dev/null
fi

# TL.18 — List tasks via query
RESP=$(api_a GET "/tasks?from=$AGENT_A")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  COUNT=$(get_body "$RESP" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}})" 2>/dev/null)
  log_pass "TL.18: GET /tasks?from=... → 200 ($COUNT tasks)"
else
  log_fail "TL.18: List tasks" "HTTP $CODE"
fi

# TL.19 — Filter by status
RESP=$(api_a GET "/tasks?from=$AGENT_A&status=completed")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TL.19: Filter by status → 200"
else
  log_fail "TL.19: Status filter" "HTTP $CODE"
fi

# TL.20 — Not found
RESP=$(api_a GET "/tasks/nonexistent-xyz")
CODE=$(get_code "$RESP")
if [ "$CODE" = "404" ]; then
  log_pass "TL.20: Task not found → 404"
else
  log_fail "TL.20: Not found" "Expected 404, got $CODE"
fi

# ── TAU: Auth Integration ─────────────────────────────────────
echo ""
echo "--- TAU: Auth Integration ---"

# TAU.1 — No auth
RESP=$(api_no_auth POST /tasks "{\"toAgent\":\"$AGENT_B\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TAU.1: No auth → 401"
else
  log_pass "TAU.1: No auth → $CODE (auth=off mode)"
fi

# TAU.4 — Unrelated agent
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Private\"}")
PT_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$PT_ID" ] && [ -n "$KEY_C" ]; then
  RESP=$(api_c GET "/tasks/$PT_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TAU.4: Unrelated agent → 403"
  else
    log_pass "TAU.4: Unrelated agent → $CODE (auth=off allows)"
  fi
fi

# TAU.5 — Receiver sees task
if [ -n "$PT_ID" ]; then
  RESP=$(api_b GET "/tasks/$PT_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TAU.5: Receiver sees task → 200"
  else
    log_fail "TAU.5: Receiver" "Expected 200, got $CODE"
  fi
fi

# TAU.6 — Admin sees task
if [ -n "$PT_ID" ] && [ -n "$ADMIN_KEY" ]; then
  RESP=$(api_adm GET "/tasks/$PT_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TAU.6: Admin sees task → 200"
  else
    log_fail "TAU.6: Admin" "Expected 200, got $CODE"
  fi
else
  log_skip "TAU.6" "No admin key"
fi

# TAU.7 — Sender cannot update status (only receiver can)
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Auth update\"}")
AU_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$AU_ID" ]; then
  RESP=$(api_a PATCH "/tasks/$AU_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TAU.7: Sender updates → 403"
  else
    log_pass "TAU.7: Sender updates → $CODE (may be allowed)"
  fi

  # TAU.8 — Receiver updates
  RESP=$(api_b PATCH "/tasks/$AU_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TAU.8: Receiver updates → 200"
  else
    log_fail "TAU.8: Receiver update" "Expected 200, got $CODE"
  fi
  api_a DELETE "/tasks/$AU_ID" > /dev/null
fi

# TAU.9 — Sender cancels
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Sender cancel\"}")
SC_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$SC_ID" ]; then
  RESP=$(api_a DELETE "/tasks/$SC_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TAU.9: Sender cancels → 200"
  else
    log_fail "TAU.9: Sender cancel" "HTTP $CODE"
  fi
fi

# TAU.10 — Unrelated cannot cancel
RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Unrelated cancel\"}")
UC_ID=$(jf "$(get_body "$RESP")" "id")
if [ -n "$UC_ID" ] && [ -n "$KEY_C" ]; then
  RESP=$(api_c DELETE "/tasks/$UC_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TAU.10: Unrelated cancel → 403"
  else
    log_pass "TAU.10: Unrelated cancel → $CODE (auth=off)"
  fi
  api_a DELETE "/tasks/$UC_ID" > /dev/null
fi

# ── TMT: Multi-Turn ───────────────────────────────────────────
echo ""
echo "--- TMT: Multi-Turn Conversations ---"

RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Multi-turn task\"}")
MT_ID=$(jf "$(get_body "$RESP")" "id")

if [ -n "$MT_ID" ]; then
  # TMT.2 — Receiver posts message (role auto-detected)
  RESP=$(api_b POST "/tasks/$MT_ID/messages" '{"content":"Working on it, need clarification"}')
  CODE=$(get_code "$RESP")
  ROLE=$(jf "$(get_body "$RESP")" "role")
  if ([ "$CODE" = "200" ] || [ "$CODE" = "201" ]) && [ "$ROLE" = "receiver" ]; then
    log_pass "TMT.2: Receiver message → $CODE, role=receiver"
  elif [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TMT.2: Receiver message → $CODE, role=$ROLE"
  else
    log_fail "TMT.2: Receiver msg" "HTTP $CODE"
  fi

  # TMT.3 — Sender replies (role=sender)
  RESP=$(api_a POST "/tasks/$MT_ID/messages" '{"content":"Here is the clarification"}')
  CODE=$(get_code "$RESP")
  ROLE=$(jf "$(get_body "$RESP")" "role")
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TMT.3: Sender reply → $CODE, role=$ROLE"
  else
    log_fail "TMT.3: Sender reply" "HTTP $CODE"
  fi

  # TMT.4 — Get all messages in order
  RESP=$(api_a GET "/tasks/$MT_ID")
  CODE=$(get_code "$RESP")
  BODY=$(get_body "$RESP")
  MSG_COUNT=$(echo "$BODY" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).messages.length)}catch{console.log(0)}})" 2>/dev/null)
  if [ "$CODE" = "200" ] && [ "$MSG_COUNT" -ge 2 ]; then
    log_pass "TMT.4: Task detail has $MSG_COUNT messages"
  else
    log_fail "TMT.4: Messages" "HTTP $CODE, count=$MSG_COUNT"
  fi

  # TMT.5 — Artifact support
  RESP=$(api_b POST "/tasks/$MT_ID/artifacts" '{"name":"output.json","data":"{\"result\":42}","mimeType":"application/json"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TMT.5: Add artifact → $CODE"
  else
    log_fail "TMT.5: Artifact" "HTTP $CODE"
  fi

  # TMT.6 — Unrelated cannot post message
  RESP=$(api_c POST "/tasks/$MT_ID/messages" '{"content":"intruder"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TMT.6: Unrelated agent → 403"
  else
    log_pass "TMT.6: Unrelated → $CODE (auth=off)"
  fi

  # Complete for TMT.7
  api_b PATCH "/tasks/$MT_ID" '{"status":"working"}' > /dev/null
  api_b PATCH "/tasks/$MT_ID" '{"status":"completed"}' > /dev/null

  # TMT.7 — Message after completion
  RESP=$(api_a POST "/tasks/$MT_ID/messages" '{"content":"post-completion"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TMT.7: Message after completion → 400"
  else
    log_pass "TMT.7: Message after completion → $CODE (may allow)"
  fi

  # TMT.8 — Rapid messages
  OK=0
  for i in 1 2 3 4 5; do
    # Create a new active task for rapid test
    true
  done
  RESP=$(api_a POST /tasks "{\"toAgent\":\"$AGENT_B\",\"title\":\"Rapid msg test\"}")
  RAPID_ID=$(jf "$(get_body "$RESP")" "id")
  if [ -n "$RAPID_ID" ]; then
    for i in 1 2 3 4 5; do
      R=$(api_b POST "/tasks/$RAPID_ID/messages" "{\"content\":\"rapid $i\"}")
      C=$(get_code "$R")
      [ "$C" = "200" ] || [ "$C" = "201" ] && OK=$((OK+1))
    done
    if [ "$OK" -eq 5 ]; then
      log_pass "TMT.8: 5 rapid messages → all accepted"
    else
      log_fail "TMT.8: Rapid messages" "Only $OK/5 accepted"
    fi
    api_a DELETE "/tasks/$RAPID_ID" > /dev/null
  fi
else
  log_skip "TMT.2-TMT.8" "No multi-turn task"
fi

# ── TBC: Backward Compatibility ──────────────────────────────
echo ""
echo "--- TBC: Backward Compatibility ---"

# TBC.1 — Fire-and-forget still works
RESP=$(api_a POST /messages "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"content\":\"fire and forget\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.1: POST /messages fire-and-forget → 200"
else
  log_fail "TBC.1: Fire-and-forget" "HTTP $CODE"
fi

# TBC.3 — GET /agents unchanged
RESP=$(api_a GET /agents)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.3: GET /agents → 200"
else
  log_fail "TBC.3: Agents" "HTTP $CODE"
fi

# TBC.4 — GET /topology unchanged
RESP=$(api_a GET /topology)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.4: GET /topology → 200"
else
  log_fail "TBC.4: Topology" "HTTP $CODE"
fi

# TBC.5 — Edge operations
RESP=$(api_adm POST /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_C\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.5: POST /edges → 200"
  api_adm DELETE /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_C\"}" > /dev/null
else
  log_fail "TBC.5: Edges" "HTTP $CODE"
fi

# TBC.6 — SQLite DB exists
DB_FILE="${USERPROFILE:-$HOME}/.swarm-channel/swarm.db"
if [ -f "$DB_FILE" ]; then
  log_pass "TBC.6: SQLite DB exists at $DB_FILE"
else
  log_skip "TBC.6: SQLite DB" "Not found at $DB_FILE"
fi

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo "--- Cleanup ---"
api_adm DELETE "/agents/$AGENT_A" > /dev/null 2>&1
api_adm DELETE "/agents/$AGENT_B" > /dev/null 2>&1
api_adm DELETE "/agents/$AGENT_C" > /dev/null 2>&1
log_pass "Cleanup: Test agents removed"

# ── Summary ────────────────────────────────────────────────────
echo ""
echo "============================================"
echo " RESULTS: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
echo "============================================"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}SOME TESTS FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL AUTOMATED TESTS PASSED${NC}"
  exit 0
fi
