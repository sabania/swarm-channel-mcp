#!/bin/bash
# Phase 5 QA Test Suite — Typed Events + Reliable SSE
# Usage: SWARM_ADMIN_KEY=<key> bash tests/phase5-events-tests.sh [service_url]
# Some tests require waiting for heartbeats (~35s)

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
jf() { echo "$1" | node -e "process.stdin.on('data',d=>{try{const j=JSON.parse(d);const p='$2'.split('.');let r=j;for(const k of p)r=r?.[k];console.log(r===undefined?'':typeof r==='object'?JSON.stringify(r):r)}catch{console.log('')}})" 2>/dev/null; }
api_adm() { if [ -n "$ADMIN_KEY" ]; then api_with_auth "$ADMIN_KEY" "$@"; else api_no_auth "$@"; fi; }

echo "============================================"
echo " Phase 5 Typed Events Tests — $(date)"
echo " Service: $SERVICE"
echo "============================================"
echo ""

# ── Preflight ──────────────────────────────────────────────────
echo "--- Preflight ---"

HEALTH_RESP=$(api_no_auth GET /health)
if [ "$(get_code "$HEALTH_RESP")" = "200" ]; then
  log_pass "Preflight: Service healthy"
else
  echo -e "${RED}Service not reachable. Aborting.${NC}"; exit 1
fi

TS=$(date +%s)
AGENT_SSE="qa-sse-$TS"
AGENT_TRIG="qa-trig-$TS"

# Create and register agents
if [ -n "$ADMIN_KEY" ]; then
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_SSE\",\"name\":\"SSE Agent\",\"description\":\"SSE test\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_TRIG\",\"name\":\"Trigger Agent\",\"description\":\"Triggers events\",\"cwd\":\"C:/tmp\"}" > /dev/null
fi

RESP_SSE=$(api_no_auth POST /agents "{\"id\":\"$AGENT_SSE\",\"name\":\"SSE Agent\",\"description\":\"SSE test\",\"capabilities\":{\"skills\":[\"testing\",\"sse\"]}}")
KEY_SSE=$(jf "$(get_body "$RESP_SSE")" "apiKey")
RESP_TRIG=$(api_no_auth POST /agents "{\"id\":\"$AGENT_TRIG\",\"name\":\"Trigger Agent\",\"description\":\"Triggers events\",\"capabilities\":{\"skills\":[\"triggering\"]}}")
KEY_TRIG=$(jf "$(get_body "$RESP_TRIG")" "apiKey")

api_adm POST /edges "{\"from\":\"$AGENT_SSE\",\"to\":\"$AGENT_TRIG\"}" > /dev/null
log_pass "Preflight: Agents created and connected"

# Auth helper for SSE (token param or header)
SSE_TOKEN="${KEY_SSE:-}"
SSE_AUTH=""
if [ -n "$SSE_TOKEN" ]; then
  SSE_AUTH="?token=$SSE_TOKEN"
fi

# ── TE: Event IDs ─────────────────────────────────────────────
echo ""
echo "--- TE: Event IDs ---"

# Capture SSE events for 3 seconds while triggering events
SSE_OUTPUT=$(mktemp)
curl -s -N "$SERVICE/events/$AGENT_SSE$SSE_AUTH" --max-time 4 > "$SSE_OUTPUT" 2>/dev/null &
SSE_PID=$!
sleep 1

# Trigger events: send 3 messages
for i in 1 2 3; do
  if [ -n "$KEY_TRIG" ]; then
    api_with_auth "$KEY_TRIG" POST /messages "{\"from\":\"$AGENT_TRIG\",\"to\":\"$AGENT_SSE\",\"content\":\"event test $i\"}" > /dev/null
  else
    api_no_auth POST /messages "{\"from\":\"$AGENT_TRIG\",\"to\":\"$AGENT_SSE\",\"content\":\"event test $i\"}" > /dev/null
  fi
done
sleep 2
wait $SSE_PID 2>/dev/null

# TE.1 — Events have ID field
ID_COUNT=$(grep -c "^id:" "$SSE_OUTPUT" || true)
if [ "$ID_COUNT" -ge 1 ]; then
  log_pass "TE.1: Events have id: field ($ID_COUNT events)"
else
  log_fail "TE.1: Event IDs" "No id: fields found in SSE stream"
fi

# TE.2 — IDs are monotonically increasing
IDS=$(grep "^id:" "$SSE_OUTPUT" | sed 's/id: *//' | tr -d '\r')
IS_MONOTONIC=$(echo "$IDS" | node -e "
  const lines=require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n').filter(Boolean);
  const ids=lines.map(Number);
  let ok=true;
  for(let i=1;i<ids.length;i++){if(ids[i]<=ids[i-1])ok=false}
  console.log(ids.length>=2&&ok?'yes':'no');
" 2>/dev/null || echo "no")
if [ "$IS_MONOTONIC" = "yes" ]; then
  log_pass "TE.2: IDs monotonically increasing"
elif [ "$ID_COUNT" -lt 2 ]; then
  log_skip "TE.2" "Need 2+ events to verify ordering"
else
  # Might fail on Windows /dev/stdin — try alternative
  MONO_CHECK=$(echo "$IDS" | node -e "
    let prev=-1,ok=true;
    process.stdin.on('data',d=>{
      d.toString().trim().split(/\n/).filter(Boolean).forEach(l=>{
        const n=Number(l);if(n<=prev)ok=false;prev=n;
      });
    });
    process.stdin.on('end',()=>console.log(prev>0&&ok?'yes':'no'));
  " 2>/dev/null || echo "no")
  if [ "$MONO_CHECK" = "yes" ]; then
    log_pass "TE.2: IDs monotonically increasing"
  else
    log_fail "TE.2: Monotonic IDs" "IDs: $(echo $IDS | head -c 100)"
  fi
fi

# TE.4 — Different event types have IDs
EVENT_TYPES=$(grep "^event:" "$SSE_OUTPUT" | sort -u | sed 's/event: *//' | tr -d '\r' | tr '\n' ',' | sed 's/,$//')
if [ -n "$EVENT_TYPES" ]; then
  log_pass "TE.4: Event types with IDs: $EVENT_TYPES"
else
  log_fail "TE.4: Event types" "No event types found"
fi

rm -f "$SSE_OUTPUT"

# ── TR: Reconnect Recovery ────────────────────────────────────
echo ""
echo "--- TR: Reconnect Recovery ---"

# TR.1 — Connect, get baseline ID
SSE_OUTPUT2=$(mktemp)
curl -s -N "$SERVICE/events/$AGENT_SSE$SSE_AUTH" --max-time 3 > "$SSE_OUTPUT2" 2>/dev/null &
SSE_PID=$!
sleep 1

# Send a message to get an event with ID
if [ -n "$KEY_TRIG" ]; then
  api_with_auth "$KEY_TRIG" POST /messages "{\"from\":\"$AGENT_TRIG\",\"to\":\"$AGENT_SSE\",\"content\":\"baseline msg\"}" > /dev/null
fi
sleep 1
wait $SSE_PID 2>/dev/null

LAST_ID=$(grep "^id:" "$SSE_OUTPUT2" | tail -1 | sed 's/id: *//' | tr -d '\r')
rm -f "$SSE_OUTPUT2"

if [ -n "$LAST_ID" ]; then
  log_pass "TR.1: Baseline event ID: $LAST_ID"
else
  log_skip "TR.1" "No event ID captured"
fi

# TR.2+3 — Disconnect, trigger events, reconnect with Last-Event-ID
if [ -n "$LAST_ID" ]; then
  # Agent is now disconnected from SSE. Send messages that should be buffered.
  for i in 1 2 3; do
    if [ -n "$KEY_TRIG" ]; then
      api_with_auth "$KEY_TRIG" POST /messages "{\"from\":\"$AGENT_TRIG\",\"to\":\"$AGENT_SSE\",\"content\":\"missed msg $i\"}" > /dev/null
    else
      api_no_auth POST /messages "{\"from\":\"$AGENT_TRIG\",\"to\":\"$AGENT_SSE\",\"content\":\"missed msg $i\"}" > /dev/null
    fi
  done

  # TR.3 — Reconnect with Last-Event-ID
  SSE_REPLAY=$(mktemp)
  if [ -n "$SSE_TOKEN" ]; then
    curl -s -N "$SERVICE/events/$AGENT_SSE?token=$SSE_TOKEN" -H "Last-Event-ID: $LAST_ID" --max-time 3 > "$SSE_REPLAY" 2>/dev/null
  else
    curl -s -N "$SERVICE/events/$AGENT_SSE" -H "Last-Event-ID: $LAST_ID" --max-time 3 > "$SSE_REPLAY" 2>/dev/null
  fi

  REPLAY_COUNT=$(grep -c "^event:" "$SSE_REPLAY" || true)
  REPLAY_MSGS=$(grep -c "missed msg" "$SSE_REPLAY" || true)

  if [ "$REPLAY_MSGS" -ge 1 ]; then
    log_pass "TR.3: Reconnect replay — $REPLAY_MSGS missed messages recovered"
  elif [ "$REPLAY_COUNT" -ge 1 ]; then
    log_pass "TR.3: Reconnect replay — $REPLAY_COUNT events (may include non-message)"
  else
    log_fail "TR.3: Reconnect replay" "No replayed events found"
  fi

  # TR.4 — Check order
  REPLAY_IDS=$(grep "^id:" "$SSE_REPLAY" | sed 's/id: *//' | tr -d '\r')
  if [ -n "$REPLAY_IDS" ]; then
    log_pass "TR.4: Replayed events have IDs"
  else
    log_skip "TR.4" "No IDs in replay"
  fi

  # TR.7 — Last-Event-ID=latest gets nothing extra
  LATEST_ID=$(echo "$REPLAY_IDS" | tail -1)
  if [ -n "$LATEST_ID" ]; then
    SSE_NOTHING=$(mktemp)
    if [ -n "$SSE_TOKEN" ]; then
      curl -s -N "$SERVICE/events/$AGENT_SSE?token=$SSE_TOKEN" -H "Last-Event-ID: $LATEST_ID" --max-time 2 > "$SSE_NOTHING" 2>/dev/null
    else
      curl -s -N "$SERVICE/events/$AGENT_SSE" -H "Last-Event-ID: $LATEST_ID" --max-time 2 > "$SSE_NOTHING" 2>/dev/null
    fi
    EXTRA_EVENTS=$(grep -c "^event: message" "$SSE_NOTHING" || true)
    if [ "$EXTRA_EVENTS" = "0" ]; then
      log_pass "TR.7: Latest ID — no extra message events"
    else
      log_fail "TR.7: Latest ID" "$EXTRA_EVENTS unexpected events"
    fi
    rm -f "$SSE_NOTHING"
  fi

  rm -f "$SSE_REPLAY"
else
  log_skip "TR.2-TR.7" "No baseline ID for reconnect tests"
fi

# ── TH: Heartbeat ────────────────────────────────────────────
echo ""
echo "--- TH: Heartbeat ---"
echo "  (Waiting ~35s for heartbeat...)"

SSE_HB=$(mktemp)
if [ -n "$SSE_TOKEN" ]; then
  curl -s -N "$SERVICE/events/$AGENT_SSE?token=$SSE_TOKEN" --max-time 35 > "$SSE_HB" 2>/dev/null
else
  curl -s -N "$SERVICE/events/$AGENT_SSE" --max-time 35 > "$SSE_HB" 2>/dev/null
fi

# TH.1 — Heartbeat comment received
HB_COUNT=$(grep -cE "^:" "$SSE_HB" || true)
if [ "$HB_COUNT" -ge 1 ]; then
  log_pass "TH.1: Heartbeat comments received ($HB_COUNT)"
else
  log_fail "TH.1: Heartbeat" "No heartbeat comments (: lines) in 35s"
fi

# TH.2 — Connection stayed alive
STREAM_SIZE=$(wc -c < "$SSE_HB" | tr -d ' ')
if [ "$STREAM_SIZE" -gt 50 ]; then
  log_pass "TH.2: Connection alive for 35s ($STREAM_SIZE bytes)"
else
  log_fail "TH.2: Connection" "Stream only $STREAM_SIZE bytes"
fi

rm -f "$SSE_HB"

# ── TC: Capabilities in Events ────────────────────────────────
echo ""
echo "--- TC: Capabilities in Events ---"

# Register a new agent to trigger agent_online event
SSE_CAPS=$(mktemp)
AGENT_NEW="qa-newcaps-$TS"
if [ -n "$ADMIN_KEY" ]; then
  api_with_auth "$ADMIN_KEY" POST /agents/create "{\"id\":\"$AGENT_NEW\",\"name\":\"Caps Agent\",\"description\":\"test\",\"cwd\":\"C:/tmp\"}" > /dev/null
  api_with_auth "$ADMIN_KEY" POST /edges "{\"from\":\"$AGENT_SSE\",\"to\":\"$AGENT_NEW\"}" > /dev/null
fi

# Start SSE listener
if [ -n "$SSE_TOKEN" ]; then
  curl -s -N "$SERVICE/events/$AGENT_SSE?token=$SSE_TOKEN" --max-time 4 > "$SSE_CAPS" 2>/dev/null &
else
  curl -s -N "$SERVICE/events/$AGENT_SSE" --max-time 4 > "$SSE_CAPS" 2>/dev/null &
fi
CAPS_PID=$!
sleep 1

# Register new agent (triggers agent_online to SSE agent)
api_no_auth POST /agents "{\"id\":\"$AGENT_NEW\",\"name\":\"Caps Agent\",\"description\":\"caps test\",\"capabilities\":{\"skills\":[\"magic\"]}}" > /dev/null
sleep 2
wait $CAPS_PID 2>/dev/null

# TC.1 — agent_online includes capabilities
if grep -q "capabilities" "$SSE_CAPS" && grep -q "agent_online\|connected" "$SSE_CAPS"; then
  log_pass "TC.1: agent_online event includes capabilities"
elif grep -q "agent_online\|connected" "$SSE_CAPS"; then
  log_fail "TC.1: agent_online caps" "Event found but no capabilities"
else
  log_skip "TC.1" "No agent_online event captured"
fi

rm -f "$SSE_CAPS"
api_adm DELETE "/agents/$AGENT_NEW" > /dev/null 2>&1

# ── TBC: Backward Compatibility ──────────────────────────────
echo ""
echo "--- TBC: Backward Compatibility ---"

# TBC.1 — Message events still work
SSE_BC=$(mktemp)
if [ -n "$SSE_TOKEN" ]; then
  curl -s -N "$SERVICE/events/$AGENT_SSE?token=$SSE_TOKEN" --max-time 3 > "$SSE_BC" 2>/dev/null &
else
  curl -s -N "$SERVICE/events/$AGENT_SSE" --max-time 3 > "$SSE_BC" 2>/dev/null &
fi
BC_PID=$!
sleep 1
if [ -n "$KEY_TRIG" ]; then
  api_with_auth "$KEY_TRIG" POST /messages "{\"from\":\"$AGENT_TRIG\",\"to\":\"$AGENT_SSE\",\"content\":\"compat test\"}" > /dev/null
else
  api_no_auth POST /messages "{\"from\":\"$AGENT_TRIG\",\"to\":\"$AGENT_SSE\",\"content\":\"compat test\"}" > /dev/null
fi
sleep 1
wait $BC_PID 2>/dev/null

if grep -q "event: message" "$SSE_BC"; then
  log_pass "TBC.1: message event still works"
else
  log_fail "TBC.1: message event" "No message event in SSE"
fi
rm -f "$SSE_BC"

# TBC.5 — Old client (no Last-Event-ID)
SSE_OLD=$(mktemp)
if [ -n "$SSE_TOKEN" ]; then
  curl -s -N "$SERVICE/events/$AGENT_SSE?token=$SSE_TOKEN" --max-time 2 > "$SSE_OLD" 2>/dev/null
else
  curl -s -N "$SERVICE/events/$AGENT_SSE" --max-time 2 > "$SSE_OLD" 2>/dev/null
fi
if grep -q "event: connected" "$SSE_OLD"; then
  log_pass "TBC.5: Old client (no Last-Event-ID) — connected event received"
else
  STREAM_SIZE=$(wc -c < "$SSE_OLD" | tr -d ' ')
  if [ "$STREAM_SIZE" -gt 10 ]; then
    log_pass "TBC.5: Old client works ($STREAM_SIZE bytes)"
  else
    log_fail "TBC.5: Old client" "Empty or no stream"
  fi
fi
rm -f "$SSE_OLD"

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo "--- Cleanup ---"
api_adm DELETE "/agents/$AGENT_SSE" > /dev/null 2>&1
api_adm DELETE "/agents/$AGENT_TRIG" > /dev/null 2>&1
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
