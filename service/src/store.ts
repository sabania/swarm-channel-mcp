import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Response } from "express";
import type { AgentInfo } from "./types.js";
import { randomUUID } from "node:crypto";

// ── Persistence (agents only) ───────────────────────────────────

const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(os.homedir(), ".swarm-channel");
const AGENTS_FILE = path.join(DATA_DIR, "agents.json");

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveJSON(file: string, data: unknown): void {
  ensureDir();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function loadJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

// ── State ───────────────────────────────────────────────────────

const agents = new Map<string, AgentInfo>(
  Object.entries(loadJSON<Record<string, AgentInfo>>(AGENTS_FILE, {}))
);
const sseConnections = new Map<string, Response[]>();

// Mark all agents offline on startup (they need to reconnect)
for (const agent of agents.values()) {
  agent.status = "offline";
}

function persistAgents(): void {
  saveJSON(AGENTS_FILE, Object.fromEntries(agents));
}

// ── SSE ─────────────────────────────────────────────────────────

export function addSSE(agentId: string, res: Response): void {
  if (!sseConnections.has(agentId)) sseConnections.set(agentId, []);
  sseConnections.get(agentId)!.push(res);
}

export function removeSSE(agentId: string, res: Response): void {
  const conns = sseConnections.get(agentId);
  if (!conns) return;
  const idx = conns.indexOf(res);
  if (idx !== -1) conns.splice(idx, 1);
  if (conns.length === 0) sseConnections.delete(agentId);
}

export function pushEvent(agentId: string, event: string, data: unknown): void {
  const conns = sseConnections.get(agentId);
  if (!conns) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of conns) {
    res.write(payload);
  }
}

export function isConnected(agentId: string): boolean {
  return (sseConnections.get(agentId)?.length ?? 0) > 0;
}

// ── Agent Registry ──────────────────────────────────────────────

export function registerAgent(info: { id: string; name: string; capabilities: string[] }): AgentInfo {
  const existing = agents.get(info.id);
  const now = new Date().toISOString();

  const agent: AgentInfo = {
    id: info.id,
    name: info.name,
    capabilities: info.capabilities,
    status: "available",
    registeredAt: existing?.registeredAt || now,
    lastSeen: now,
  };

  agents.set(info.id, agent);
  persistAgents();

  // Broadcast to others
  for (const [id] of sseConnections) {
    if (id !== info.id) {
      pushEvent(id, "agent_online", {
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
      });
    }
  }

  return agent;
}

export function agentOffline(agentId: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agent.status = "offline";
  agent.lastSeen = new Date().toISOString();
  persistAgents();

  for (const [id] of sseConnections) {
    if (id !== agentId) {
      pushEvent(id, "agent_offline", { id: agentId, name: agent.name });
    }
  }
  return true;
}

export function removeAgent(agentId: string): boolean {
  if (!agents.has(agentId)) return false;
  agents.delete(agentId);
  persistAgents();
  return true;
}

export function setAgentStatus(agentId: string, status: AgentInfo["status"]): void {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = status;
    agent.lastSeen = new Date().toISOString();
    persistAgents();
  }
}

export function getAgent(agentId: string): AgentInfo | undefined {
  return agents.get(agentId);
}

export function getAgents(): AgentInfo[] {
  return [...agents.values()];
}

export function getActiveAgents(): AgentInfo[] {
  return [...agents.values()].filter((a) => a.status !== "offline");
}

export function discoverByCapability(capability: string): AgentInfo[] {
  const q = capability.toLowerCase();
  return getActiveAgents().filter((a) =>
    a.capabilities.some((c) => c.toLowerCase().includes(q))
  );
}

// ── Messages (fire and forget) ──────────────────────────────────

export function sendMessage(from: string, to: string, content: string): { id: string; delivered: boolean } {
  const id = randomUUID();
  const delivered = isConnected(to);

  if (delivered) {
    pushEvent(to, "message", { id, from, to, content, timestamp: new Date().toISOString() });
  }

  return { id, delivered };
}

export function broadcastMessage(from: string, content: string): number {
  const targets = getActiveAgents().filter((a) => a.id !== from);
  let count = 0;
  for (const agent of targets) {
    const { delivered } = sendMessage(from, agent.id, content);
    if (delivered) count++;
  }
  return count;
}
