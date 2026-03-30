import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import os from "node:os";
import type { Response, NextFunction } from "express";
import { DEFAULT_LAUNCH_CMD } from "./types.js";

/** Extract single route param (Express 5 types string | string[]) */
function param(req: express.Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}
import {
  createAgent,
  registerAgent,
  agentOfflineDelayed,
  cancelOfflineTimer,
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
  closeAllSSE,
  saveTopologyNow,
  validateAgentId,
  validateAgentName,
  validateDescription,
  validateMessageContent,
} from "./store.js";
import { generateApiKey, storeKey, removeKey, remapKey, initAdminKey, hasKey } from "./auth.js";
import { authenticate, requireAuth, requireAdmin, requireSelfOrAdmin, requireSenderMatch, getAuthMode } from "./middleware.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── CORS ────────────────────────────────────────────────────────

const CORS_ORIGINS = process.env.SWARM_CORS_ORIGINS || "*";

app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", CORS_ORIGINS);
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Auth Middleware (runs on all routes) ─────────────────────────

app.use(authenticate);

// ── Agent Registration ──────────────────────────────────────────

// Create agent from UI (offline) — Admin only
app.post("/agents/create", requireAdmin, (req, res) => {
  const { id, name, description, cwd } = req.body;
  const idErr = validateAgentId(id);
  if (idErr) { res.status(400).json({ error: idErr }); return; }
  const nameErr = validateAgentName(name);
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }
  if (!cwd || typeof cwd !== "string") { res.status(400).json({ error: "cwd is required" }); return; }
  if (description) {
    const descErr = validateDescription(description);
    if (descErr) { res.status(400).json({ error: descErr }); return; }
  }
  const agent = createAgent({ id, name, description: description || `Agent ${name}`, cwd });
  if (!agent) {
    res.status(409).json({ error: `ID "${id}" already exists` });
    return;
  }
  console.log(`+ Agent created: ${id} (${name}) [offline]`);
  res.json(agent);
});

// Register from plugin (online) — returns API key
// In enforce mode: agent must be pre-provisioned (created via /agents/create)
app.post("/agents", async (req, res) => {
  const { id, name, description, cwd, autoconnect } = req.body;
  const idErr = validateAgentId(id);
  if (idErr) { res.status(400).json({ error: idErr }); return; }
  const nameErr = validateAgentName(name);
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }
  const descErr = validateDescription(description);
  if (descErr) { res.status(400).json({ error: descErr }); return; }

  const mode = getAuthMode();
  // In enforce mode, agent must already exist (pre-provisioned)
  if (mode === "enforce") {
    const existing = getAgent(id);
    if (!existing) {
      res.status(403).json({ error: "Agent not pre-provisioned. Ask admin to create via POST /agents/create first." });
      return;
    }
  }

  const agent = registerAgent({ id, name, description, cwd, autoconnect });

  // Generate and store API key (even in off mode — forward-compatible)
  let apiKey: string | undefined;
  if (!hasKey(id)) {
    apiKey = generateApiKey();
    await storeKey(id, apiKey);
  }

  console.log(`+ Agent registered: ${id} (${name})${apiKey ? " [new key issued]" : ""}`);
  res.json(apiKey ? { agent, apiKey } : { agent });
});

// Reconnect existing agent (does NOT overwrite properties) — Agent+Admin
app.post("/agents/:id/connect", requireAuth, requireSelfOrAdmin("id"), (req, res) => {
  const agent = getAgent(param(req, "id"));
  if (!agent) {
    res.status(404).json({ error: "Agent not found. Use POST /agents to register first." });
    return;
  }
  setAgentStatus(param(req, "id"), "available");

  // Broadcast to connected peers
  const publicView = toPublicView(agent);
  for (const peer of getConnectedAgents(param(req, "id"))) {
    if (isOnline(peer.id)) {
      pushEvent(peer.id, "agent_online", publicView);
    }
  }

  const connected = getConnectedAgents(param(req, "id"));
  console.log(`↑ Agent reconnected: ${param(req, "id")} (${agent.name})`);
  res.json({ agent, connections: connected });
});

// Remove agent — Admin only
app.delete("/agents/:id", requireAdmin, async (req, res) => {
  const ok = removeAgent(param(req, "id"));
  if (ok) {
    await removeKey(param(req, "id"));
    console.log(`- Agent removed: ${param(req, "id")}`);
  }
  res.json({ ok });
});

// Update agent properties — Admin only
app.patch("/agents/:id", requireAdmin, async (req, res) => {
  const newId = req.body.id;
  if (newId && newId !== param(req, "id")) {
    const idErr = validateAgentId(newId);
    if (idErr) { res.status(400).json({ error: idErr }); return; }
    const existing = getAgent(newId);
    if (existing) {
      res.status(409).json({ error: `ID "${newId}" is already taken` });
      return;
    }
  }
  const agent = updateAgent(param(req, "id"), req.body);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  // Remap key if ID changed
  if (newId && newId !== param(req, "id")) {
    await remapKey(param(req, "id"), newId);
    console.log(`~ Agent renamed: ${param(req, "id")} → ${newId}`);
  } else {
    console.log(`~ Agent updated: ${param(req, "id")}`);
  }
  res.json(agent);
});

// Set status — Agent (self) or Admin
app.patch("/agents/:id/status", requireAuth, requireSelfOrAdmin("id"), (req, res) => {
  const { status } = req.body;
  if (!["available", "busy", "offline"].includes(status)) {
    res.status(400).json({ error: "status must be available|busy|offline" });
    return;
  }
  setAgentStatus(param(req, "id"), status);
  res.json({ ok: true });
});

// ── Agent Discovery — Agent+Admin ───────────────────────────────

app.get("/agents", requireAuth, (req, res) => {
  const all = req.query.all === "true";
  const agents = all ? getAgents() : getActiveAgents();
  res.json(agents.map(toPublicView));
});

app.get("/agents/:id", requireAuth, (req, res) => {
  const agent = getAgent(param(req, "id"));
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(agent);
});

app.get("/agents/:id/connections", requireAuth, (req, res) => {
  const connected = getConnectedAgents(param(req, "id"));
  res.json(connected);
});

// ── Topology — Admin for full, Agent for public ─────────────────

app.get("/topology", requireAuth, (req, res) => {
  const topo = getTopology();
  if (req.query.full === "true" && req.authAgent?.isAdmin) {
    res.json(topo);
    return;
  }
  // Public view (default)
  const publicNodes: Record<string, ReturnType<typeof toPublicView>> = {};
  for (const [id, agent] of Object.entries(topo.nodes)) {
    publicNodes[id] = toPublicView(agent as any);
  }
  res.json({ nodes: publicNodes, edges: topo.edges });
});

// Edge management — Admin only
app.post("/edges", requireAdmin, (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) {
    res.status(400).json({ error: "from, to required" });
    return;
  }
  const ok = addEdge(from, to);
  console.log(ok ? `🔗 Edge added: ${from} ↔ ${to}` : `Edge already exists: ${from} ↔ ${to}`);
  res.json({ ok });
});

app.delete("/edges", requireAdmin, (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) {
    res.status(400).json({ error: "from, to required" });
    return;
  }
  const ok = removeEdge(from, to);
  if (ok) console.log(`✂ Edge removed: ${from} ↔ ${to}`);
  res.json({ ok });
});

// ── Messages — Agent+Admin, sender must match ───────────────────

app.post("/messages", requireAuth, requireSenderMatch, (req, res) => {
  const { from, to, content } = req.body;
  if (!from || !to) {
    res.status(400).json({ error: "from, to, content required" });
    return;
  }
  const contentErr = validateMessageContent(content);
  if (contentErr) { res.status(400).json({ error: contentErr }); return; }
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

app.post("/messages/broadcast", requireAuth, requireSenderMatch, (req, res) => {
  const { from, content } = req.body;
  if (!from) {
    res.status(400).json({ error: "from, content required" });
    return;
  }
  const contentErr = validateMessageContent(content);
  if (contentErr) { res.status(400).json({ error: contentErr }); return; }
  const delivered = broadcastMessage(from, content);
  console.log(`📢 ${from} broadcast → ${delivered} delivered`);
  res.json({ delivered });
});

// ── Launch Agent — Admin only ───────────────────────────────────

function launchTerminal(cwd: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    let shellCmd: string;

    if (platform === "win32") {
      shellCmd = `start cmd /k "cd /d "${cwd}" && ${command}"`;
    } else if (platform === "darwin") {
      shellCmd = `osascript -e 'tell application "Terminal" to do script "cd ${cwd.replace(/'/g, "\\'")} && ${command}"'`;
    } else {
      shellCmd = `x-terminal-emulator -e bash -c "cd '${cwd}' && ${command}; exec bash" 2>/dev/null || gnome-terminal -- bash -c "cd '${cwd}' && ${command}; exec bash" 2>/dev/null || xterm -e bash -c "cd '${cwd}' && ${command}; exec bash"`;
    }

    exec(shellCmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

app.post("/agents/:id/launch", requireAdmin, async (req, res) => {
  const agent = getAgent(param(req, "id"));
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

  const configPath = path.join(agent.cwd, ".swarm-agent.json");
  await fs.writeFile(configPath, JSON.stringify({ id: agent.id, autoconnect: true }, null, 2));

  await launchTerminal(agent.cwd, agent.launchCommand || DEFAULT_LAUNCH_CMD);
  console.log(`🚀 Launched agent: ${param(req, "id")} in ${agent.cwd}`);
  res.json({ ok: true, cwd: agent.cwd });
});

// ── SSE Event Stream — Agent (self) or Admin ────────────────────

app.get("/events/:agentId", requireAuth, requireSelfOrAdmin("agentId"), (req, res) => {
  const agentId = param(req, "agentId");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ agentId })}\n\n`);

  cancelOfflineTimer(agentId);

  addSSE(agentId, res);
  console.log(`⚡ SSE connected: ${agentId}`);

  req.on("close", () => {
    removeSSE(agentId, res);
    if (getAgent(agentId)) {
      agentOfflineDelayed(agentId);
      console.log(`⚡ SSE disconnected: ${agentId} (grace period 5s)`);
    } else {
      console.log(`⚡ SSE closed: ${agentId} (agent was removed)`);
    }
  });
});

// ── Health — Public (no auth) ───────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    authMode: getAuthMode(),
    agents: getActiveAgents().length,
    totalAgents: getAgents().length,
    uptime: process.uptime(),
  });
});

// ── Error Handling ──────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err.message, err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start & Graceful Shutdown ───────────────────────────────────

// Initialize admin key
const adminKey = initAdminKey();

const server = app.listen(PORT, HOST, () => {
  console.log(`Swarm Service running at http://${HOST}:${PORT}`);
  console.log(`Auth mode: ${getAuthMode()}`);
  if (adminKey) {
    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  ADMIN API KEY (save this — shown only once):               ║`);
    console.log(`║  ${adminKey}  ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  }
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);

  server.close(() => {
    console.log("HTTP server closed.");
  });

  closeAllSSE();
  console.log("All SSE connections closed.");

  try {
    await saveTopologyNow();
    console.log("Topology saved.");
  } catch (err) {
    console.error("Failed to save topology on shutdown:", err);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
