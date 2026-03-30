#!/usr/bin/env bash
#
# Restart all agents connected to the given agent ID.
# Usage: ./scripts/restart-team.sh <agent-id> [prompt]
#
# 1. Queries the service for connected agents (edges)
# 2. Kills their terminal sessions
# 3. Restarts each with claude --continue in a titled terminal
#
# The calling agent is NOT restarted.

set -euo pipefail

SERVICE_URL="${SWARM_URL:-http://127.0.0.1:3001}"
AGENT_ID="${1:?Usage: restart-team.sh <agent-id> [prompt]}"
LAUNCH_PROMPT="${2:-Swarm wurde neugestartet. Du bist wieder online. Mach weiter mit deiner Arbeit.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Restart Team for $AGENT_ID ==="
echo "Service: $SERVICE_URL"

echo ""
echo "=== Killing agent terminals ==="

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
  echo "Killing claude processes..."
  tasklist //FI "IMAGENAME eq claude.exe" //FO CSV 2>/dev/null | grep -v "PID" | while IFS=, read -r name pid rest; do
    pid=$(echo "$pid" | tr -d '"')
    echo "  Killing PID $pid"
    taskkill //F //PID "$pid" 2>/dev/null || true
  done
else
  echo "Killing claude processes..."
  pkill -f "claude.*swarm" 2>/dev/null || true
fi

sleep 2

echo ""
echo "=== Launching agents ==="

node "$SCRIPT_DIR/launch-agents.mjs" "$SERVICE_URL" "$AGENT_ID" "$LAUNCH_PROMPT"

echo ""
echo "=== Done ==="
