#!/bin/bash
# Phase 1 Manual QA Tests — SSE, Discover, Multiline Messages
# These supplement the automated tests with cases that need active SSE/MCP
# Usage: bash tests/phase1-manual-tests.sh [service_url]

SERVICE="${1:-http://127.0.0.1:3001}"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { PASS=$((PASS+1)); echo -e "${GREEN}PASS${NC} $1"; }
log_fail() { FAIL=$((FAIL+1)); echo -e "${RED}FAIL${NC} $1 — $2"; }

api() { curl -s -X "$1" "$SERVICE$2" -H "Content-Type: application/json" ${3:+-d "$3"} 2>/dev/null; }

echo "============================================"
echo " Phase 1 Manual QA Tests — $(date)"
echo "============================================"
echo ""

# ── T6: SSE Parser — Multiline Messages ───────────────────────
echo "--- T6: Multiline Message Tests ---"

# T6.2 — Message with newlines in content
# Send via API to a known online agent (qa)
MULTILINE_CONTENT="Line 1\nLine 2\nLine 3 with special chars: {}[]\"quotes\""
RESULT=$(api POST /messages "{\"from\":\"qa\",\"to\":\"qa\",\"content\":\"$MULTILINE_CONTENT\"}")
# Self-message: qa is connected to itself? Probably not. Use two connected agents.
# Use lead-architect -> qa which are connected
RESULT=$(api POST /messages "{\"from\":\"lead-architect\",\"to\":\"qa\",\"content\":\"Multiline test:\\nLine 1\\nLine 2\\n{\\\"json\\\": true}\"}")
if echo "$RESULT" | grep -q '"delivered":true'; then
  log_pass "T6.2: Multiline message sent and delivered"
  echo "  -> Check QA agent received it correctly (manual verification)"
else
  echo "  Result: $RESULT"
  log_fail "T6.2: Multiline message" "Not delivered — check if lead-architect<->qa edge exists"
fi

# T6.4 — Long message (>10KB)
LONG_CONTENT=$(node -e "console.log('x'.repeat(10240))")
RESULT=$(api POST /messages "{\"from\":\"lead-architect\",\"to\":\"qa\",\"content\":\"$LONG_CONTENT\"}")
if echo "$RESULT" | grep -q '"delivered":true'; then
  log_pass "T6.4: Long message (10KB) delivered"
else
  log_fail "T6.4: Long message" "Result: $(echo $RESULT | head -c 200)"
fi

# T6.5 — Rapid-fire messages
echo "  Sending 10 rapid-fire messages..."
DELIVERED=0
for i in $(seq 1 10); do
  R=$(api POST /messages "{\"from\":\"lead-architect\",\"to\":\"qa\",\"content\":\"Rapid msg $i\"}")
  if echo "$R" | grep -q '"delivered":true'; then
    DELIVERED=$((DELIVERED+1))
  fi
done
if [ "$DELIVERED" -eq 10 ]; then
  log_pass "T6.5: Rapid-fire — all 10 messages delivered"
else
  log_fail "T6.5: Rapid-fire messages" "Only $DELIVERED/10 delivered"
fi

# ── Summary ────────────────────────────────────────────────────
echo ""
echo "============================================"
echo " RESULTS: ${PASS} passed, ${FAIL} failed"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}SOME TESTS FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}ALL MANUAL TESTS PASSED${NC}"
  exit 0
fi
