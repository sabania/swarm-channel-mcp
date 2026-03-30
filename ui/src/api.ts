const BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:3001";
const TOKEN_KEY = "swarm_admin_token";

// ── Token Management ───────────────────────────────────────────

export function getAdminToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── 401 Handler (set by App.tsx to show auth dialog) ───────────

let onAuthRequired: (() => Promise<void>) | null = null;

export function setOnAuthRequired(cb: (() => Promise<void>) | null): void {
  onAuthRequired = cb;
}

// ── Authenticated Fetch Wrapper ────────────────────────────────

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getAdminToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && onAuthRequired) {
    await onAuthRequired();
    const newToken = getAdminToken();
    if (newToken) {
      headers.set("Authorization", `Bearer ${newToken}`);
      return fetch(url, { ...init, headers });
    }
  }

  return res;
}

export interface PublicAgentInfo {
  id: string;
  name: string;
  description: string;
  status: "available" | "busy" | "offline";
}

export interface AgentCapabilities {
  skills?: string[];
  languages?: string[];
  frameworks?: string[];
  tools?: string[];
  mcps?: string[];
  domains?: string[];
}

export type CapabilityCategory = keyof AgentCapabilities;

export interface AgentInfo extends PublicAgentInfo {
  publicDescription: string;
  cwd: string;
  autoconnect: boolean;
  launchCommand: string;
  registeredAt: string;
  lastSeen: string;
  capabilities?: AgentCapabilities;
}

export interface Topology {
  nodes: Record<string, AgentInfo>;
  edges: [string, string][];
}

export async function fetchTopology(): Promise<Topology> {
  const res = await apiFetch(`${BASE}/topology?full=true`);
  return res.json();
}

export async function fetchAgent(id: string): Promise<AgentInfo> {
  const res = await apiFetch(`${BASE}/agents/${id}`);
  return res.json();
}

export async function addEdge(from: string, to: string): Promise<void> {
  await apiFetch(`${BASE}/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
}

export async function removeEdge(from: string, to: string): Promise<void> {
  await apiFetch(`${BASE}/edges`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
}

export async function updateAgent(
  id: string,
  updates: Partial<Pick<AgentInfo, "name" | "description" | "publicDescription" | "cwd" | "autoconnect" | "launchCommand"> & { id: string }>
): Promise<AgentInfo & { error?: string }> {
  const res = await apiFetch(`${BASE}/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  return res.json();
}

export async function removeAgent(id: string): Promise<void> {
  await apiFetch(`${BASE}/agents/${id}`, { method: "DELETE" });
}

export async function launchAgent(id: string): Promise<{ ok?: boolean; error?: string }> {
  const res = await apiFetch(`${BASE}/agents/${id}/launch`, { method: "POST" });
  return res.json();
}

export async function createAgent(agent: {
  id: string;
  name: string;
  description: string;
  cwd: string;
}): Promise<AgentInfo & { error?: string }> {
  const res = await apiFetch(`${BASE}/agents/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });
  return res.json();
}

// ── Task Types ─────────────────────────────────────────────────

export type TaskStatus = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";

export interface Task {
  id: string;
  contextId?: string;
  fromAgent: string;
  toAgent: string;
  status: TaskStatus;
  title?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskMessage {
  id: string;
  taskId: string;
  role: "sender" | "receiver";
  agentId: string;
  content: string;
  createdAt: string;
}

export interface TaskArtifact {
  id: string;
  taskId: string;
  name: string;
  mimeType: string;
  data: string;
  createdAt: string;
}

export interface TaskDetail {
  task: Task;
  messages: TaskMessage[];
  artifacts: TaskArtifact[];
}

// ── Task API ───────────────────────────────────────────────────

export async function fetchTasks(agentId: string): Promise<Task[]> {
  const res = await apiFetch(`${BASE}/tasks?to=${encodeURIComponent(agentId)}`);
  return res.json();
}

export async function fetchTask(taskId: string): Promise<TaskDetail> {
  const res = await apiFetch(`${BASE}/tasks/${encodeURIComponent(taskId)}`);
  return res.json();
}

export async function createTask(from: string, to: string, title: string, content: string): Promise<Task & { error?: string }> {
  const res = await apiFetch(`${BASE}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, title, content }),
  });
  return res.json();
}

export async function updateTask(taskId: string, status: TaskStatus): Promise<Task & { error?: string }> {
  const res = await apiFetch(`${BASE}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  return res.json();
}

export async function fetchAllTasks(filters?: {
  status?: TaskStatus;
  from?: string;
  to?: string;
}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  const qs = params.toString();
  const res = await apiFetch(`${BASE}/tasks${qs ? `?${qs}` : ""}`);
  return res.json();
}

// ── Metrics ────────────────────────────────────────────────────

export interface Metrics {
  agents: { total: number; online: number };
  topology: { nodes: number; edges: number };
  tasks: { total: number; byStatus: Record<string, number> };
  uptime: number;
  version: string;
}

export async function fetchMetrics(): Promise<Metrics> {
  const res = await apiFetch(`${BASE}/metrics`);
  return res.json();
}

