import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Response } from "express";
import { DEFAULT_LAUNCH_CMD, type AgentInfo, type AgentPublicView, type SwarmTopology } from "./types.js";

// ── Persistence ─────────────────────────────────────────────────

const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(os.homedir(), ".swarm-channel");
const TOPOLOGY_FILE = path.join(DATA_DIR, "topology.json");

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveTopology(): void {
  ensureDir();
  const data: SwarmTopology = { nodes: Object.fromEntries(agents), edges };
  const tmp = TOPOLOGY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, TOPOLOGY_FILE);
}

function loadTopology(): SwarmTopology {
  try {
    return JSON.parse(fs.readFileSync(TOPOLOGY_FILE, "utf-8"));
  } catch {
    return { nodes: {}, edges: [] };
  }
}

// ── State ───────────────────────────────────────────────────────

const saved = loadTopology();
const agents = new Map<string, AgentInfo>(Object.entries(saved.nodes));
const edges: [string, string][] = saved.edges;
const sseConnections = new Map<string, Response[]>();

for (const agent of agents.values()) {
  agent.status = "offline";
}

// ── Public View ─────────────────────────────────────────────────

export function toPublicView(agent: AgentInfo): AgentPublicView {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.publicDescription || agent.description,
    status: agent.status,
  };
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

export function isOnline(agentId: string): boolean {
  return (sseConnections.get(agentId)?.length ?? 0) > 0;
}

// ── Graph / Topology ────────────────────────────────────────────

export function getConnectedIds(agentId: string): string[] {
  const ids = new Set<string>();
  for (const [a, b] of edges) {
    if (a === agentId) ids.add(b);
    if (b === agentId) ids.add(a);
  }
  return [...ids];
}

export function getConnectedAgents(agentId: string): AgentPublicView[] {
  return getConnectedIds(agentId)
    .map((id) => agents.get(id))
    .filter((a): a is AgentInfo => a !== undefined)
    .map(toPublicView);
}

export function areConnected(a: string, b: string): boolean {
  return edges.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a)
  );
}

export function addEdge(a: string, b: string): boolean {
  if (a === b) return false;
  if (areConnected(a, b)) return false;
  if (!agents.has(a) || !agents.has(b)) return false;
  edges.push([a, b]);
  saveTopology();

  // Notify both sides
  const agentA = agents.get(a)!;
  const agentB = agents.get(b)!;

  if (isOnline(a)) {
    pushEvent(a, "connected_to", toPublicView(agentB));
  }
  if (isOnline(b)) {
    pushEvent(b, "connected_to", toPublicView(agentA));
  }

  return true;
}

export function removeEdge(a: string, b: string): boolean {
  const idx = edges.findIndex(
    ([x, y]) => (x === a && y === b) || (x === b && y === a)
  );
  if (idx === -1) return false;
  edges.splice(idx, 1);
  saveTopology();

  // Notify both sides
  if (isOnline(a)) {
    pushEvent(a, "disconnected_from", { id: b });
  }
  if (isOnline(b)) {
    pushEvent(b, "disconnected_from", { id: a });
  }

  return true;
}

export function getEdges(): [string, string][] {
  return [...edges];
}

export function getTopology(): SwarmTopology {
  return { nodes: Object.fromEntries(agents), edges: [...edges] };
}

// ── Agent Registry ──────────────────────────────────────────────

export function createAgent(info: {
  id: string;
  name: string;
  description: string;
  cwd: string;
}): AgentInfo | null {
  if (agents.has(info.id)) return null;
  const now = new Date().toISOString();
  const agent: AgentInfo = {
    id: info.id,
    name: info.name,
    description: info.description,
    publicDescription: "",
    cwd: info.cwd,
    autoconnect: true,
    launchCommand: DEFAULT_LAUNCH_CMD,
    status: "offline",
    registeredAt: now,
    lastSeen: now,
  };
  agents.set(info.id, agent);
  saveTopology();
  return agent;
}

export function registerAgent(info: {
  id: string;
  name: string;
  description: string;
  publicDescription?: string;
  cwd?: string;
  autoconnect?: boolean;
}): AgentInfo {
  const existing = agents.get(info.id);
  const now = new Date().toISOString();

  const agent: AgentInfo = {
    id: info.id,
    name: info.name,
    description: info.description,
    publicDescription: info.publicDescription ?? existing?.publicDescription ?? "",
    cwd: info.cwd || existing?.cwd || "",
    autoconnect: info.autoconnect ?? true,
    launchCommand: existing?.launchCommand || DEFAULT_LAUNCH_CMD,
    status: "available",
    registeredAt: existing?.registeredAt || now,
    lastSeen: now,
  };

  agents.set(info.id, agent);
  saveTopology();

  // Notify connected peers (public view only)
  const publicView = toPublicView(agent);
  for (const peerId of getConnectedIds(info.id)) {
    if (isOnline(peerId)) {
      pushEvent(peerId, "agent_online", publicView);
    }
  }

  return agent;
}

export function agentOffline(agentId: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;
  agent.status = "offline";
  agent.lastSeen = new Date().toISOString();
  saveTopology();

  for (const peerId of getConnectedIds(agentId)) {
    if (isOnline(peerId)) {
      pushEvent(peerId, "agent_offline", { id: agentId, name: agent.name });
    }
  }
  return true;
}

export function removeAgent(agentId: string): boolean {
  const agent = agents.get(agentId);
  if (!agent) return false;

  // Notify connected peers before removing
  for (const peerId of getConnectedIds(agentId)) {
    if (isOnline(peerId)) {
      pushEvent(peerId, "agent_offline", { id: agentId, name: agent.name });
    }
  }

  agents.delete(agentId);
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i][0] === agentId || edges[i][1] === agentId) {
      edges.splice(i, 1);
    }
  }
  saveTopology();
  return true;
}

export function updateAgent(agentId: string, updates: Partial<Pick<AgentInfo, "name" | "description" | "publicDescription" | "cwd" | "autoconnect" | "launchCommand"> & { id: string }>): AgentInfo | null {
  const agent = agents.get(agentId);
  if (!agent) return null;

  const newId = updates.id;
  const idChanged = newId && newId !== agentId;

  // Apply non-id updates
  const { id: _id, ...rest } = updates;
  Object.assign(agent, rest);

  // Handle ID change
  if (idChanged && newId) {
    if (agents.has(newId)) return null; // new ID already taken
    agent.id = newId;
    agents.delete(agentId);
    agents.set(newId, agent);

    // Update all edges
    for (let i = 0; i < edges.length; i++) {
      if (edges[i][0] === agentId) edges[i] = [newId, edges[i][1]];
      if (edges[i][1] === agentId) edges[i] = [edges[i][0], newId];
    }

    // Move SSE connections
    const conns = sseConnections.get(agentId);
    if (conns) {
      sseConnections.delete(agentId);
      sseConnections.set(newId, conns);
    }
  }

  saveTopology();

  const currentId = idChanged && newId ? newId : agentId;

  // Notify the agent itself
  if (isOnline(currentId)) {
    pushEvent(currentId, "properties_updated", {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      publicDescription: agent.publicDescription,
    });
  }

  // Notify connected agents about the change (especially ID rename)
  if (idChanged && newId) {
    for (const peerId of getConnectedIds(currentId)) {
      if (isOnline(peerId)) {
        pushEvent(peerId, "agent_renamed", {
          oldId: agentId,
          newId: newId,
          name: agent.name,
        });
      }
    }
  }

  return agent;
}

export function setAgentStatus(agentId: string, status: AgentInfo["status"]): void {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = status;
    agent.lastSeen = new Date().toISOString();
    saveTopology();
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

// ── Messages (fire and forget) ──────────────────────────────────

export function sendMessage(from: string, to: string, content: string): { id: string; delivered: boolean; error?: string } {
  if (!areConnected(from, to)) {
    return { id: "", delivered: false, error: `No connection between ${from} and ${to}` };
  }

  const id = crypto.randomUUID();
  const delivered = isOnline(to);

  if (delivered) {
    pushEvent(to, "message", { id, from, to, content, timestamp: new Date().toISOString() });
  }

  return { id, delivered };
}

export function broadcastMessage(from: string, content: string): number {
  const peerIds = getConnectedIds(from);
  let count = 0;
  for (const peerId of peerIds) {
    if (isOnline(peerId)) {
      const { delivered } = sendMessage(from, peerId, content);
      if (delivered) count++;
    }
  }
  return count;
}
