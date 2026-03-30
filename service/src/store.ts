import fs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Response } from "express";
import { DEFAULT_LAUNCH_CMD, type AgentInfo, type AgentCapabilities, type AgentPublicView, type SwarmTopology } from "./types.js";
import { logger } from "./logger.js";

// ── Persistence ─────────────────────────────────────────────────

const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(os.homedir(), ".swarm-channel");
const TOPOLOGY_FILE = path.join(DATA_DIR, "topology.json");

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

// Debounced persistence — coalesces rapid writes into one disk I/O
const SAVE_DEBOUNCE_MS = 500;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight: Promise<void> | null = null;

async function writeToDisk(): Promise<void> {
  ensureDir();
  const data: SwarmTopology = {
    nodes: Object.fromEntries(agents),
    edges: serializeEdges(),
  };
  const tmp = TOPOLOGY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, TOPOLOGY_FILE);
}

function saveTopology(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveInFlight = writeToDisk().catch((err) => {
      logger.error({ err }, "Failed to save topology");
    }).finally(() => {
      saveInFlight = null;
    });
  }, SAVE_DEBOUNCE_MS);
}

/** Force-save immediately — flushes pending debounce (used during shutdown) */
export async function saveTopologyNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // Wait for in-flight write to finish, then write current state
  if (saveInFlight) await saveInFlight;
  await writeToDisk();
}

function loadTopology(): SwarmTopology {
  // Sync on startup only — before server starts listening
  try {
    return JSON.parse(readFileSync(TOPOLOGY_FILE, "utf-8"));
  } catch {
    return { nodes: {}, edges: [] };
  }
}

// ── Adjacency helpers ──────────────────────────────────────────

function serializeEdges(): [string, string][] {
  const result: [string, string][] = [];
  const seen = new Set<string>();
  for (const [a, neighbors] of adjacency) {
    for (const b of neighbors) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(a < b ? [a, b] : [b, a]);
      }
    }
  }
  return result;
}

// ── Input Validation ────────────────────────────────────────────

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_ID_LEN = 64;
const MAX_NAME_LEN = 128;
const MAX_DESC_LEN = 16384;
const MAX_MSG_LEN = 32768;

export function validateAgentId(id: unknown): string | null {
  if (typeof id !== "string") return "id must be a string";
  if (id.length === 0) return "id is required";
  if (id.length > MAX_ID_LEN) return `id exceeds ${MAX_ID_LEN} characters`;
  if (!AGENT_ID_RE.test(id)) return "id must be lowercase alphanumeric (a-z0-9), starting with letter/digit, may contain . _ -";
  return null;
}

export function validateAgentName(name: unknown): string | null {
  if (typeof name !== "string") return "name must be a string";
  if (name.length === 0) return "name is required";
  if (name.length > MAX_NAME_LEN) return `name exceeds ${MAX_NAME_LEN} characters`;
  return null;
}

export function validateDescription(desc: unknown): string | null {
  if (typeof desc !== "string") return "description must be a string";
  if (desc.length > MAX_DESC_LEN) return `description exceeds ${MAX_DESC_LEN} characters`;
  return null;
}

export function validateMessageContent(content: unknown): string | null {
  if (typeof content !== "string") return "content must be a string";
  if (content.length === 0) return "content is required";
  if (content.length > MAX_MSG_LEN) return `content exceeds ${MAX_MSG_LEN} characters`;
  return null;
}

function loadEdges(edges: [string, string][]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

// ── State ───────────────────────────────────────────────────────

const saved = loadTopology();
const agents = new Map<string, AgentInfo>(Object.entries(saved.nodes));
let adjacency = loadEdges(saved.edges);
const sseConnections = new Map<string, Response[]>();
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

for (const agent of agents.values()) {
  agent.status = "offline";
}

/** Rebuild adjacency cache from edge pairs (called after SQLite migration) */
export function rebuildAdjacency(edgePairs: [string, string][]): void {
  adjacency = loadEdges(edgePairs);
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

export function toPublicViewWithCapabilities(agent: AgentInfo): AgentPublicView & { capabilities?: AgentCapabilities } {
  return {
    ...toPublicView(agent),
    capabilities: agent.capabilities,
  };
}

// ── SSE + Event Buffer ──────────────────────────────────────────

const EVENT_BUFFER_MAX = 1000;

interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
  timestamp: string;
}

const eventCounters = new Map<string, number>();
const eventBuffers = new Map<string, BufferedEvent[]>();

export function getNextEventId(agentId: string): number {
  const current = eventCounters.get(agentId) ?? 0;
  const next = current + 1;
  eventCounters.set(agentId, next);
  return next;
}

export function replayEvents(agentId: string, afterId: number): BufferedEvent[] {
  const buffer = eventBuffers.get(agentId);
  if (!buffer) return [];
  return buffer.filter((e) => e.id > afterId);
}

export function clearEventBuffer(agentId: string): void {
  eventBuffers.delete(agentId);
  eventCounters.delete(agentId);
}

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
  const id = getNextEventId(agentId);

  // Store in ring buffer
  if (!eventBuffers.has(agentId)) eventBuffers.set(agentId, []);
  const buffer = eventBuffers.get(agentId)!;
  buffer.push({ id, event, data, timestamp: new Date().toISOString() });
  if (buffer.length > EVENT_BUFFER_MAX) buffer.shift();

  // Send to SSE connections with id field
  const conns = sseConnections.get(agentId);
  if (!conns) return;
  const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of conns) {
    res.write(payload);
  }
}

export function isOnline(agentId: string): boolean {
  return (sseConnections.get(agentId)?.length ?? 0) > 0;
}

export function closeSSE(agentId: string): void {
  const conns = sseConnections.get(agentId);
  if (!conns) return;
  for (const res of conns) {
    res.end();
  }
  sseConnections.delete(agentId);
}

/** Close ALL SSE connections (used during shutdown) */
export function closeAllSSE(): void {
  for (const [, conns] of sseConnections) {
    for (const res of conns) {
      res.end();
    }
  }
  sseConnections.clear();
}

/** Metrics for /metrics endpoint */
export function getSSEMetrics(): { activeConnections: number; eventsBuffered: number } {
  let activeConnections = 0;
  for (const conns of sseConnections.values()) activeConnections += conns.length;
  let eventsBuffered = 0;
  for (const buf of eventBuffers.values()) eventsBuffered += buf.length;
  return { activeConnections, eventsBuffered };
}

// ── Graph / Topology ────────────────────────────────────────────

export function getConnectedIds(agentId: string): string[] {
  return [...(adjacency.get(agentId) ?? [])];
}

export function getConnectedAgents(agentId: string): AgentPublicView[] {
  return getConnectedIds(agentId)
    .map((id) => agents.get(id))
    .filter((a): a is AgentInfo => a !== undefined)
    .map(toPublicView);
}

export function areConnected(a: string, b: string): boolean {
  return adjacency.get(a)?.has(b) ?? false;
}

/** Update adjacency cache + notify. SQLite write handled by caller in index.ts */
export function addEdge(a: string, b: string): boolean {
  if (a === b) return false;
  if (areConnected(a, b)) return false;
  if (!agents.has(a) || !agents.has(b)) return false;

  if (!adjacency.has(a)) adjacency.set(a, new Set());
  if (!adjacency.has(b)) adjacency.set(b, new Set());
  adjacency.get(a)!.add(b);
  adjacency.get(b)!.add(a);

  // Notify both sides
  const agentA = agents.get(a)!;
  const agentB = agents.get(b)!;

  if (isOnline(a)) {
    pushEvent(a, "connected_to", toPublicViewWithCapabilities(agentB));
  }
  if (isOnline(b)) {
    pushEvent(b, "connected_to", toPublicViewWithCapabilities(agentA));
  }

  return true;
}

/** Update adjacency cache + notify. SQLite write handled by caller in index.ts */
export function removeEdge(a: string, b: string): boolean {
  const setA = adjacency.get(a);
  const setB = adjacency.get(b);
  if (!setA?.has(b)) return false;

  setA.delete(b);
  setB?.delete(a);

  // Clean up empty sets
  if (setA.size === 0) adjacency.delete(a);
  if (setB && setB.size === 0) adjacency.delete(b);

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
  return serializeEdges();
}

export function getTopology(): SwarmTopology {
  return { nodes: Object.fromEntries(agents), edges: serializeEdges() };
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
  capabilities?: AgentCapabilities;
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
    capabilities: info.capabilities ?? existing?.capabilities,
    registeredAt: existing?.registeredAt || now,
    lastSeen: now,
  };

  agents.set(info.id, agent);
  saveTopology();

  // Notify connected peers (with capabilities for discovery)
  const publicView = toPublicViewWithCapabilities(agent);
  for (const peerId of getConnectedIds(info.id)) {
    if (isOnline(peerId)) {
      pushEvent(peerId, "agent_online", publicView);
    }
  }

  return agent;
}

const OFFLINE_GRACE_MS = 5000;

export function agentOfflineDelayed(agentId: string): void {
  // Cancel existing timer if any
  cancelOfflineTimer(agentId);

  const timer = setTimeout(() => {
    offlineTimers.delete(agentId);
    // Only go offline if still no SSE connection
    if (!isOnline(agentId)) {
      agentOfflineNow(agentId);
    }
  }, OFFLINE_GRACE_MS);

  offlineTimers.set(agentId, timer);
}

export function cancelOfflineTimer(agentId: string): void {
  const timer = offlineTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(agentId);
  }
}

function agentOfflineNow(agentId: string): boolean {
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
  const wasOnline = isOnline(agentId);

  // 1. Notify the agent itself (if online) before closing SSE
  if (wasOnline) {
    pushEvent(agentId, "agent_removed", { id: agentId, reason: "Removed by admin" });
  }

  // 2. Notify connected peers
  for (const peerId of getConnectedIds(agentId)) {
    if (isOnline(peerId)) {
      pushEvent(peerId, "agent_removed", { id: agentId, name: agent.name });
    }
  }

  // 3. Close SSE connections (agent will stop receiving events)
  if (wasOnline) {
    closeSSE(agentId);
  }

  // 4. Remove from adjacency map
  const neighbors = adjacency.get(agentId);
  if (neighbors) {
    for (const peer of neighbors) {
      adjacency.get(peer)?.delete(agentId);
      const peerSet = adjacency.get(peer);
      if (peerSet && peerSet.size === 0) adjacency.delete(peer);
    }
    adjacency.delete(agentId);
  }

  // 5. Remove from agents
  agents.delete(agentId);
  saveTopology();
  return true;
}

export function updateAgent(agentId: string, updates: Partial<Pick<AgentInfo, "name" | "description" | "publicDescription" | "cwd" | "autoconnect" | "launchCommand"> & { id: string }>): AgentInfo | null {
  const agent = agents.get(agentId);
  if (!agent) return null;

  const newId = updates.id;
  const idChanged = newId && newId !== agentId;

  // Apply only whitelisted fields
  const allowed: (keyof AgentInfo)[] = ["name", "description", "publicDescription", "cwd", "autoconnect", "launchCommand", "capabilities"];
  for (const key of allowed) {
    if (key in updates && updates[key as keyof typeof updates] !== undefined) {
      (agent as any)[key] = updates[key as keyof typeof updates];
    }
  }

  // Handle ID change
  if (idChanged && newId) {
    if (agents.has(newId)) return null; // new ID already taken
    agent.id = newId;
    agents.delete(agentId);
    agents.set(newId, agent);

    // Update adjacency map
    const neighbors = adjacency.get(agentId);
    if (neighbors) {
      adjacency.delete(agentId);
      adjacency.set(newId, neighbors);
      for (const peer of neighbors) {
        const peerSet = adjacency.get(peer);
        if (peerSet) {
          peerSet.delete(agentId);
          peerSet.add(newId);
        }
      }
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
