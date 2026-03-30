#!/usr/bin/env bash
#
# Restart all agents connected to the given agent ID.
# Usage: ./scripts/restart-team.sh <agent-id>
#
# 1. Queries the service for connected agents (edges)
# 2. Kills their terminal sessions
# 3. Restarts each with claude --continue
#
# The calling agent is NOT restarted.

set -euo pipefail

SERVICE_URL="${SWARM_URL:-http://127.0.0.1:3001}"
AGENT_ID="${1:?Usage: restart-team.sh <agent-id>}"
LAUNCH_PROMPT="${2:-Swarm wurde neugestartet. Du bist wieder online. Mach weiter mit deiner Arbeit.}"

echo "=== Restart Team for $AGENT_ID ==="
echo "Service: $SERVICE_URL"

# Get connected agents
CONNECTIONS=$(curl -s "$SERVICE_URL/agents/$AGENT_ID/connections")

if [ "$CONNECTIONS" = "[]" ]; then
  echo "No connected agents found."
  exit 0
fi

# Parse agent IDs and cwds
AGENT_DATA=$(echo "$CONNECTIONS" | node -e "
  const d=[];
  process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',()=>{
    const agents=JSON.parse(d.join(''));
    agents.forEach(a=>{
      // Get full agent info for cwd and launchCommand
      fetch('$SERVICE_URL/agents/'+a.id)
        .then(r=>r.json())
        .then(info=>console.log(JSON.stringify({id:info.id,cwd:info.cwd,launchCommand:info.launchCommand})))
        .catch(()=>{});
    });
  });
")

# Wait for async output
sleep 2

echo ""
echo "=== Killing agent terminals ==="

# On Windows: find and kill cmd.exe windows running claude for each agent
# This is best-effort — we can't perfectly identify which terminal belongs to which agent
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
  # Kill all claude processes except our own (rough approach)
  echo "Killing claude processes..."
  tasklist //FI "IMAGENAME eq claude.exe" //FO CSV 2>/dev/null | grep -v "PID" | while IFS=, read -r name pid rest; do
    pid=$(echo "$pid" | tr -d '"')
    echo "  Killing PID $pid"
    taskkill //F //PID "$pid" 2>/dev/null || true
  done
fi

echo ""
echo "=== Restarting agents ==="

# Restart each connected agent
echo "$CONNECTIONS" | node -e "
  const {execSync}=require('child_process');
  const d=[];
  process.stdin.on('data',c=>d.push(c));
  process.stdin.on('end',async()=>{
    const agents=JSON.parse(d.join(''));
    for(const a of agents){
      try{
        const r=await fetch('$SERVICE_URL/agents/'+a.id);
        const info=await r.json();
        if(!info.cwd){console.log('  SKIP '+a.id+' (no cwd)');continue;}
        const cmd=info.launchCommand||'claude --continue --dangerously-load-development-channels plugin:swarm@swarm-channel --dangerously-skip-permissions';
        const fullCmd=cmd+' \"$LAUNCH_PROMPT\"';
        console.log('  Launching '+a.id+' in '+info.cwd);
        if(process.platform==='win32'){
          execSync('start cmd /k \"cd /d \"'+info.cwd+'\" && '+fullCmd+'\"',{stdio:'ignore'});
        }else if(process.platform==='darwin'){
          execSync('osascript -e \\'tell application \"Terminal\" to do script \"cd '+info.cwd.replace(/'/g,\"\\\\'\")+' && '+fullCmd+'\"\\''  ,{stdio:'ignore'});
        }else{
          execSync('x-terminal-emulator -e bash -c \"cd \\''+info.cwd+'\\' && '+fullCmd+'; exec bash\" 2>/dev/null || gnome-terminal -- bash -c \"cd \\''+info.cwd+'\\' && '+fullCmd+'; exec bash\"',{stdio:'ignore'});
        }
      }catch(e){console.log('  FAILED '+a.id+': '+e.message);}
    }
  });
"

echo ""
echo "=== Done ==="
