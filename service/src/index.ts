import express from "express";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import os from "node:os";
import { DEFAULT_LAUNCH_CMD } from "./types.js";
import {
  createAgent,
  registerAgent,
  agentOffline,
  removeAgent,
  updateAgent,
  setAgentStatus,
  getAgent,
  getAgents,
  getActiveAgents,
  getConnectedAgents,
  sendMessage,
  broadcastMessage,
  addEdge,
  removeEdge,
  getTopology,
  addSSE,
  removeSSE,
  toPublicView,
  pushEvent,
  isOnline,
} from "./store.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Agent Registration ──────────────────────────────────────────

// Create agent from UI (offline)
app.post("/agents/create", (req, res) => {
  const { id, name, description, cwd } = req.body;
  if (!id || !name || !cwd) {
    res.status(400).json({ error: "id, name, cwd required" });
    return;
  }
  const agent = createAgent({ id, name, description: description || `Agent ${name}`, cwd });
  if (!agent) {
    res.status(409).json({ error: `ID "${id}" already exists` });
    return;
  }
  console.log(`+ Agent created: ${id} (${name}) [offline]`);
  res.json(agent);
});

// Register from plugin (online)
app.post("/agents", (req, res) => {
  const { id, name, description, cwd, autoconnect } = req.body;
  if (!id || !name || !description) {
    res.status(400).json({ error: "id, name, description required" });
    return;
  }
  const agent = registerAgent({ id, name, description, cwd, autoconnect });
  console.log(`+ Agent registered: ${id} (${name})`);
  res.json(agent);
});

// Reconnect existing agent (does NOT overwrite properties)
app.post("/agents/:id/connect", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found. Use POST /agents to register first." });
    return;
  }
  setAgentStatus(req.params.id, "available");

  // Broadcast to connected peers
  const publicView = toPublicView(agent);
  for (const peer of getConnectedAgents(req.params.id)) {
    if (isOnline(peer.id)) {
      pushEvent(peer.id, "agent_online", publicView);
    }
  }

  const connected = getConnectedAgents(req.params.id);
  console.log(`↑ Agent reconnected: ${req.params.id} (${agent.name})`);
  res.json({ agent, connections: connected });
});

app.delete("/agents/:id", (req, res) => {
  const ok = removeAgent(req.params.id);
  if (ok) console.log(`- Agent removed: ${req.params.id}`);
  res.json({ ok });
});

app.patch("/agents/:id", (req, res) => {
  const newId = req.body.id;
  if (newId && newId !== req.params.id) {
    const existing = getAgent(newId);
    if (existing) {
      res.status(409).json({ error: `ID "${newId}" is already taken` });
      return;
    }
  }
  const agent = updateAgent(req.params.id, req.body);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  console.log(newId && newId !== req.params.id
    ? `~ Agent renamed: ${req.params.id} → ${newId}`
    : `~ Agent updated: ${req.params.id}`);
  res.json(agent);
});

app.patch("/agents/:id/status", (req, res) => {
  const { status } = req.body;
  if (!["available", "busy", "offline"].includes(status)) {
    res.status(400).json({ error: "status must be available|busy|offline" });
    return;
  }
  setAgentStatus(req.params.id, status);
  res.json({ ok: true });
});

// ── Agent Discovery ─────────────────────────────────────────────

app.get("/agents", (req, res) => {
  const all = req.query.all === "true";
  res.json(all ? getAgents() : getActiveAgents());
});

app.get("/agents/:id", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(agent);
});

app.get("/agents/:id/connections", (req, res) => {
  const connected = getConnectedAgents(req.params.id);
  res.json(connected);
});

// ── Topology ────────────────────────────────────────────────────

app.get("/topology", (_req, res) => {
  res.json(getTopology());
});

app.post("/edges", (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) {
    res.status(400).json({ error: "from, to required" });
    return;
  }
  const ok = addEdge(from, to);
  console.log(ok ? `🔗 Edge added: ${from} ↔ ${to}` : `Edge already exists: ${from} ↔ ${to}`);
  res.json({ ok });
});

app.delete("/edges", (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) {
    res.status(400).json({ error: "from, to required" });
    return;
  }
  const ok = removeEdge(from, to);
  if (ok) console.log(`✂ Edge removed: ${from} ↔ ${to}`);
  res.json({ ok });
});

// ── Messages (fire and forget) ──────────────────────────────────

app.post("/messages", (req, res) => {
  const { from, to, content } = req.body;
  if (!from || !to || !content) {
    res.status(400).json({ error: "from, to, content required" });
    return;
  }
  const target = getAgent(to);
  if (!target) {
    res.status(404).json({ error: `Agent "${to}" not found` });
    return;
  }
  const result = sendMessage(from, to, content);
  if (result.error) {
    console.log(`✉ ${from} → ${to} [blocked]: ${result.error}`);
  } else {
    console.log(`✉ ${from} → ${to} [${result.delivered ? "delivered" : "offline"}]: ${content.slice(0, 60)}`);
  }
  res.json(result);
});

app.post("/messages/broadcast", (req, res) => {
  const { from, content } = req.body;
  if (!from || !content) {
    res.status(400).json({ error: "from, content required" });
    return;
  }
  const delivered = broadcastMessage(from, content);
  console.log(`📢 ${from} broadcast → ${delivered} delivered`);
  res.json({ delivered });
});

// ── Launch Agent ────────────────────────────────────────────────

function launchTerminal(cwd: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    let shellCmd: string;

    if (platform === "win32") {
      shellCmd = `start cmd /k "cd /d "${cwd}" && ${command}"`;
    } else if (platform === "darwin") {
      shellCmd = `osascript -e 'tell application "Terminal" to do script "cd ${cwd.replace(/'/g, "\\'")} && ${command}"'`;
    } else {
      // Linux: try common terminal emulators
      shellCmd = `x-terminal-emulator -e bash -c "cd '${cwd}' && ${command}; exec bash" 2>/dev/null || gnome-terminal -- bash -c "cd '${cwd}' && ${command}; exec bash" 2>/dev/null || xterm -e bash -c "cd '${cwd}' && ${command}; exec bash"`;
    }

    exec(shellCmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

app.post("/agents/:id/launch", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!agent.cwd) {
    res.status(400).json({ error: "Agent has no working directory set" });
    return;
  }
  if (agent.status !== "offline") {
    res.status(409).json({ error: "Agent is already online" });
    return;
  }

  try {
    // Create .swarm-agent.json so plugin auto-connects with this ID
    const configPath = path.join(agent.cwd, ".swarm-agent.json");
    fs.writeFileSync(configPath, JSON.stringify({ id: agent.id, autoconnect: true }, null, 2));

    await launchTerminal(agent.cwd, agent.launchCommand || DEFAULT_LAUNCH_CMD);
    console.log(`🚀 Launched agent: ${req.params.id} in ${agent.cwd}`);
    res.json({ ok: true, cwd: agent.cwd });
  } catch (err) {
    console.error(`Failed to launch agent ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to open terminal" });
  }
});

// ── SSE Event Stream ────────────────────────────────────────────

app.get("/events/:agentId", (req, res) => {
  const { agentId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ agentId })}\n\n`);

  addSSE(agentId, res);
  console.log(`⚡ SSE connected: ${agentId}`);

  req.on("close", () => {
    removeSSE(agentId, res);
    // Only set offline if agent still exists (not removed)
    if (getAgent(agentId)) {
      agentOffline(agentId);
      console.log(`⚡ SSE disconnected: ${agentId} (now offline)`);
    } else {
      console.log(`⚡ SSE closed: ${agentId} (agent was removed)`);
    }
  });
});

// ── Health ──────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    agents: getActiveAgents().length,
    totalAgents: getAgents().length,
    uptime: process.uptime(),
  });
});

// ── Start ───────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`Swarm Service running at http://${HOST}:${PORT}`);
});
