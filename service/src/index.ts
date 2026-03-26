import express from "express";
import {
  registerAgent,
  agentOffline,
  removeAgent,
  setAgentStatus,
  getAgent,
  getAgents,
  getActiveAgents,
  discoverByCapability,
  sendMessage,
  broadcastMessage,
  addSSE,
  removeSSE,
} from "./store.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();
app.use(express.json());

// ── Agent Registration ──────────────────────────────────────────

app.post("/agents", (req, res) => {
  const { id, name, capabilities } = req.body;
  if (!id || !name || !Array.isArray(capabilities)) {
    res.status(400).json({ error: "id, name, capabilities[] required" });
    return;
  }
  registerAgent({ id, name, capabilities });
  console.log(`+ Agent registered: ${id} (${name})`);
  res.json({ ok: true, id });
});

app.delete("/agents/:id", (req, res) => {
  const ok = removeAgent(req.params.id);
  if (ok) console.log(`- Agent removed: ${req.params.id}`);
  res.json({ ok });
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

app.get("/agents/discover", (req, res) => {
  const capability = req.query.capability as string;
  if (!capability) {
    res.status(400).json({ error: "?capability= required" });
    return;
  }
  res.json(discoverByCapability(capability));
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
  console.log(`✉ ${from} → ${to} [${result.delivered ? "delivered" : "offline"}]: ${content.slice(0, 60)}`);
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
    agentOffline(agentId);
    console.log(`⚡ SSE disconnected: ${agentId} (now offline)`);
  });
});

// ── Health ──────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    agents: getActiveAgents().length,
    uptime: process.uptime(),
  });
});

// ── Start ───────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`Swarm Service running at http://${HOST}:${PORT}`);
});
