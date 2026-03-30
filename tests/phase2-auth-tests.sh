#!/bin/bash
# Phase 2 QA Test Suite — Auth & Security
# Run with: SWARM_ADMIN_KEY=<key> bash tests/phase2-auth-tests.sh [service_url]
# Service must be running with SWARM_AUTH_MODE=enforce
#
# Admin key: Logged on first service start. Pass via env:
#   SWARM_ADMIN_KEY=<key> bash tests/phase2-auth-tests.sh
# Clean start: Delete ~/.swarm-channel/admin.key and keys.json before test

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

# API helpers
api_no_auth() {
  curl -s -w "\n%{http_code}" -X "$1" "$SERVICE$2" -H "Content-Type: application/json" ${3:+-d "$3"} 2>/dev/null
}

api_with_auth() {
  local TOKEN="$1"; shift
  curl -s -w "\n%{http_code}" -X "$1" "$SERVICE$2" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" ${3:+-d "$3"} 2>/dev/null
}

get_body() { echo "$1" | head -n -1; }
get_code() { echo "$1" | tail -1; }

echo "============================================"
echo " Phase 2 Auth Tests — $(date)"
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
  echo -e "${RED}Service not reachable at $SERVICE (HTTP $HEALTH_CODE). Aborting.${NC}"
  exit 1
fi

if [ -z "$ADMIN_KEY" ]; then
  echo -e "${YELLOW}WARNING: SWARM_ADMIN_KEY not set. Admin tests will be skipped.${NC}"
  echo "  Usage: SWARM_ADMIN_KEY=<key> bash $0"
fi

# ── TA: Token Generation ──────────────────────────────────────
echo ""
echo "--- TA: Token Generation ---"

# In enforce mode: create (provision) requires admin key, register is open for provisioned agents
AGENT1_ID="qa-auth-test-$(date +%s)"
AGENT2_ID="qa-auth-test2-$(date +%s)"
AGENT3_ID="qa-auth-test3-$(date +%s)"

# Pre-provision agents with admin key
if [ -n "$ADMIN_KEY" ]; then
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT1_ID\",\"name\":\"QA Auth Test 1\",\"description\":\"Auth test agent\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT2_ID\",\"name\":\"QA Auth Test 2\",\"description\":\"Second auth test\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT3_ID\",\"name\":\"QA Auth UI\",\"description\":\"UI create test\",\"cwd\":\"C:/tmp\"}" > /dev/null
fi

# TA.1 — Register pre-provisioned agent returns apiKey
REG_RESP=$(api_no_auth POST /agents "{\"id\":\"$AGENT1_ID\",\"name\":\"QA Auth Test 1\",\"description\":\"Auth test agent\"}")
REG_BODY=$(get_body "$REG_RESP")
REG_CODE=$(get_code "$REG_RESP")
AGENT1_KEY=$(echo "$REG_BODY" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).apiKey||'')}catch{console.log('')}})" 2>/dev/null)

if [ "$REG_CODE" = "200" ] && [ -n "$AGENT1_KEY" ]; then
  log_pass "TA.1: POST /agents (pre-provisioned) returns apiKey"
else
  log_fail "TA.1: POST /agents apiKey" "HTTP $REG_CODE, key='$AGENT1_KEY', body=$(echo $REG_BODY | head -c 200)"
fi

# TA.2 — apiKey format (>= 32 chars)
KEY_LEN=${#AGENT1_KEY}
if [ "$KEY_LEN" -ge 32 ]; then
  log_pass "TA.2: apiKey length >= 32 chars ($KEY_LEN)"
else
  log_fail "TA.2: apiKey length" "Only $KEY_LEN chars (expected >= 32)"
fi

# TA.3 — Unique keys per agent
REG2_RESP=$(api_no_auth POST /agents "{\"id\":\"$AGENT2_ID\",\"name\":\"QA Auth Test 2\",\"description\":\"Second auth test\"}")
AGENT2_KEY=$(get_body "$REG2_RESP" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).apiKey||'')}catch{console.log('')}})" 2>/dev/null)
if [ -n "$AGENT2_KEY" ] && [ "$AGENT1_KEY" != "$AGENT2_KEY" ]; then
  log_pass "TA.3: Unique keys per agent"
else
  log_fail "TA.3: Unique keys" "key1='${AGENT1_KEY:0:8}...' key2='${AGENT2_KEY:0:8}...'"
fi

# TA.4 — Create (admin) does NOT return apiKey
CREATE_RESP=$(api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"qa-nokey-$(date +%s)\",\"name\":\"No Key\",\"description\":\"test\",\"cwd\":\"C:/tmp\"}")
CREATE_BODY=$(get_body "$CREATE_RESP")
AGENT_NOKEY_HAS_KEY=$(echo "$CREATE_BODY" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).apiKey?'yes':'no')}catch{console.log('no')}})" 2>/dev/null)
if [ "$AGENT_NOKEY_HAS_KEY" = "no" ]; then
  log_pass "TA.4: POST /agents/create does NOT leak apiKey"
else
  log_fail "TA.4: UI create apiKey leak" "apiKey should not be in create response"
fi

# TA.5 — Register pre-provisioned agent3
REG3_RESP=$(api_no_auth POST /agents "{\"id\":\"$AGENT3_ID\",\"name\":\"QA Auth UI\",\"description\":\"UI create test registered\"}")
REG3_CODE=$(get_code "$REG3_RESP")
AGENT3_KEY=$(get_body "$REG3_RESP" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).apiKey||'')}catch{console.log('')}})" 2>/dev/null)
if [ "$REG3_CODE" = "200" ] && [ -n "$AGENT3_KEY" ]; then
  log_pass "TA.5: Pre-provisioned agent registers and gets apiKey"
else
  log_fail "TA.5: Pre-provisioned register" "HTTP $REG3_CODE, key='$AGENT3_KEY'"
fi

# TA.6 — Non-provisioned agent cannot register in enforce mode
ROGUE_RESP=$(api_no_auth POST /agents "{\"id\":\"qa-rogue-$(date +%s)\",\"name\":\"Rogue\",\"description\":\"not provisioned\"}")
ROGUE_CODE=$(get_code "$ROGUE_RESP")
if [ "$ROGUE_CODE" = "403" ]; then
  log_pass "TA.6: Non-provisioned agent register → 403"
else
  log_fail "TA.6: Rogue registration" "Expected 403, got $ROGUE_CODE"
fi

# Add edge between test agents for message tests
if [ -n "$ADMIN_KEY" ]; then
  api_with_auth "$ADMIN_KEY" POST /edges "{\"from\":\"$AGENT1_ID\",\"to\":\"$AGENT2_ID\"}" > /dev/null
fi

# ── TB: Auth on All Endpoints (enforce mode) ──────────────────
echo ""
echo "--- TB: Auth on All Endpoints ---"

# TB.1 — GET /agents without token
RESP=$(api_no_auth GET /agents)
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TB.1: GET /agents without token → 401"
else
  log_fail "TB.1: GET /agents no auth" "Expected 401, got $CODE"
fi

# TB.2 — GET /agents with valid token
RESP=$(api_with_auth "$AGENT1_KEY" GET /agents)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TB.2: GET /agents with valid token → 200"
else
  log_fail "TB.2: GET /agents valid auth" "Expected 200, got $CODE"
fi

# TB.3 — GET /agents with invalid token
RESP=$(api_with_auth "invalid-token-xyz" GET /agents)
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TB.3: GET /agents with invalid token → 401"
else
  log_fail "TB.3: GET /agents invalid auth" "Expected 401, got $CODE"
fi

# TB.4 — GET /topology without token
RESP=$(api_no_auth GET /topology)
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TB.4: GET /topology without token → 401"
else
  log_fail "TB.4: GET /topology no auth" "Expected 401, got $CODE"
fi

# TB.5 — POST /messages without token
RESP=$(api_no_auth POST /messages '{"from":"test","to":"test","content":"test"}')
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TB.5: POST /messages without token → 401"
else
  log_fail "TB.5: POST /messages no auth" "Expected 401, got $CODE"
fi

# TB.6 — POST /edges without token
RESP=$(api_no_auth POST /edges '{"from":"a","to":"b"}')
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TB.6: POST /edges without token → 401"
else
  log_fail "TB.6: POST /edges no auth" "Expected 401, got $CODE"
fi

# TB.7 — DELETE /agents without token
RESP=$(api_no_auth DELETE "/agents/nonexistent")
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TB.7: DELETE /agents without token → 401"
else
  log_fail "TB.7: DELETE /agents no auth" "Expected 401, got $CODE"
fi

# TB.8 — PATCH /agents without token
RESP=$(api_no_auth PATCH "/agents/$AGENT1_ID" '{"name":"hacked"}')
CODE=$(get_code "$RESP")
if [ "$CODE" = "401" ]; then
  log_pass "TB.8: PATCH /agents without token → 401"
else
  log_fail "TB.8: PATCH /agents no auth" "Expected 401, got $CODE"
fi

# TB.9 — GET /health should be public
RESP=$(api_no_auth GET /health)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TB.9: GET /health public (no auth needed) → 200"
else
  log_fail "TB.9: GET /health" "Expected 200, got $CODE"
fi

# TB.10 — SSE without token
RESP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$SERVICE/events/$AGENT1_ID" 2>/dev/null)
if [ "$RESP" = "401" ]; then
  log_pass "TB.10: SSE without token → 401"
else
  log_fail "TB.10: SSE no auth" "Expected 401, got $RESP"
fi

# TB.11 — Registration is open (no auth) for pre-provisioned agents
AGENT_OPEN_ID="qa-open-reg-$(date +%s)"
# Pre-provision with admin key
api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_OPEN_ID\",\"name\":\"Open Reg\",\"description\":\"test\",\"cwd\":\"C:/tmp\"}" > /dev/null
# Then register without auth
RESP=$(api_no_auth POST /agents "{\"id\":\"$AGENT_OPEN_ID\",\"name\":\"Open Reg\",\"description\":\"test\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TB.11: POST /agents (register pre-provisioned) open without auth → 200"
  OPEN_KEY=$(get_body "$RESP" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).apiKey||'')}catch{console.log('')}})" 2>/dev/null)
else
  log_fail "TB.11: Registration open" "Expected 200, got $CODE"
fi

# ── TC: Message Spoofing Fix ──────────────────────────────────
echo ""
echo "--- TC: Message Spoofing Fix ---"

# TC.1 — Send message as self (correct from)
RESP=$(api_with_auth "$AGENT1_KEY" POST /messages "{\"from\":\"$AGENT1_ID\",\"to\":\"$AGENT2_ID\",\"content\":\"legit message\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TC.1: Message from=self → 200"
else
  log_fail "TC.1: Legit message" "Expected 200, got $CODE. Body: $(get_body "$RESP")"
fi

# TC.2 — Send message as someone else (spoof)
RESP=$(api_with_auth "$AGENT1_KEY" POST /messages "{\"from\":\"$AGENT2_ID\",\"to\":\"$AGENT1_ID\",\"content\":\"spoofed!\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "403" ]; then
  log_pass "TC.2: Spoofed message from=other → 403"
else
  log_fail "TC.2: Message spoofing" "Expected 403, got $CODE"
fi

# TC.3 — Broadcast as self
RESP=$(api_with_auth "$AGENT1_KEY" POST /messages/broadcast "{\"from\":\"$AGENT1_ID\",\"content\":\"legit broadcast\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TC.3: Broadcast from=self → 200"
else
  log_fail "TC.3: Legit broadcast" "Expected 200, got $CODE"
fi

# TC.4 — Broadcast as someone else
RESP=$(api_with_auth "$AGENT1_KEY" POST /messages/broadcast "{\"from\":\"$AGENT2_ID\",\"content\":\"spoofed broadcast\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "403" ]; then
  log_pass "TC.4: Spoofed broadcast from=other → 403"
else
  log_fail "TC.4: Broadcast spoofing" "Expected 403, got $CODE"
fi

# ── TD: Admin vs Agent Scope ─────────────────────────────────
echo ""
echo "--- TD: Admin vs Agent Scope ---"

# TD.2 — Agent deletes another agent
RESP=$(api_with_auth "$AGENT1_KEY" DELETE "/agents/$AGENT2_ID")
CODE=$(get_code "$RESP")
if [ "$CODE" = "403" ]; then
  log_pass "TD.2: Agent deletes other agent → 403"
else
  log_fail "TD.2: Agent deletes other" "Expected 403, got $CODE"
fi

# TD.3 — Agent creates edge
RESP=$(api_with_auth "$AGENT1_KEY" POST /edges "{\"from\":\"$AGENT1_ID\",\"to\":\"$AGENT3_ID\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "403" ]; then
  log_pass "TD.3: Agent creates edge → 403"
else
  log_fail "TD.3: Agent creates edge" "Expected 403, got $CODE"
fi

# TD.4 — Agent removes edge
RESP=$(api_with_auth "$AGENT1_KEY" DELETE /edges "{\"from\":\"$AGENT1_ID\",\"to\":\"$AGENT2_ID\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "403" ]; then
  log_pass "TD.4: Agent removes edge → 403"
else
  log_fail "TD.4: Agent removes edge" "Expected 403, got $CODE"
fi

# TD.5 — PATCH /agents/:id is admin-only (agents cannot self-update properties)
RESP=$(api_with_auth "$AGENT1_KEY" PATCH "/agents/$AGENT1_ID" '{"name":"QA Updated Name"}')
CODE=$(get_code "$RESP")
if [ "$CODE" = "403" ]; then
  log_pass "TD.5: Agent self-update properties → 403 (admin-only)"
else
  log_fail "TD.5: Self-update" "Expected 403, got $CODE"
fi

# TD.6 — Agent updates other's properties
RESP=$(api_with_auth "$AGENT1_KEY" PATCH "/agents/$AGENT2_ID" '{"name":"Hacked Name"}')
CODE=$(get_code "$RESP")
if [ "$CODE" = "403" ]; then
  log_pass "TD.6: Agent updates other's properties → 403"
else
  log_fail "TD.6: Update other agent" "Expected 403, got $CODE"
fi

# TD.7 — Agent gets ?full=true but receives Public View (no internal fields)
RESP=$(api_with_auth "$AGENT1_KEY" GET "/topology?full=true")
CODE=$(get_code "$RESP")
BODY=$(get_body "$RESP")
HAS_CWD=$(echo "$BODY" | grep -c '"cwd"' || true)
if [ "$CODE" = "200" ] && [ "$HAS_CWD" = "0" ]; then
  log_pass "TD.7: Agent topology?full=true → 200 (public view, no cwd)"
elif [ "$CODE" = "200" ]; then
  log_fail "TD.7: Agent topology?full=true" "200 but internal fields exposed (cwd found)"
else
  log_fail "TD.7: Agent topology?full=true" "Expected 200, got $CODE"
fi

# Admin tests (require SWARM_ADMIN_KEY)
if [ -n "$ADMIN_KEY" ]; then
  # TD.8 — Admin deletes agent
  RESP=$(api_with_auth "$ADMIN_KEY" DELETE "/agents/$AGENT3_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TD.8: Admin deletes agent → 200"
  else
    log_fail "TD.8: Admin delete" "Expected 200, got $CODE"
  fi

  # TD.9 — Admin creates edge
  RESP=$(api_with_auth "$ADMIN_KEY" POST /edges "{\"from\":\"$AGENT1_ID\",\"to\":\"$AGENT2_ID\"}")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TD.9: Admin creates edge → 200"
  else
    log_fail "TD.9: Admin edge" "Expected 200, got $CODE"
  fi

  # TD.10 — Admin updates agent properties
  RESP=$(api_with_auth "$ADMIN_KEY" PATCH "/agents/$AGENT2_ID" '{"name":"Admin Updated"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TD.10: Admin updates agent → 200"
  else
    log_fail "TD.10: Admin update" "Expected 200, got $CODE"
  fi
else
  log_skip "TD.8-TD.10" "SWARM_ADMIN_KEY not set"
fi

# ── TF: Admin Key ─────────────────────────────────────────────
echo ""
echo "--- TF: Admin Key ---"

if [ -n "$ADMIN_KEY" ]; then
  # TF.1 — Admin key on agent endpoint
  RESP=$(api_with_auth "$ADMIN_KEY" GET /agents)
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TF.1: Admin key on agent endpoint → 200"
  else
    log_fail "TF.1: Admin on agent endpoint" "Expected 200, got $CODE"
  fi

  # TF.2 — Admin key on admin endpoint
  RESP=$(api_with_auth "$ADMIN_KEY" GET "/topology?full=true")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TF.2: Admin key on admin endpoint → 200"
  else
    log_fail "TF.2: Admin on admin endpoint" "Expected 200, got $CODE"
  fi

  # TF.3 — Admin can send messages as anyone
  RESP=$(api_with_auth "$ADMIN_KEY" POST /messages "{\"from\":\"$AGENT1_ID\",\"to\":\"$AGENT2_ID\",\"content\":\"admin proxy message\"}")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TF.3: Admin sends message as agent → 200"
  else
    log_fail "TF.3: Admin proxy message" "Expected 200, got $CODE"
  fi

  # TF.4 — Agent key on admin endpoint
  RESP=$(api_with_auth "$AGENT1_KEY" DELETE "/agents/$AGENT2_ID")
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TF.4: Agent key on admin endpoint → 403"
  else
    log_fail "TF.4: Agent on admin endpoint" "Expected 403, got $CODE"
  fi
else
  log_skip "TF.1-TF.4" "SWARM_ADMIN_KEY not set"
fi

# ── TG: SSE Auth ──────────────────────────────────────────────
echo ""
echo "--- TG: SSE Auth ---"

# TG.1 — SSE without token
SSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$SERVICE/events/$AGENT1_ID" 2>/dev/null)
if [ "$SSE_CODE" = "401" ]; then
  log_pass "TG.1: SSE without token → 401"
else
  log_fail "TG.1: SSE no auth" "Expected 401, got $SSE_CODE"
fi

# TG.2 — SSE with valid token (query param)
SSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$SERVICE/events/$AGENT1_ID?token=$AGENT1_KEY" 2>/dev/null)
if [ "$SSE_CODE" = "200" ]; then
  log_pass "TG.2: SSE with valid token → 200"
else
  log_fail "TG.2: SSE valid token" "Expected 200, got $SSE_CODE"
fi

# TG.3 — SSE with invalid token
SSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$SERVICE/events/$AGENT1_ID?token=invalid" 2>/dev/null)
if [ "$SSE_CODE" = "401" ]; then
  log_pass "TG.3: SSE with invalid token → 401"
else
  log_fail "TG.3: SSE invalid token" "Expected 401, got $SSE_CODE"
fi

# TG.4 — SSE with other agent's token
SSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$SERVICE/events/$AGENT1_ID?token=$AGENT2_KEY" 2>/dev/null)
if [ "$SSE_CODE" = "403" ]; then
  log_pass "TG.4: SSE with wrong agent's token → 403"
else
  log_fail "TG.4: SSE wrong token" "Expected 403, got $SSE_CODE"
fi

# TG.5 — SSE with Bearer header
SSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 -H "Authorization: Bearer $AGENT1_KEY" "$SERVICE/events/$AGENT1_ID" 2>/dev/null)
if [ "$SSE_CODE" = "200" ]; then
  log_pass "TG.5: SSE with Bearer header → 200"
else
  log_fail "TG.5: SSE Bearer header" "Expected 200, got $SSE_CODE"
fi

# ── TH: Key Persistence ──────────────────────────────────────
echo ""
echo "--- TH: Key Persistence ---"

# TH.5 — Keys NOT in GET /topology
TOPO=$(api_with_auth "$AGENT1_KEY" GET /topology)
TOPO_BODY=$(get_body "$TOPO")
if echo "$TOPO_BODY" | grep -q '"apiKey"'; then
  log_fail "TH.5: Keys in topology" "apiKey field found in GET /topology!"
else
  log_pass "TH.5: Keys NOT exposed in GET /topology"
fi

# TH.6 — Keys NOT in GET /agents
AGENTS_RESP=$(api_with_auth "$AGENT1_KEY" GET /agents)
AGENTS_BODY=$(get_body "$AGENTS_RESP")
if echo "$AGENTS_BODY" | grep -q '"apiKey"'; then
  log_fail "TH.6: Keys in agent list" "apiKey field found in GET /agents!"
else
  log_pass "TH.6: Keys NOT exposed in GET /agents"
fi

# TH.7 — Keys stored in separate file (not topology.json)
KEYS_FILE="${USERPROFILE:-$HOME}/.swarm-channel/keys.json"
if [ -f "$KEYS_FILE" ]; then
  log_pass "TH.7: keys.json exists (separate from topology)"
else
  log_skip "TH.7: keys.json" "File not found at $KEYS_FILE"
fi

# TH.1-TH.4 — Key persistence across restart (manual)
log_skip "TH.1-TH.4" "Key persistence requires service restart — test manually"

# ── TE: Auth Modes (manual) ──────────────────────────────────
echo ""
echo "--- TE: Auth Modes ---"
log_skip "TE.1-TE.6" "Auth mode tests require service restart with different SWARM_AUTH_MODE — test manually"

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo "--- Cleanup ---"
if [ -n "$ADMIN_KEY" ]; then
  api_with_auth "$ADMIN_KEY" DELETE "/agents/$AGENT1_ID" > /dev/null
  api_with_auth "$ADMIN_KEY" DELETE "/agents/$AGENT2_ID" > /dev/null
  api_with_auth "$ADMIN_KEY" DELETE "/agents/$AGENT_OPEN_ID" > /dev/null 2>&1
  log_pass "Cleanup: Test agents removed (admin)"
elif [ -n "$AGENT1_KEY" ]; then
  # Try self-delete if allowed
  api_with_auth "$AGENT1_KEY" DELETE "/agents/$AGENT1_ID" > /dev/null 2>&1
  api_with_auth "$AGENT2_KEY" DELETE "/agents/$AGENT2_ID" > /dev/null 2>&1
  log_pass "Cleanup: Attempted self-delete"
fi

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
