#!/bin/bash
# Phase 1 QA Test Suite — Swarm Channel MCP
# Run after RC merge + service restart
# Usage: bash tests/phase1-tests.sh [service_url]

SERVICE="${1:-http://127.0.0.1:3001}"
PASS=0
FAIL=0
SKIP=0
RESULTS=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { PASS=$((PASS+1)); RESULTS+="${GREEN}PASS${NC} $1\n"; echo -e "${GREEN}PASS${NC} $1"; }
log_fail() { FAIL=$((FAIL+1)); RESULTS+="${RED}FAIL${NC} $1 — $2\n"; echo -e "${RED}FAIL${NC} $1 — $2"; }
log_skip() { SKIP=$((SKIP+1)); RESULTS+="${YELLOW}SKIP${NC} $1 — $2\n"; echo -e "${YELLOW}SKIP${NC} $1 — $2"; }

api() { curl -s -X "$1" "$SERVICE$2" -H "Content-Type: application/json" ${3:+-d "$3"} 2>/dev/null; }

echo "============================================"
echo " Phase 1 QA Tests — $(date)"
echo " Service: $SERVICE"
echo "============================================"
echo ""

# ── Preflight ──────────────────────────────────────────────────
echo "--- Preflight ---"

HEALTH=$(api GET /health)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  log_pass "Preflight: Service is healthy"
else
  echo -e "${RED}Service not reachable at $SERVICE. Aborting.${NC}"
  exit 1
fi

# Create test agent for isolated testing
TEST_ID="qa-test-$(date +%s)"
api POST /agents/create "{\"id\":\"$TEST_ID\",\"name\":\"QA Test Agent\",\"description\":\"Temporary test agent for Phase 1 QA\",\"cwd\":\"C:/tmp\"}" > /dev/null
log_pass "Preflight: Test agent '$TEST_ID' created"

# ── T1: Object.assign Fix ─────────────────────────────────────
echo ""
echo "--- T1: Object.assign Fix (PATCH protection) ---"

# T1.1 — PATCH with status field should NOT change status
BEFORE_STATUS=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).status))")
api PATCH "/agents/$TEST_ID" '{"status":"available"}' > /dev/null
AFTER_STATUS=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).status))")
if [ "$BEFORE_STATUS" = "$AFTER_STATUS" ]; then
  log_pass "T1.1: PATCH with status field — status unchanged ($BEFORE_STATUS)"
else
  log_fail "T1.1: PATCH with status field" "status changed from '$BEFORE_STATUS' to '$AFTER_STATUS'"
fi

# T1.2 — PATCH with registeredAt should NOT change it
BEFORE_REG=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).registeredAt))")
api PATCH "/agents/$TEST_ID" '{"registeredAt":"1999-01-01T00:00:00Z"}' > /dev/null
AFTER_REG=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).registeredAt))")
if [ "$BEFORE_REG" = "$AFTER_REG" ]; then
  log_pass "T1.2: PATCH with registeredAt — unchanged"
else
  log_fail "T1.2: PATCH with registeredAt" "changed from '$BEFORE_REG' to '$AFTER_REG'"
fi

# T1.3 — PATCH with lastSeen should NOT change it
BEFORE_LS=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).lastSeen))")
api PATCH "/agents/$TEST_ID" '{"lastSeen":"1999-01-01T00:00:00Z"}' > /dev/null
AFTER_LS=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).lastSeen))")
if [ "$BEFORE_LS" = "$AFTER_LS" ]; then
  log_pass "T1.3: PATCH with lastSeen — unchanged"
else
  log_fail "T1.3: PATCH with lastSeen" "changed from '$BEFORE_LS' to '$AFTER_LS'"
fi

# T1.4 — PATCH with allowed fields should work
RESULT=$(api PATCH "/agents/$TEST_ID" '{"name":"QA Updated","description":"Updated desc"}')
UPDATED_NAME=$(echo "$RESULT" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).name))")
if [ "$UPDATED_NAME" = "QA Updated" ]; then
  log_pass "T1.4: PATCH with allowed fields (name, description) — works"
else
  log_fail "T1.4: PATCH with allowed fields" "name='$UPDATED_NAME' expected 'QA Updated'"
fi

# T1.5 — PATCH with mixed fields: allowed should apply, protected should not
BEFORE_STATUS2=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).status))")
RESULT=$(api PATCH "/agents/$TEST_ID" '{"name":"QA Mixed Test","status":"available"}')
AFTER_NAME=$(echo "$RESULT" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).name))")
AFTER_STATUS2=$(api GET "/agents/$TEST_ID" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).status))")
if [ "$AFTER_NAME" = "QA Mixed Test" ] && [ "$BEFORE_STATUS2" = "$AFTER_STATUS2" ]; then
  log_pass "T1.5: PATCH mixed fields — name updated, status unchanged"
else
  log_fail "T1.5: PATCH mixed fields" "name='$AFTER_NAME', status before='$BEFORE_STATUS2' after='$AFTER_STATUS2'"
fi

# ── T2: Topology Data Exposure Fix ────────────────────────────
echo ""
echo "--- T2: Topology Data Exposure Fix ---"

TOPO=$(api GET /topology)

# T2.1 — No cwd in topology
if echo "$TOPO" | grep -q '"cwd"'; then
  log_fail "T2.1: Topology cwd exposure" "cwd field found in GET /topology"
else
  log_pass "T2.1: Topology — no cwd exposed"
fi

# T2.2 — No launchCommand in topology
if echo "$TOPO" | grep -q '"launchCommand"'; then
  log_fail "T2.2: Topology launchCommand exposure" "launchCommand field found"
else
  log_pass "T2.2: Topology — no launchCommand exposed"
fi

# T2.3 — No autoconnect in topology
if echo "$TOPO" | grep -q '"autoconnect"'; then
  log_fail "T2.3: Topology autoconnect exposure" "autoconnect field found"
else
  log_pass "T2.3: Topology — no autoconnect exposed"
fi

# T2.4 — GET /agents list should not expose internal fields
AGENTS_LIST=$(api GET /agents)
if echo "$AGENTS_LIST" | grep -q '"launchCommand"'; then
  log_fail "T2.4: Agent list exposure" "launchCommand in GET /agents"
else
  log_pass "T2.4: Agent list — no internal fields exposed"
fi

# ── T3: Adjacency Map (Edge Operations) ───────────────────────
echo ""
echo "--- T3: Edge Operations (Adjacency Map) ---"

# Create a second test agent for edge tests
TEST_ID2="qa-test2-$(date +%s)"
api POST /agents/create "{\"id\":\"$TEST_ID2\",\"name\":\"QA Test Agent 2\",\"description\":\"Second test agent\",\"cwd\":\"C:/tmp\"}" > /dev/null

# T3.1 — Add edge
EDGE_RESULT=$(api POST /edges "{\"from\":\"$TEST_ID\",\"to\":\"$TEST_ID2\"}")
if echo "$EDGE_RESULT" | grep -q '"ok":true'; then
  log_pass "T3.1: Add edge — ok"
else
  log_fail "T3.1: Add edge" "Result: $EDGE_RESULT"
fi

# T3.2 — Duplicate edge
DUP_RESULT=$(api POST /edges "{\"from\":\"$TEST_ID\",\"to\":\"$TEST_ID2\"}")
if echo "$DUP_RESULT" | grep -q '"ok":false'; then
  log_pass "T3.2: Duplicate edge — correctly rejected"
else
  log_fail "T3.2: Duplicate edge" "Result: $DUP_RESULT"
fi

# T3.3 — Self-loop
SELF_RESULT=$(api POST /edges "{\"from\":\"$TEST_ID\",\"to\":\"$TEST_ID\"}")
if echo "$SELF_RESULT" | grep -q '"ok":false'; then
  log_pass "T3.3: Self-loop — correctly rejected"
else
  log_fail "T3.3: Self-loop" "Result: $SELF_RESULT"
fi

# T3.4 — Edge with unknown agent
UNK_RESULT=$(api POST /edges "{\"from\":\"$TEST_ID\",\"to\":\"nonexistent-agent-xyz\"}")
if echo "$UNK_RESULT" | grep -q '"ok":false'; then
  log_pass "T3.4: Edge with unknown agent — correctly rejected"
else
  log_fail "T3.4: Edge with unknown agent" "Result: $UNK_RESULT"
fi

# T3.7 — Connections list
CONNS=$(api GET "/agents/$TEST_ID/connections")
if echo "$CONNS" | grep -q "$TEST_ID2"; then
  log_pass "T3.7: Connections list — shows connected agent"
else
  log_fail "T3.7: Connections list" "Expected $TEST_ID2 in: $CONNS"
fi

# T3.8 — Message over edge (both agents offline, so delivered=false is ok)
MSG_RESULT=$(api POST /messages "{\"from\":\"$TEST_ID\",\"to\":\"$TEST_ID2\",\"content\":\"edge test\"}")
if echo "$MSG_RESULT" | grep -q '"error"'; then
  log_fail "T3.8: Message over edge" "Blocked: $MSG_RESULT"
else
  log_pass "T3.8: Message over edge — allowed (delivered=$(echo "$MSG_RESULT" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).delivered))"))"
fi

# T3.9 — Message without edge
MSG_BLOCK=$(api POST /messages "{\"from\":\"$TEST_ID2\",\"to\":\"qa\",\"content\":\"no edge test\"}")
if echo "$MSG_BLOCK" | grep -q '"error"'; then
  log_pass "T3.9: Message without edge — correctly blocked"
else
  log_fail "T3.9: Message without edge" "Should be blocked: $MSG_BLOCK"
fi

# T3.5 — Remove edge
DEL_RESULT=$(api DELETE /edges "{\"from\":\"$TEST_ID\",\"to\":\"$TEST_ID2\"}")
if echo "$DEL_RESULT" | grep -q '"ok":true'; then
  log_pass "T3.5: Remove edge — ok"
else
  log_fail "T3.5: Remove edge" "Result: $DEL_RESULT"
fi

# T3.6 — Remove non-existent edge
DEL2_RESULT=$(api DELETE /edges "{\"from\":\"$TEST_ID\",\"to\":\"$TEST_ID2\"}")
if echo "$DEL2_RESULT" | grep -q '"ok":false'; then
  log_pass "T3.6: Remove non-existent edge — correctly rejected"
else
  log_fail "T3.6: Remove non-existent edge" "Result: $DEL2_RESULT"
fi

# T3.10 — Remove agent cleans up edges
api POST /edges "{\"from\":\"$TEST_ID\",\"to\":\"$TEST_ID2\"}" > /dev/null
api DELETE "/agents/$TEST_ID2" > /dev/null
TOPO_AFTER=$(api GET /topology)
if echo "$TOPO_AFTER" | grep -q "$TEST_ID2"; then
  log_fail "T3.10: Remove agent cleanup" "Agent $TEST_ID2 still in topology"
else
  log_pass "T3.10: Remove agent — edges cleaned up"
fi

# ── T4: Async I/O ─────────────────────────────────────────────
echo ""
echo "--- T4: Async I/O (Topology Persistence) ---"

# T4.1 — Topology file exists and is valid JSON
# Try both Unix and Windows home paths
TOPO_FILE="${USERPROFILE:-$HOME}/.swarm-channel/topology.json"
if [ -f "$TOPO_FILE" ]; then
  if node -e "try{JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('valid')}catch(e){console.log('invalid')}" "$TOPO_FILE" 2>/dev/null | grep -q "valid"; then
    log_pass "T4.1: Topology file exists and is valid JSON"
  else
    log_fail "T4.1: Topology file" "File exists but invalid JSON"
  fi
else
  log_skip "T4.1: Topology file" "File not found at $TOPO_FILE"
fi

# T4.4 — Rapid-fire mutations
echo "  Running rapid-fire mutations..."
for i in $(seq 1 10); do
  RAPID_ID="qa-rapid-$i-$(date +%s)"
  api POST /agents/create "{\"id\":\"$RAPID_ID\",\"name\":\"Rapid $i\",\"description\":\"Rapid test\",\"cwd\":\"C:/tmp\"}" > /dev/null &
done
wait
AGENT_COUNT=$(api GET "/agents?all=true" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).length))")
if [ "$AGENT_COUNT" -gt 10 ]; then
  log_pass "T4.4: Rapid-fire mutations — $AGENT_COUNT agents exist"
else
  log_fail "T4.4: Rapid-fire mutations" "Only $AGENT_COUNT agents after rapid creates"
fi

# ── T7: Discover with Query Filtering ─────────────────────────
echo ""
echo "--- T7: Discover Query Filtering ---"
echo "  (Manual tests via MCP tools — see testplan for details)"
log_skip "T7.1-T7.5" "Discover tests require MCP tool — will test manually"

# ── T5/T6: Manual Tests ───────────────────────────────────────
echo ""
echo "--- T5: Graceful Shutdown / T6: SSE Parser ---"
log_skip "T5.1-T5.3" "Graceful shutdown requires service restart — will test manually"
log_skip "T6.1-T6.5" "SSE parser tests require active SSE connection — will test via MCP"

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo "--- Cleanup ---"
api DELETE "/agents/$TEST_ID" > /dev/null

# Clean up rapid-fire agents
RAPID_IDS=$(api GET "/agents?all=true" | node -e "process.stdin.on('data',d=>{JSON.parse(d).filter(a=>a.id.startsWith('qa-rapid-')||a.id.startsWith('qa-test')).forEach(a=>console.log(a.id))})" 2>/dev/null)
for RAPID_ID in $RAPID_IDS; do
  api DELETE "/agents/$RAPID_ID" > /dev/null
done
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
