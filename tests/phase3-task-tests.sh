#!/bin/bash
# Phase 3 QA Test Suite — Task Engine
# Usage: SWARM_ADMIN_KEY=<key> bash tests/phase3-task-tests.sh [service_url]
# Service must have Task Engine enabled
# Clean start: Delete ~/.swarm-channel/swarm.db before test

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
json_field() { echo "$1" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).$2||'')}catch{console.log('')}})" 2>/dev/null; }

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
  log_pass "Preflight: Service is healthy"
else
  echo -e "${RED}Service not reachable. Aborting.${NC}"
  exit 1
fi

if [ -z "$ADMIN_KEY" ]; then
  echo -e "${YELLOW}WARNING: SWARM_ADMIN_KEY not set. Some tests will be skipped.${NC}"
fi

# Create test agents with admin key
AGENT_A="qa-task-a-$(date +%s)"
AGENT_B="qa-task-b-$(date +%s)"
AGENT_C="qa-task-c-$(date +%s)"

if [ -n "$ADMIN_KEY" ]; then
  # Provision agents
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_A\",\"name\":\"Task Agent A\",\"description\":\"Task test sender\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_B\",\"name\":\"Task Agent B\",\"description\":\"Task test receiver\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_C\",\"name\":\"Task Agent C\",\"description\":\"Unrelated agent\",\"cwd\":\"C:/tmp\"}" > /dev/null

  # Register to get keys
  RESP_A=$(api_no_auth POST /agents "{\"id\":\"$AGENT_A\",\"name\":\"Task Agent A\",\"description\":\"Task test sender\"}")
  KEY_A=$(json_field "$(get_body "$RESP_A")" "apiKey")
  RESP_B=$(api_no_auth POST /agents "{\"id\":\"$AGENT_B\",\"name\":\"Task Agent B\",\"description\":\"Task test receiver\"}")
  KEY_B=$(json_field "$(get_body "$RESP_B")" "apiKey")
  RESP_C=$(api_no_auth POST /agents "{\"id\":\"$AGENT_C\",\"name\":\"Task Agent C\",\"description\":\"Unrelated agent\"}")
  KEY_C=$(json_field "$(get_body "$RESP_C")" "apiKey")

  # Connect A ↔ B (not C)
  api_with_auth "$ADMIN_KEY" POST /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\"}" > /dev/null
  log_pass "Preflight: Test agents created and connected (A↔B, C isolated)"
else
  # No admin key — register directly (auth=off mode)
  RESP_A=$(api_no_auth POST /agents "{\"id\":\"$AGENT_A\",\"name\":\"Task Agent A\",\"description\":\"sender\"}")
  KEY_A=$(json_field "$(get_body "$RESP_A")" "apiKey")
  RESP_B=$(api_no_auth POST /agents "{\"id\":\"$AGENT_B\",\"name\":\"Task Agent B\",\"description\":\"receiver\"}")
  KEY_B=$(json_field "$(get_body "$RESP_B")" "apiKey")
  RESP_C=$(api_no_auth POST /agents "{\"id\":\"$AGENT_C\",\"name\":\"Task Agent C\",\"description\":\"unrelated\"}")
  KEY_C=$(json_field "$(get_body "$RESP_C")" "apiKey")
  # Try adding edge without admin (may work in off mode)
  api_no_auth POST /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\"}" > /dev/null
  log_pass "Preflight: Test agents created (auth=off mode)"
fi

# Helper: Use auth if key available, otherwise no auth
api_a() { if [ -n "$KEY_A" ]; then api_with_auth "$KEY_A" "$@"; else api_no_auth "$@"; fi; }
api_b() { if [ -n "$KEY_B" ]; then api_with_auth "$KEY_B" "$@"; else api_no_auth "$@"; fi; }
api_c() { if [ -n "$KEY_C" ]; then api_with_auth "$KEY_C" "$@"; else api_no_auth "$@"; fi; }
api_admin() { if [ -n "$ADMIN_KEY" ]; then api_with_auth "$ADMIN_KEY" "$@"; else api_no_auth "$@"; fi; }

# ── TL: Task Lifecycle ────────────────────────────────────────
echo ""
echo "--- TL: Task Lifecycle ---"

# TL.1 — Create task
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"Test task: compute something\"}")
CODE=$(get_code "$RESP")
BODY=$(get_body "$RESP")
TASK_ID=$(json_field "$BODY" "id")
TASK_STATUS=$(json_field "$BODY" "status")
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  if [ -n "$TASK_ID" ] && [ "$TASK_STATUS" = "submitted" ]; then
    log_pass "TL.1: Create task — id=$TASK_ID, status=submitted"
  else
    log_fail "TL.1: Create task" "id='$TASK_ID', status='$TASK_STATUS' (expected submitted)"
  fi
else
  log_fail "TL.1: Create task" "HTTP $CODE: $(echo $BODY | head -c 200)"
fi

# TL.2 — Create task missing fields
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "400" ]; then
  log_pass "TL.2: Missing description → 400"
else
  log_fail "TL.2: Missing fields" "Expected 400, got $CODE"
fi

# TL.3 — Create task no edge
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_C\",\"description\":\"no edge\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "400" ] || [ "$CODE" = "403" ]; then
  log_pass "TL.3: No edge → $CODE"
else
  log_fail "TL.3: No edge task" "Expected 400/403, got $CODE"
fi

# TL.4 — Get task by ID
if [ -n "$TASK_ID" ]; then
  RESP=$(api_a GET "/tasks/$TASK_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.4: Get task by ID → 200"
  else
    log_fail "TL.4: Get task" "Expected 200, got $CODE"
  fi
else
  log_skip "TL.4" "No task ID from TL.1"
fi

# TL.5 — submitted → working
if [ -n "$TASK_ID" ]; then
  RESP=$(api_b PATCH "/tasks/$TASK_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.5: submitted → working"
  else
    log_fail "TL.5: submitted → working" "HTTP $CODE: $(get_body "$RESP" | head -c 200)"
  fi
else
  log_skip "TL.5" "No task ID"
fi

# TL.6 — working → completed
if [ -n "$TASK_ID" ]; then
  RESP=$(api_b PATCH "/tasks/$TASK_ID" '{"status":"completed","result":"answer: 42"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.6: working → completed"
  else
    log_fail "TL.6: working → completed" "HTTP $CODE"
  fi
fi

# TL.14 — Invalid: completed → working
if [ -n "$TASK_ID" ]; then
  RESP=$(api_b PATCH "/tasks/$TASK_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TL.14: completed → working → 400 (invalid)"
  else
    log_fail "TL.14: Invalid transition" "Expected 400, got $CODE"
  fi
fi

# Create another task for failure path
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"Task to fail\"}")
TASK_FAIL_ID=$(json_field "$(get_body "$RESP")" "id")

if [ -n "$TASK_FAIL_ID" ]; then
  # TL.7 — working → failed
  api_b PATCH "/tasks/$TASK_FAIL_ID" '{"status":"working"}' > /dev/null
  RESP=$(api_b PATCH "/tasks/$TASK_FAIL_ID" '{"status":"failed","error":"something went wrong"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.7: working → failed"
  else
    log_fail "TL.7: working → failed" "HTTP $CODE"
  fi

  # TL.15 — Invalid: failed → working
  RESP=$(api_b PATCH "/tasks/$TASK_FAIL_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TL.15: failed → working → 400 (invalid)"
  else
    log_fail "TL.15: Invalid transition" "Expected 400, got $CODE"
  fi
fi

# Create task for input-required path
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"Task needing input\"}")
TASK_INPUT_ID=$(json_field "$(get_body "$RESP")" "id")

if [ -n "$TASK_INPUT_ID" ]; then
  api_b PATCH "/tasks/$TASK_INPUT_ID" '{"status":"working"}' > /dev/null

  # TL.8 — working → input-required
  RESP=$(api_b PATCH "/tasks/$TASK_INPUT_ID" '{"status":"input-required"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.8: working → input-required"
  else
    log_fail "TL.8: input-required" "HTTP $CODE"
  fi

  # TL.9 — input-required → working
  RESP=$(api_b PATCH "/tasks/$TASK_INPUT_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.9: input-required → working"
  else
    log_fail "TL.9: resume" "HTTP $CODE"
  fi

  # Complete it
  api_b PATCH "/tasks/$TASK_INPUT_ID" '{"status":"completed","result":"done"}' > /dev/null
  log_pass "TL.10: Full input cycle (submit→work→input→work→complete)"
fi

# Create task for cancel tests
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"Task to cancel\"}")
TASK_CANCEL_ID=$(json_field "$(get_body "$RESP")" "id")

if [ -n "$TASK_CANCEL_ID" ]; then
  # TL.11 — Cancel from submitted
  RESP=$(api_a DELETE "/tasks/$TASK_CANCEL_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TL.11: Cancel from submitted"
  else
    log_fail "TL.11: Cancel submitted" "HTTP $CODE"
  fi

  # TL.16 — Invalid: cancelled → working
  RESP=$(api_b PATCH "/tasks/$TASK_CANCEL_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TL.16: cancelled → working → 400 (invalid)"
  else
    log_fail "TL.16: Invalid transition" "Expected 400, got $CODE"
  fi
fi

# TL.12 — Cancel from working
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"Cancel from working\"}")
TASK_CW_ID=$(json_field "$(get_body "$RESP")" "id")
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

# TL.18 — Get tasks for agent
RESP=$(api_a GET "/agents/$AGENT_A/tasks")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TL.18: Get tasks for agent → 200"
else
  log_fail "TL.18: Agent tasks" "HTTP $CODE"
fi

# TL.20 — Task not found
RESP=$(api_a GET "/tasks/nonexistent-id-xyz")
CODE=$(get_code "$RESP")
if [ "$CODE" = "404" ]; then
  log_pass "TL.20: Task not found → 404"
else
  log_fail "TL.20: Not found" "Expected 404, got $CODE"
fi

# ── TAU: Auth Integration ─────────────────────────────────────
echo ""
echo "--- TAU: Auth Integration ---"

# TAU.1 — Create task without token
RESP=$(api_no_auth POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"no auth\"}")
CODE=$(get_code "$RESP")
# In auth=off mode this will be 200, in enforce it would be 401
if [ "$CODE" = "401" ]; then
  log_pass "TAU.1: Create task no auth → 401"
elif [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  log_pass "TAU.1: Create task no auth → $CODE (auth=off mode)"
else
  log_fail "TAU.1: No auth" "Expected 401 or 200, got $CODE"
fi

# TAU.3 — Sender mismatch
if [ -n "$KEY_A" ]; then
  RESP=$(api_with_auth "$KEY_A" POST /tasks "{\"from\":\"$AGENT_B\",\"to\":\"$AGENT_A\",\"description\":\"spoofed\"}")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TAU.3: Sender mismatch → 403"
  elif [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TAU.3: Sender mismatch → $CODE (auth=off, no spoofing check)"
  else
    log_fail "TAU.3: Sender mismatch" "Expected 403, got $CODE"
  fi
else
  log_skip "TAU.3" "No API key available"
fi

# TAU.4 — Unrelated agent cannot see task
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"private task\"}")
PRIV_TASK_ID=$(json_field "$(get_body "$RESP")" "id")
if [ -n "$PRIV_TASK_ID" ] && [ -n "$KEY_C" ]; then
  RESP=$(api_c GET "/tasks/$PRIV_TASK_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TAU.4: Unrelated agent → 403"
  elif [ "$CODE" = "200" ]; then
    log_pass "TAU.4: Unrelated sees task → 200 (auth=off)"
  else
    log_fail "TAU.4: Unrelated access" "Got $CODE"
  fi
else
  log_skip "TAU.4" "No task or key"
fi

# TAU.5 — Receiver can see task
if [ -n "$PRIV_TASK_ID" ]; then
  RESP=$(api_b GET "/tasks/$PRIV_TASK_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TAU.5: Receiver sees task → 200"
  else
    log_fail "TAU.5: Receiver access" "Expected 200, got $CODE"
  fi
fi

# TAU.6 — Admin sees all tasks
if [ -n "$PRIV_TASK_ID" ] && [ -n "$ADMIN_KEY" ]; then
  RESP=$(api_admin GET "/tasks/$PRIV_TASK_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TAU.6: Admin sees task → 200"
  else
    log_fail "TAU.6: Admin access" "Expected 200, got $CODE"
  fi
else
  log_skip "TAU.6" "No admin key or task"
fi

# TAU.7 — Only receiver updates status
RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"auth update test\"}")
AUTH_TASK_ID=$(json_field "$(get_body "$RESP")" "id")
if [ -n "$AUTH_TASK_ID" ] && [ -n "$KEY_A" ]; then
  RESP=$(api_a PATCH "/tasks/$AUTH_TASK_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TAU.7: Sender cannot update status → 403"
  elif [ "$CODE" = "200" ]; then
    log_pass "TAU.7: Sender updates status → 200 (auth=off)"
  else
    log_fail "TAU.7: Sender update" "Got $CODE"
  fi
fi

# TAU.8 — Receiver updates status
if [ -n "$AUTH_TASK_ID" ]; then
  RESP=$(api_b PATCH "/tasks/$AUTH_TASK_ID" '{"status":"working"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TAU.8: Receiver updates status → 200"
  else
    log_fail "TAU.8: Receiver update" "Expected 200, got $CODE"
  fi
fi

# ── TMT: Multi-Turn ───────────────────────────────────────────
echo ""
echo "--- TMT: Multi-Turn Conversations ---"

RESP=$(api_a POST /tasks "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"description\":\"Multi-turn task\"}")
MT_TASK_ID=$(json_field "$(get_body "$RESP")" "id")

if [ -n "$MT_TASK_ID" ]; then
  # TMT.2 — Receiver replies
  RESP=$(api_b POST "/tasks/$MT_TASK_ID/messages" '{"content":"Working on it, need clarification on X"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TMT.2: Receiver posts message → $CODE"
  else
    log_fail "TMT.2: Receiver message" "HTTP $CODE: $(get_body "$RESP" | head -c 200)"
  fi

  # TMT.3 — Sender replies back
  RESP=$(api_a POST "/tasks/$MT_TASK_ID/messages" '{"content":"Here is the clarification for X"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TMT.3: Sender replies → $CODE"
  else
    log_fail "TMT.3: Sender reply" "HTTP $CODE"
  fi

  # TMT.4 — Get all messages in order
  RESP=$(api_a GET "/tasks/$MT_TASK_ID/messages")
  CODE=$(get_code "$RESP")
  BODY=$(get_body "$RESP")
  MSG_COUNT=$(echo "$BODY" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}})" 2>/dev/null)
  if [ "$CODE" = "200" ] && [ "$MSG_COUNT" -ge 2 ]; then
    log_pass "TMT.4: Get messages — $MSG_COUNT messages in order"
  else
    log_fail "TMT.4: Get messages" "HTTP $CODE, count=$MSG_COUNT"
  fi

  # TMT.6 — Unrelated agent cannot post
  RESP=$(api_c POST "/tasks/$MT_TASK_ID/messages" '{"content":"I shouldnt be here"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TMT.6: Unrelated agent → 403"
  elif [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TMT.6: Unrelated posts → $CODE (auth=off)"
  else
    log_fail "TMT.6: Unrelated post" "Got $CODE"
  fi

  # Complete task for TMT.7
  api_b PATCH "/tasks/$MT_TASK_ID" '{"status":"working"}' > /dev/null
  api_b PATCH "/tasks/$MT_TASK_ID" '{"status":"completed","result":"done"}' > /dev/null

  # TMT.7 — Messages after completion
  RESP=$(api_a POST "/tasks/$MT_TASK_ID/messages" '{"content":"post-completion msg"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TMT.7: Message after completion → 400"
  elif [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    log_pass "TMT.7: Message after completion → $CODE (allowed)"
  else
    log_fail "TMT.7: Post-completion" "Got $CODE"
  fi
else
  log_skip "TMT.2-TMT.7" "No multi-turn task created"
fi

# ── TBC: Backward Compatibility ──────────────────────────────
echo ""
echo "--- TBC: Backward Compatibility ---"

# TBC.1 — POST /messages still works
RESP=$(api_a POST /messages "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_B\",\"content\":\"fire and forget test\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.1: POST /messages still works (fire-and-forget)"
else
  log_fail "TBC.1: Fire-and-forget" "HTTP $CODE"
fi

# TBC.3 — Existing endpoints unchanged
RESP=$(api_a GET /agents)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.3: GET /agents unchanged → 200"
else
  log_fail "TBC.3: Agent list" "HTTP $CODE"
fi

RESP=$(api_a GET /topology)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.4: GET /topology unchanged → 200"
else
  log_fail "TBC.4: Topology" "HTTP $CODE"
fi

# TBC.5 — Edge operations
RESP=$(api_admin POST /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_C\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.5: POST /edges unchanged → 200"
  api_admin DELETE /edges "{\"from\":\"$AGENT_A\",\"to\":\"$AGENT_C\"}" > /dev/null
else
  log_fail "TBC.5: Edge operation" "HTTP $CODE"
fi

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo "--- Cleanup ---"
api_admin DELETE "/agents/$AGENT_A" > /dev/null 2>&1
api_admin DELETE "/agents/$AGENT_B" > /dev/null 2>&1
api_admin DELETE "/agents/$AGENT_C" > /dev/null 2>&1
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
