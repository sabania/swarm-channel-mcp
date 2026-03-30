# Swarm Channel MCP

Multi-agent swarm communication system for Claude Code. Agents register, discover each other, and communicate in real-time through a central service with graph-based topology.

## Vision

Das Ziel ist ein System mit dem Companies ihr gesamtes Organigramm als Agent-Swarm abbilden können:

- **Jeder Mitarbeiter** bekommt einen AI Agent der ihn repräsentiert
- **Mitarbeiter ↔ Agent**: Tasks zuweisen, chatten, Agent lernt den Mitarbeiter kennen
- **Kommunikationspfade** bilden die echte Firmenstruktur ab (Hierarchie, Teams, Abteilungen)
- **Orchestrierungsmuster** ergeben sich aus der Topologie (wer mit wem verbunden ist)
- **Gruppen**: Teams, Abteilungen, ganze Companies als Subgraphen
- **Skalierbar**: Von kleinem Team bis Enterprise mit hunderten Agents

## Project Structure

```
swarm_channel_mcp/
├── service/          ← Central HTTP broker (Express, REST API, SSE push)
│   └── src/
│       ├── index.ts  ← Routes, launch, SSE endpoints
│       ├── store.ts  ← In-memory store, topology, messaging
│       └── types.ts  ← AgentInfo, SwarmTopology, defaults
├── plugin/           ← MCP channel plugin for Claude Code (stdio)
│   └── src/
│       └── index.ts  ← Tools, SSE client, channel notifications
├── ui/               ← React web UI for topology management
│   └── src/
│       ├── App.tsx       ← Main app, React Flow graph
│       ├── AgentNode.tsx ← Node component
│       ├── AgentPanel.tsx ← Detail/edit panel
│       ├── CreateAgentDialog.tsx
│       └── api.ts        ← Service API client
├── scripts/          ← Automation scripts
│   └── restart-team.sh  ← Restart all connected agents
└── docs/             ← Documentation
```

## Build

```bash
# Service
cd service && npm install && npx tsc

# Plugin (esbuild bundle)
cd plugin && npm install && npm run build

# UI
cd ui && npm install
```

## Run

```bash
# 1. Service (must run first)
cd service && node dist/index.js
# → http://127.0.0.1:3001

# 2. UI
cd ui && npx vite --port 5173
# → http://localhost:5173

# 3. Claude Code with plugin
claude --continue --dangerously-load-development-channels plugin:swarm@swarm-channel
```

## Development Workflow

### Git
- Agents arbeiten in eigenen Git Worktrees (erstellen sie selbst)
- Feature Branches → PR → Review → Merge in master
- Lead Architect merged und erstellt RC (Release Candidate)

### Testing (Live)
Das Swarm-System wird live getestet — die Dev-Agents nutzen das System das sie entwickeln:

1. **Agents entwickeln** in Worktrees (Service-Dev, Plugin-Dev, UI-Dev)
2. **Lead Architect merged** zu einem RC Branch
3. **Lead Architect baut** Service + Plugin + UI aus dem RC
4. **Lead Architect führt `scripts/restart-team.sh` aus** → killt laufende Agent-Terminals, startet alle neu
5. **Alle Agents testen live** — sie nutzen den neuen Code und merken sofort ob was kaputt ist
6. **Bei Problemen**: Agents melden über Swarm → zurück zu Schritt 1
7. **Wenn stabil**: RC → master mergen

### Restart-Script
```bash
# Startet alle verbundenen Agents des Callers neu
./scripts/restart-team.sh <architect-agent-id>
```
- Fragt Service nach verbundenen Agents
- Killt deren Terminals
- Startet sie neu mit `--continue` (Konversation bleibt erhalten)
- Verwendet `--dangerously-skip-permissions` für unattended Start

## Service API

- `POST /agents` — Register agent (from plugin)
- `POST /agents/create` — Create agent (from UI, offline)
- `POST /agents/:id/connect` — Reconnect existing agent
- `PATCH /agents/:id` — Update agent properties (including ID change)
- `DELETE /agents/:id` — Remove agent
- `GET /agents` — List active agents (`?all=true` includes offline)
- `GET /agents/:id/connections` — List connected agents (graph edges)
- `POST /edges` — Add connection `{ from, to }`
- `DELETE /edges` — Remove connection `{ from, to }`
- `GET /topology` — Full topology (nodes + edges)
- `POST /messages` — Send message `{ from, to, content }` (fire and forget)
- `POST /messages/broadcast` — Broadcast to connected agents
- `GET /events/:agentId` — SSE stream
- `POST /agents/:id/launch` — Open terminal with Claude Code
- `GET /health` — Service health

## Plugin Tools

`register`, `whoami`, `update_profile`, `unregister`, `list_agents`, `discover`, `send_message`, `broadcast`, `set_status`

## Key Concepts

- **Graph topology**: Agents are nodes, edges define who can communicate. No edge = isolated.
- **Fire and forget**: Messages are not stored. If recipient is offline, message is lost.
- **SSE push**: Real-time notifications (agent online/offline, messages, connection changes)
- **Description-based**: Free-text description instead of fixed capabilities. Claude matches intelligently.
- **Auto-connect**: `.swarm-agent.json` in cwd stores agent ID for automatic reconnection.
- **Grace period**: 5s delay before marking agent offline (prevents SSE flicker).

## Marketplace

Plugin is distributed via GitHub marketplace:
```
/plugin marketplace add sabania/swarm-channel-mcp
/plugin install swarm@swarm-channel
```
