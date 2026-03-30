import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import os from "node:os";
import type { Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { DEFAULT_LAUNCH_CMD } from "./types.js";
import { logger } from "./logger.js";

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
  toPublicViewWithCapabilities,
  replayEvents,
  pushEvent,
  isOnline,
  closeAllSSE,
  saveTopologyNow,
  getSSEMetrics,
  validateAgentId,
  validateAgentName,
  validateDescription,
  validateMessageContent,
} from "./store.js";
import { isValidTransition, type TaskStatus } from "./types.js";
import { generateApiKey, storeKey, removeKey, remapKey, initAdminKey, hasKey } from "./auth.js";
import { authenticate, requireAuth, requireAdmin, requireSelfOrAdmin, requireSenderMatch, getAuthMode } from "./middleware.js";
import {
  createTask, getTask, getTaskDetail, updateTaskStatus, addTaskMessage, addTaskArtifact,
  listTasks, deleteTask, getPendingTasksForAgent, startCleanupTimer, closeDb, getTaskMetrics, checkDbHealth,
} from "./db.js";
import { areConnected } from "./store.js";

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

// ── Security Headers ────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── Request-ID Tracking ─────────────────────────────────────────

app.use((req, _res, next) => {
  (req as any).id = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  _res.setHeader("X-Request-ID", (req as any).id);
  next();
});

// ── Request Logging ─────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    // Skip SSE and health noise
    if (req.path.startsWith("/events/") || req.path === "/health") return;
    logger.info({
      event: "http_request",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      requestId: (req as any).id,
      agentId: req.authAgent?.id,
    });
  });
  next();
});

// ── Rate Limiting ───────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.authAgent?.id || req.ip || "unknown",
});
app.use(globalLimiter);

const messageLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.authAgent?.id || req.ip || "unknown",
  message: { error: "Too many messages — max 10/second" },
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
  logger.info({ event: "agent_created", agentId: id, name });
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

  const agent = registerAgent({ id, name, description, cwd, autoconnect, capabilities: req.body.capabilities });

  // Generate and store API key (even in off mode — forward-compatible)
  let apiKey: string | undefined;
  if (!hasKey(id)) {
    apiKey = generateApiKey();
    await storeKey(id, apiKey);
  }

  logger.info({ event: "agent_registered", agentId: id, name, newKey: !!apiKey });
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

  // Broadcast to connected peers (with capabilities)
  const publicView = toPublicViewWithCapabilities(agent);
  for (const peer of getConnectedAgents(param(req, "id"))) {
    if (isOnline(peer.id)) {
      pushEvent(peer.id, "agent_online", publicView);
    }
  }

  const connected = getConnectedAgents(param(req, "id"));
  logger.info({ event: "agent_reconnected", agentId: param(req, "id"), name: agent.name });

  // Deliver pending tasks via SSE (deferred so SSE connection is established first)
  const agentIdForPending = param(req, "id");
  setTimeout(() => {
    const pending = getPendingTasksForAgent(agentIdForPending);
    for (const task of pending) {
      if (isOnline(agentIdForPending)) {
        pushEvent(agentIdForPending, "task_created", task);
      }
    }
    if (pending.length > 0) {
      logger.info({ event: "pending_tasks_delivered", agentId: agentIdForPending, count: pending.length });
    }
  }, 1000);

  res.json({ agent, connections: connected });
});

// Remove agent — Admin only
app.delete("/agents/:id", requireAdmin, async (req, res) => {
  const ok = removeAgent(param(req, "id"));
  if (ok) {
    await removeKey(param(req, "id"));
    logger.info({ event: "agent_removed", agentId: param(req, "id") });
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
    logger.info({ event: "agent_renamed", oldId: param(req, "id"), newId });
  } else {
    logger.info({ event: "agent_updated", agentId: param(req, "id") });
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
  let connected = getConnectedAgents(param(req, "id"));

  // Capability filtering: ?skills=X,Y&domains=Z
  const skillsFilter = typeof req.query.skills === "string" ? req.query.skills.split(",") : null;
  const domainsFilter = typeof req.query.domains === "string" ? req.query.domains.split(",") : null;

  if (skillsFilter || domainsFilter) {
    connected = connected.filter((agent) => {
      const full = getAgent(agent.id);
      if (!full?.capabilities) return false;
      if (skillsFilter && !skillsFilter.some((s) => full.capabilities?.skills?.includes(s))) return false;
      if (domainsFilter && !domainsFilter.some((d) => full.capabilities?.domains?.includes(d))) return false;
      return true;
    });
  }

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
  logger.info({ event: ok ? "edge_added" : "edge_exists", from, to });
  res.json({ ok });
});

app.delete("/edges", requireAdmin, (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) {
    res.status(400).json({ error: "from, to required" });
    return;
  }
  const ok = removeEdge(from, to);
  if (ok) logger.info({ event: "edge_removed", from, to });
  res.json({ ok });
});

// ── Messages — Agent+Admin, sender must match ───────────────────

app.post("/messages", messageLimiter, requireAuth, requireSenderMatch, (req, res) => {
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
    logger.info({ event: "message_blocked", from, to, reason: result.error });
  } else {
    logger.info({ event: "message_sent", from, to, delivered: result.delivered });
  }
  res.json(result);
});

app.post("/messages/broadcast", messageLimiter, requireAuth, requireSenderMatch, (req, res) => {
  const { from, content } = req.body;
  if (!from) {
    res.status(400).json({ error: "from, content required" });
    return;
  }
  const contentErr = validateMessageContent(content);
  if (contentErr) { res.status(400).json({ error: contentErr }); return; }
  const delivered = broadcastMessage(from, content);
  logger.info({ event: "broadcast_sent", from, delivered });
  res.json({ delivered });
});

// ── Tasks (A2A-compatible) ──────────────────────────────────────

// Create task — requireAuth, sender must be connected to receiver
app.post("/tasks", messageLimiter, requireAuth, (req, res) => {
  const { toAgent, title, contextId, ttlSeconds, metadata } = req.body;
  const fromAgent = req.authAgent?.isAdmin ? req.body.fromAgent : (req.authAgent?.id || req.body.fromAgent);
  if (!fromAgent || !toAgent) {
    res.status(400).json({ error: "fromAgent and toAgent required" });
    return;
  }
  if (!req.authAgent?.isAdmin && !areConnected(fromAgent, toAgent)) {
    res.status(403).json({ error: `No connection between ${fromAgent} and ${toAgent}` });
    return;
  }
  const task = createTask({ fromAgent, toAgent, title, contextId, ttlSeconds, metadata });

  // Push SSE event to receiver
  if (isOnline(toAgent)) {
    pushEvent(toAgent, "task_created", task);
  }
  logger.info({ event: "task_created", taskId: task.id, fromAgent, toAgent });
  res.status(201).json(task);
});

// Get task detail — sender, receiver, or admin
app.get("/tasks/:id", requireAuth, (req, res) => {
  const task = getTaskDetail(param(req, "id"));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (getAuthMode() !== "off" && !req.authAgent?.isAdmin && req.authAgent?.id !== task.fromAgent && req.authAgent?.id !== task.toAgent) {
    res.status(403).json({ error: "Access denied — only sender, receiver, or admin can view this task" });
    return;
  }
  res.json(task);
});

// Update task status — assigned agent (toAgent) or admin, valid transition only
app.patch("/tasks/:id", requireAuth, (req, res) => {
  const task = getTask(param(req, "id"));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (getAuthMode() !== "off" && !req.authAgent?.isAdmin && req.authAgent?.id !== task.toAgent && req.authAgent?.id !== task.fromAgent) {
    res.status(403).json({ error: "Only assigned agent, sender, or admin can update task status" });
    return;
  }
  const { status } = req.body;
  if (!status || !isValidTransition(task.status, status)) {
    res.status(400).json({ error: `Invalid transition: ${task.status} → ${status}. Allowed: ${JSON.stringify(TASK_TRANSITIONS_FOR_ERROR(task.status))}` });
    return;
  }
  const updated = updateTaskStatus(task.id, status as TaskStatus);

  // Push SSE events to both parties
  for (const agentId of [task.fromAgent, task.toAgent]) {
    if (isOnline(agentId)) {
      pushEvent(agentId, "task_updated", updated);
    }
  }
  logger.info({ event: "task_updated", taskId: task.id, from: task.status, to: status });
  res.json(updated);
});

// Add message to task — sender or receiver only
app.post("/tasks/:id/messages", requireAuth, (req, res) => {
  const task = getTask(param(req, "id"));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const agentId = req.authAgent?.id || req.body.agentId || req.body.from;
  if (getAuthMode() !== "off" && !req.authAgent?.isAdmin && agentId !== task.fromAgent && agentId !== task.toAgent) {
    res.status(403).json({ error: "Only sender or receiver can add messages" });
    return;
  }
  const { content } = req.body;
  if (!content || typeof content !== "string") {
    res.status(400).json({ error: "content is required" });
    return;
  }
  const role = agentId === task.fromAgent ? "sender" : "receiver";
  const message = addTaskMessage({ taskId: task.id, role, agentId: agentId!, content });

  // Push to the other party
  const otherAgent = agentId === task.fromAgent ? task.toAgent : task.fromAgent;
  if (isOnline(otherAgent)) {
    pushEvent(otherAgent, "task_message", { taskId: task.id, message });
  }
  res.status(201).json(message);
});

// Add artifact to task
app.post("/tasks/:id/artifacts", requireAuth, (req, res) => {
  const task = getTask(param(req, "id"));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (getAuthMode() !== "off" && !req.authAgent?.isAdmin && req.authAgent?.id !== task.toAgent && req.authAgent?.id !== task.fromAgent) {
    res.status(403).json({ error: "Only sender, receiver, or admin can add artifacts" });
    return;
  }
  const { name, mimeType, data } = req.body;
  if (!name || !data) {
    res.status(400).json({ error: "name and data required" });
    return;
  }
  const artifact = addTaskArtifact({ taskId: task.id, name, mimeType, data });

  // Push to both parties
  for (const agentId of [task.fromAgent, task.toAgent]) {
    if (isOnline(agentId)) {
      pushEvent(agentId, "task_artifact", { taskId: task.id, artifact });
    }
  }
  res.status(201).json(artifact);
});

// List tasks — filtered by query params
app.get("/tasks", requireAuth, (req, res) => {
  const tasks = listTasks({
    toAgent: typeof req.query.to === "string" ? req.query.to : undefined,
    fromAgent: typeof req.query.from === "string" ? req.query.from : undefined,
    status: typeof req.query.status === "string" ? req.query.status as TaskStatus : undefined,
    contextId: typeof req.query.contextId === "string" ? req.query.contextId : undefined,
  });
  res.json(tasks);
});

// Cancel/delete task
app.delete("/tasks/:id", requireAuth, (req, res) => {
  const task = getTask(param(req, "id"));
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (getAuthMode() !== "off" && !req.authAgent?.isAdmin && req.authAgent?.id !== task.fromAgent) {
    res.status(403).json({ error: "Only sender or admin can cancel a task" });
    return;
  }
  // Soft cancel if still active, hard delete if already terminal
  if (["completed", "failed", "canceled"].includes(task.status)) {
    deleteTask(task.id);
  } else {
    updateTaskStatus(task.id, "canceled");
    for (const agentId of [task.fromAgent, task.toAgent]) {
      if (isOnline(agentId)) {
        pushEvent(agentId, "task_updated", { ...task, status: "canceled" });
      }
    }
  }
  logger.info({ event: "task_canceled", taskId: task.id });
  res.json({ ok: true });
});

// Helper for error messages
function TASK_TRANSITIONS_FOR_ERROR(status: TaskStatus): TaskStatus[] {
  const map: Record<TaskStatus, TaskStatus[]> = {
    submitted: ["working", "canceled", "failed"],
    working: ["completed", "failed", "canceled", "input-required"],
    "input-required": ["working", "canceled", "failed"],
    completed: [], failed: [], canceled: [],
  };
  return map[status] ?? [];
}

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
  logger.info({ event: "agent_launched", agentId: param(req, "id"), cwd: agent.cwd });
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

  // Reconnect recovery: replay missed events
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) {
    const afterId = parseInt(lastEventId as string, 10);
    if (!isNaN(afterId)) {
      const missed = replayEvents(agentId, afterId);
      for (const evt of missed) {
        res.write(`id: ${evt.id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
      }
      if (missed.length > 0) {
        logger.info({ event: "sse_replay", agentId, count: missed.length, afterId });
      }
    }
  }

  cancelOfflineTimer(agentId);

  addSSE(agentId, res);
  logger.info({ event: "sse_connected", agentId });

  // Heartbeat: keep connection alive through proxies/load balancers
  const heartbeat = setInterval(() => {
    if (!res.destroyed) {
      res.write(": heartbeat\n\n");
    }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSSE(agentId, res);
    if (getAgent(agentId)) {
      agentOfflineDelayed(agentId);
      logger.info({ event: "sse_disconnected", agentId, gracePeriod: true });
    } else {
      logger.info({ event: "sse_closed", agentId, reason: "agent_removed" });
    }
  });
});

// ── Health — Public (no auth) ───────────────────────────────────

app.get("/health", (_req, res) => {
  const dbOk = checkDbHealth();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    checks: { store: "ok", database: dbOk ? "ok" : "error", sse: "ok" },
    authMode: getAuthMode(),
    agents: getActiveAgents().length,
    totalAgents: getAgents().length,
    uptime: process.uptime(),
    version: "0.3.0",
  });
});

// ── Metrics — Public ────────────────────────────────────────────

app.get("/metrics", (_req, res) => {
  const topo = getTopology();
  const sseMetrics = getSSEMetrics();
  const taskMetrics = getTaskMetrics();
  res.json({
    agents: { total: getAgents().length, online: getActiveAgents().length },
    topology: { nodes: Object.keys(topo.nodes).length, edges: topo.edges.length },
    tasks: taskMetrics,
    sse: sseMetrics,
    auth: { mode: getAuthMode() },
    uptime: process.uptime(),
    version: "0.3.0",
  });
});

// ── Error Handling ──────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: Response, _next: NextFunction) => {
  logger.error({ err, requestId: (_req as any).id }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

// ── Start & Graceful Shutdown ───────────────────────────────────

// Initialize admin key
const adminKey = initAdminKey();

startCleanupTimer();

const server = app.listen(PORT, HOST, () => {
  logger.info({ event: "server_started", host: HOST, port: PORT, authMode: getAuthMode(), version: "0.3.0" });
  if (adminKey) {
    logger.info({ event: "admin_key_created", key: adminKey }, "ADMIN API KEY (save this — shown only once)");
  }
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "shutdown_started", signal });

  server.close(() => {
    logger.info({ event: "http_server_closed" });
  });

  closeAllSSE();
  logger.info({ event: "sse_connections_closed" });

  try {
    await saveTopologyNow();
    logger.info({ event: "topology_saved" });
  } catch (err) {
    logger.error({ err }, "Failed to save topology on shutdown");
  }

  closeDb();
  logger.info({ event: "database_closed" });

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
