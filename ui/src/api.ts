const BASE = "http://127.0.0.1:3001";

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  publicDescription: string;
  cwd: string;
  autoconnect: boolean;
  status: "available" | "busy" | "offline";
  registeredAt: string;
  lastSeen: string;
}

export interface Topology {
  nodes: Record<string, AgentInfo>;
  edges: [string, string][];
}

export async function fetchTopology(): Promise<Topology> {
  const res = await fetch(`${BASE}/topology`);
  return res.json();
}

export async function addEdge(from: string, to: string): Promise<void> {
  await fetch(`${BASE}/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
}

export async function removeEdge(from: string, to: string): Promise<void> {
  await fetch(`${BASE}/edges`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
}

export async function updateAgent(
  id: string,
  updates: Partial<Pick<AgentInfo, "name" | "description" | "publicDescription" | "cwd" | "autoconnect"> & { id: string }>
): Promise<AgentInfo & { error?: string }> {
  const res = await fetch(`${BASE}/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  return res.json();
}

export async function removeAgent(id: string): Promise<void> {
  await fetch(`${BASE}/agents/${id}`, { method: "DELETE" });
}

export async function launchAgent(id: string): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(`${BASE}/agents/${id}/launch`, { method: "POST" });
  return res.json();
}

export function createSSE(onEvent: (event: string, data: unknown) => void): EventSource {
  // SSE for topology changes - listen on a special admin endpoint
  // For now we'll poll instead
  const es = new EventSource(`${BASE}/events/__admin__`);
  es.onmessage = (e) => onEvent("message", JSON.parse(e.data));
  return es;
}
