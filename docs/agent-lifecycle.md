# Agent Lifecycle

## 1. First Registration

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant P as Plugin
    participant S as Service
    participant UI as Admin UI

    CC->>P: Start (no .swarm-agent.json)
    P->>CC: "Not registered. Use register."

    Note over CC: Inspects own capabilities:<br/>Skills, MCPs, CLAUDE.md,<br/>Workspace context...

    CC->>P: register(id, name, description)
    P->>S: POST /agents
    S->>S: Store agent in topology.json
    S-->>P: { agent }
    P->>P: Save .swarm-agent.json<br/>{ id, autoconnect: true }
    P->>CC: "Registered. No connections yet —<br/>admin needs to add you to topology."

    Note over S: Agent is ONLINE but ISOLATED<br/>(no edges = no communication)
```

## 2. Admin Connects Agents (Edge)

```mermaid
sequenceDiagram
    participant UI as Admin UI
    participant S as Service
    participant A as Agent A (Plugin)
    participant B as Agent B (Plugin)

    UI->>S: POST /edges { from: A, to: B }
    S->>S: Add edge, save topology

    par Notify both sides
        S->>A: SSE: connected_to { B.name, B.publicDescription }
        S->>B: SSE: connected_to { A.name, A.publicDescription }
    end

    A->>A: Claude sees: "New connection: Agent B — description"
    B->>B: Claude sees: "New connection: Agent A — description"

    Note over A,B: A ↔ B can now communicate
```

## 3. Reconnect (Next Startup)

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant P as Plugin
    participant S as Service
    participant Peers as Connected Agents

    CC->>P: Start (.swarm-agent.json exists)
    P->>P: Load { id: "agent-a", autoconnect: true }
    P->>S: POST /agents/agent-a/connect

    alt Agent known to service
        S->>S: Set status → "available"
        S-->>P: { agent, connections[] }
        S->>Peers: SSE: agent_online { name, publicDescription }
        P->>P: Connect SSE
        P->>CC: "Reconnected as Agent A.<br/>Connected to: B (online), C (offline).<br/>If capabilities changed, use update_profile."

        Note over CC: Claude checks:<br/>"Do I have new skills/MCPs?"

        opt Capabilities changed
            CC->>P: update_profile(description: "...new stuff...")
            P->>S: PATCH /agents/agent-a { description }
        end

    else Agent NOT in service (deleted/new service)
        S-->>P: 404
        P->>CC: "Auto-connect failed. Use register."
    end
```

## 4. Agent Updates Own Profile

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant P as Plugin
    participant S as Service

    Note over CC: Notices new MCP installed,<br/>learned new skill, etc.

    CC->>P: update_profile(description: "...now with Postgres MCP...")
    P->>S: PATCH /agents/:id { description }
    S->>S: Update store, save topology
    S-->>P: SSE: properties_updated
    S-->>P: { updated agent }
    P->>CC: "Profile updated."
```

## 5. Admin Changes Properties in UI

```mermaid
sequenceDiagram
    participant UI as Admin UI
    participant S as Service
    participant A as Agent (Plugin)
    participant Peers as Connected Agents

    UI->>S: PATCH /agents/:id { name, description }
    S->>S: Update store, save topology
    S->>A: SSE: properties_updated { name, description }
    A->>A: Claude sees: "Properties updated by admin.<br/>No action required."
```

## 6. Admin Changes Agent ID in UI

```mermaid
sequenceDiagram
    participant UI as Admin UI
    participant S as Service
    participant A as Agent (Plugin)
    participant Peers as Connected Agents

    UI->>S: PATCH /agents/old-id { id: "new-id" }

    alt new-id is available
        S->>S: Rename in agents map
        S->>S: Update all edges: old-id → new-id
        S->>S: Move SSE connections: old-id → new-id
        S->>S: Save topology

        S->>A: SSE: properties_updated { id: "new-id" }
        A->>A: agentId = "new-id"
        A->>A: Update .swarm-agent.json { id: "new-id" }
        A->>A: Claude sees: "Properties updated.<br/>No action required."

        S->>Peers: SSE: agent_renamed { oldId, newId, name }
        Peers->>Peers: Claude sees: "Agent renamed:<br/>old-id → new-id"

    else new-id already taken
        S-->>UI: 409 "ID already taken"
    end
```

## 7. Disconnect (Session Ends)

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant P as Plugin
    participant S as Service
    participant Peers as Connected Agents

    CC->>P: Ctrl+C / Session close
    P->>P: disconnectSSE()
    P->>S: SSE connection closes

    S->>S: agentOffline()<br/>status → "offline"<br/>save topology
    S->>Peers: SSE: agent_offline { id, name }
    Peers->>Peers: Claude sees: "Agent offline: Agent A"

    Note over S: Agent stays in topology.json<br/>Edges preserved<br/>Next start → Reconnect (Flow 3)
```

## 8. Service Restart

```mermaid
sequenceDiagram
    participant S as Service
    participant P1 as Plugin A
    participant P2 as Plugin B

    S->>S: Start, load topology.json
    S->>S: All agents → status: "offline"

    Note over P1,P2: SSE connections break

    loop Every 3 seconds
        P1->>S: POST /agents/a/connect
        P2->>S: POST /agents/b/connect
    end

    S->>S: Agents back to "available"
    S-->>P1: { agent, connections }
    S-->>P2: { agent, connections }

    Note over P1,P2: SSE reconnected,<br/>everything back to normal
```

## 9. Communication (Message Flow)

```mermaid
sequenceDiagram
    participant A as Agent A (Claude)
    participant PA as Plugin A
    participant S as Service
    participant PB as Plugin B
    participant B as Agent B (Claude)

    A->>PA: send_message(to: "agent-b", content: "Build the UI")
    PA->>S: POST /messages { from: A, to: B, content }

    alt A and B are connected (edge exists)
        alt B is online
            S->>PB: SSE: message { from, content }
            PB->>B: Channel notification:<br/>"Message from agent-a: Build the UI"
            S-->>PA: { delivered: true }
            PA->>A: "Message sent to agent-b (delivered)."
        else B is offline
            S-->>PA: { delivered: false }
            PA->>A: "Agent agent-b is offline.<br/>Message not delivered."
        end
    else No edge between A and B
        S-->>PA: { error: "No connection" }
        PA->>A: "Blocked: No connection between A and B"
    end
```

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> Unregistered: Claude Code starts<br/>(no .swarm-agent.json)
    [*] --> Reconnecting: Claude Code starts<br/>(.swarm-agent.json exists)

    Unregistered --> Registered: register()
    Reconnecting --> Online: POST /connect (200)
    Reconnecting --> Unregistered: POST /connect (404)

    Registered --> Online: SSE connected
    Online --> Online: send_message, update_profile, whoami
    Online --> Offline: SSE disconnects<br/>(Ctrl+C, crash, network)
    Offline --> Reconnecting: Plugin reconnect loop<br/>(every 3s)
    Online --> Unregistered: unregister()
    Online --> Online: properties_updated<br/>(admin changed in UI)
    Online --> Online: connected_to / disconnected_from<br/>(admin changed edges)
```
