import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const SERVICE_URL = process.env.SWARM_URL || "http://127.0.0.1:3001";
const AGENT_CONFIG = path.join(process.cwd(), ".swarm-agent.json");

let agentId: string | null = null;
let agentApiKey: string | null = null;
let sseAbort: AbortController | null = null;
let sseRetryDelay = 1000; // Exponential backoff: 1s → 30s cap
let lastEventId: string | null = null;

// ── Local Config ───────────────────────────────────────────────

interface LocalConfig {
  id: string;
  autoconnect: boolean;
  apiKey?: string;
}

function saveLocalConfig(config: LocalConfig): void {
  fs.writeFileSync(AGENT_CONFIG, JSON.stringify(config, null, 2), "utf-8");
}

function loadLocalConfig(): LocalConfig | null {
  try {
    return JSON.parse(fs.readFileSync(AGENT_CONFIG, "utf-8"));
  } catch {
    return null;
  }
}

// ── MCP Channel Server ──────────────────────────────────────────

const server = new Server(
  { name: "swarm-plugin", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "You are connected to the Agent Swarm.",
      "Messages from other agents arrive as notifications automatically (fire and forget).",
      "Available tools: register, whoami, update_profile, unregister, list_agents, discover, send_message, broadcast, set_status, create_task, update_task, reply_task, list_tasks, get_task.",
      "You must call 'register' first (unless auto-connected). You can only communicate with agents you are connected to in the topology.",
      "When registering, include ALL your capabilities: installed skills, MCPs, workspace context, languages, frameworks — everything that makes you useful.",
    ].join(" "),
  }
);

// ── Tool Definitions ────────────────────────────────────────────

const TOOLS = [
  {
    name: "register",
    description: "Register this agent with the swarm. Call this first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Unique agent ID" },
        name: { type: "string", description: "Human-readable agent name" },
        description: {
          type: "string",
          description: "Comprehensive description of this agent. Include: your role, what you can do, your workspace context, installed skills, available MCPs, and any special capabilities. Be thorough — this is how other agents will know what you can help with.",
        },
        capabilities: {
          type: "object",
          description: "Structured capabilities for discovery. All fields are optional arrays of strings.",
          properties: {
            skills: { type: "array", items: { type: "string" }, description: "Installed skills (e.g. 'frontend-design', 'webapp-testing')" },
            languages: { type: "array", items: { type: "string" }, description: "Programming languages (e.g. 'typescript', 'python')" },
            frameworks: { type: "array", items: { type: "string" }, description: "Frameworks (e.g. 'react', 'express', 'fastapi')" },
            tools: { type: "array", items: { type: "string" }, description: "Available tools and MCPs" },
            domains: { type: "array", items: { type: "string" }, description: "Domain expertise (e.g. 'backend', 'frontend', 'qa', 'devops')" },
          },
        },
      },
      required: ["id", "name", "description"],
    },
  },
  {
    name: "whoami",
    description: "Show your identity in the swarm: ID, name, description, connections, status. Use this to check who you are and who you can talk to.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "update_profile",
    description: "Update your profile in the swarm. Use when your capabilities change, e.g. new MCP installed or workspace changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "New name (optional)" },
        description: { type: "string", description: "New description (optional)" },
        capabilities: {
          type: "object",
          description: "Updated structured capabilities (optional). All fields are optional arrays of strings.",
          properties: {
            skills: { type: "array", items: { type: "string" } },
            languages: { type: "array", items: { type: "string" } },
            frameworks: { type: "array", items: { type: "string" } },
            tools: { type: "array", items: { type: "string" } },
            domains: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  {
    name: "unregister",
    description: "Unregister this agent from the swarm.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_agents",
    description: "List agents you are connected to in the swarm.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "discover",
    description: "Search for agents by what they can do. Use query for free-text search, or structured filters for precise matching. Both can be combined.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Free-text search against agent name and description" },
        skills: { type: "array", items: { type: "string" }, description: "Filter by skills (e.g. ['frontend-design', 'webapp-testing'])" },
        domains: { type: "array", items: { type: "string" }, description: "Filter by domain (e.g. ['backend', 'frontend'])" },
        languages: { type: "array", items: { type: "string" }, description: "Filter by language (e.g. ['typescript', 'python'])" },
      },
    },
  },
  {
    name: "send_message",
    description: "Send a message to another agent by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Target agent ID" },
        content: { type: "string", description: "Message content" },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "broadcast",
    description: "Send a message to all active agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "Message content" },
      },
      required: ["content"],
    },
  },
  {
    name: "set_status",
    description: "Update your agent status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["available", "busy"],
          description: "New status",
        },
      },
      required: ["status"],
    },
  },
  {
    name: "create_task",
    description: "Create a task and assign it to another agent. The target agent will be notified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Agent ID to assign the task to" },
        content: { type: "string", description: "Task description — what needs to be done" },
        title: { type: "string", description: "Short task title (optional)" },
        contextId: { type: "string", description: "Group related tasks under a context ID (optional)" },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "update_task",
    description: "Update the status of a task assigned to you. Optionally include a message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string", description: "Task ID to update" },
        status: {
          type: "string",
          enum: ["working", "completed", "failed", "input-required", "canceled"],
          description: "New task status",
        },
        content: { type: "string", description: "Optional message explaining the status change" },
      },
      required: ["taskId", "status"],
    },
  },
  {
    name: "reply_task",
    description: "Send a message on a task thread (multi-turn conversation).",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string", description: "Task ID to reply to" },
        content: { type: "string", description: "Reply message content" },
      },
      required: ["taskId", "content"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks. Filter by role: 'assigned' (tasks given to you), 'created' (tasks you created), 'active' (non-terminal tasks), or 'all'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter: {
          type: "string",
          enum: ["assigned", "created", "active", "all"],
          description: "Filter tasks (default: active)",
        },
      },
    },
  },
  {
    name: "get_task",
    description: "Get full task details including messages and artifacts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        taskId: { type: "string", description: "Task ID to retrieve" },
      },
      required: ["taskId"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Tool Handlers ───────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (agentApiKey) headers["Authorization"] = `Bearer ${agentApiKey}`;
  const res = await fetch(`${SERVICE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || res.statusText);
  }
  return res.json();
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "register": {
        const { id, name: agentName, description, capabilities } = args as {
          id: string;
          name: string;
          description: string;
          capabilities?: Record<string, string[]>;
        };
        const regBody: Record<string, unknown> = { id, name: agentName, description, cwd: process.cwd() };
        if (capabilities) regBody.capabilities = capabilities;
        const regResult = await api("POST", "/agents", regBody) as { agent?: unknown; apiKey?: string };
        agentId = id;
        agentApiKey = regResult.apiKey || null;
        saveLocalConfig({ id, autoconnect: true, apiKey: agentApiKey || undefined });
        connectSSE(id);
        return text(
          `Registered as "${agentName}" (${id}). Listening for messages. Auto-reconnect enabled.${agentApiKey ? " API key received." : ""}`
        );
      }

      case "whoami": {
        if (!agentId) return text("Not registered in the swarm yet. Use 'register' first.");
        const me = await api("GET", `/agents/${agentId}`) as Record<string, unknown>;
        const connections = await api("GET", `/agents/${agentId}/connections`);
        return text(
          `Your swarm identity:\n${JSON.stringify(me, null, 2)}\n\nConnections:\n${JSON.stringify(connections, null, 2)}\n\nNote: You also have access to all skills, MCPs, and tools configured in your Claude Code session — these are part of your capabilities even if not listed in your swarm description.`
        );
      }

      case "update_profile": {
        if (!agentId) return text("You must register first.");
        const updates: Record<string, unknown> = {};
        const a = args as { name?: string; description?: string; capabilities?: Record<string, string[]> };
        if (a.name) updates.name = a.name;
        if (a.description) updates.description = a.description;
        if (a.capabilities) updates.capabilities = a.capabilities;
        if (Object.keys(updates).length === 0) return text("Nothing to update. Provide name, description, and/or capabilities.");
        const updated = await api("PATCH", `/agents/${agentId}`, updates);
        return text(`Profile updated:\n${JSON.stringify(updated, null, 2)}`);
      }

      case "unregister": {
        if (!agentId) return text("Not registered.");
        await api("DELETE", `/agents/${agentId}`);
        disconnectSSE();
        const old = agentId;
        agentId = null;
        return text(`Agent ${old} unregistered.`);
      }

      case "list_agents": {
        if (!agentId) return text("You must register first.");
        const agents = await api("GET", `/agents/${agentId}/connections`);
        return text(JSON.stringify(agents, null, 2));
      }

      case "discover": {
        if (!agentId) return text("You must register first.");
        const { query, skills, domains, languages } = args as {
          query?: string;
          skills?: string[];
          domains?: string[];
          languages?: string[];
        };
        const allAgents = await api("GET", `/agents/${agentId}/connections`) as Array<{
          id: string; name: string; description: string; status: string;
          capabilities?: Record<string, string[]>;
        }>;
        const hasFilters = query || skills?.length || domains?.length || languages?.length;
        if (!hasFilters) return text(JSON.stringify(allAgents, null, 2));

        const matched = allAgents.filter((a) => {
          // Free-text keyword search against name + description
          if (query) {
            const keywords = query.toLowerCase().split(/\s+/);
            const haystack = `${a.name} ${a.description}`.toLowerCase();
            if (!keywords.some((kw) => haystack.includes(kw))) return false;
          }
          // Structured capability filters (all must match)
          const caps = a.capabilities || {};
          const matchCap = (filter: string[] | undefined, field: string) => {
            if (!filter?.length) return true;
            const values = (caps[field] || []).map((v: string) => v.toLowerCase());
            return filter.some((f) => values.includes(f.toLowerCase()));
          };
          if (!matchCap(skills, "skills")) return false;
          if (!matchCap(domains, "domains")) return false;
          if (!matchCap(languages, "languages")) return false;
          return true;
        });

        const filterDesc = [query, skills?.join(","), domains?.join(","), languages?.join(",")].filter(Boolean).join(", ");
        if (matched.length === 0) {
          return text(`No agents found matching "${filterDesc}". Connected agents:\n${JSON.stringify(allAgents, null, 2)}`);
        }
        return text(`Found ${matched.length} agent(s) matching "${filterDesc}":\n${JSON.stringify(matched, null, 2)}`);
      }

      case "send_message": {
        if (!agentId) return text("You must register first.");
        const { to, content } = args as { to: string; content: string };
        const result = await api("POST", "/messages", { from: agentId, to, content }) as { id: string; delivered: boolean; error?: string };
        if (result.error) return text(`Blocked: ${result.error}`);
        return text(result.delivered
          ? `Message sent to ${to} (delivered).`
          : `Agent ${to} is offline. Message not delivered.`);
      }

      case "broadcast": {
        if (!agentId) return text("You must register first.");
        const { content } = args as { content: string };
        const result = (await api("POST", "/messages/broadcast", {
          from: agentId,
          content,
        })) as { delivered: number };
        return text(`Broadcast delivered to ${result.delivered} agent(s).`);
      }

      case "set_status": {
        if (!agentId) return text("You must register first.");
        const { status } = args as { status: string };
        await api("PATCH", `/agents/${agentId}/status`, { status });
        return text(`Status set to "${status}".`);
      }

      case "create_task": {
        if (!agentId) return text("You must register first.");
        const { to, content, title, contextId } = args as { to: string; content: string; title?: string; contextId?: string };
        const body: Record<string, string> = { to, content };
        if (title) body.title = title;
        if (contextId) body.contextId = contextId;
        const task = await api("POST", "/tasks", body) as { id: string; status: string };
        return text(`Task created: ${task.id} (status: ${task.status}). Assigned to ${to}.`);
      }

      case "update_task": {
        if (!agentId) return text("You must register first.");
        const { taskId, status: taskStatus, content } = args as { taskId: string; status: string; content?: string };
        await api("PATCH", `/tasks/${taskId}`, { status: taskStatus });
        if (content) {
          await api("POST", `/tasks/${taskId}/messages`, { content });
        }
        return text(`Task ${taskId} updated to "${taskStatus}".${content ? " Message added." : ""}`);
      }

      case "reply_task": {
        if (!agentId) return text("You must register first.");
        const { taskId, content } = args as { taskId: string; content: string };
        await api("POST", `/tasks/${taskId}/messages`, { content });
        return text(`Reply sent on task ${taskId}.`);
      }

      case "list_tasks": {
        if (!agentId) return text("You must register first.");
        const { filter } = args as { filter?: string };
        let query = "";
        switch (filter) {
          case "assigned": query = `?to=${agentId}`; break;
          case "created": query = `?from=${agentId}`; break;
          case "active": query = `?active=true&agent=${agentId}`; break;
          default: query = `?agent=${agentId}`; break;
        }
        const tasks = await api("GET", `/tasks${query}`);
        return text(JSON.stringify(tasks, null, 2));
      }

      case "get_task": {
        if (!agentId) return text("You must register first.");
        const { taskId } = args as { taskId: string };
        const task = await api("GET", `/tasks/${taskId}`);
        return text(JSON.stringify(task, null, 2));
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// ── Channel Push Helper ─────────────────────────────────────────

// meta keys must be identifiers (letters, digits, underscores only)
function sanitizeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

async function pushChannel(content: string, meta: Record<string, string>): Promise<void> {
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  } catch (err) {
    console.error("Channel push failed:", err);
  }
}

// ── SSE Connection to Service ───────────────────────────────────

function parseSSEBlock(block: string): { event: string; data: string; id?: string } | null {
  let event = "";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    }
    // Ignore retry:, comments (lines starting with :), and unknown fields
  }

  if (!event || dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n"), id };
}

function backoffDelay(): number {
  const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
  return Math.round(sseRetryDelay * jitter);
}

async function handleSSEEvent(event: string, data: unknown): Promise<void> {
  const d = data as Record<string, string>;

  switch (event) {
    case "message":
      await pushChannel(
        `Message from ${d.from}: ${d.content}`,
        { from: sanitizeKey(d.from), msg_id: sanitizeKey(d.id) }
      );
      break;
    case "agent_online":
      await pushChannel(
        `Agent online: ${d.name} (${d.id}) — ${d.description}`,
        { event_type: "agent_online", agent_id: sanitizeKey(d.id) }
      );
      break;
    case "agent_offline":
      await pushChannel(
        `Agent offline: ${d.name} (${d.id})`,
        { event_type: "agent_offline", agent_id: sanitizeKey(d.id) }
      );
      break;
    case "connected_to":
      await pushChannel(
        `New connection: ${d.name} (${d.id}, ${d.status}) — ${d.description}`,
        { event_type: "connected_to", agent_id: sanitizeKey(d.id) }
      );
      break;
    case "disconnected_from":
      await pushChannel(
        `Connection removed: ${d.id}`,
        { event_type: "disconnected_from", agent_id: sanitizeKey(d.id) }
      );
      break;
    case "agent_renamed":
      await pushChannel(
        `Agent renamed: "${d.oldId}" is now "${d.newId}" (${d.name}). Use the new ID for future messages.`,
        { event_type: "agent_renamed", old_id: sanitizeKey(d.oldId), new_id: sanitizeKey(d.newId) }
      );
      break;
    case "agent_removed":
      if (d.id === agentId) {
        agentId = null;
        try { fs.unlinkSync(AGENT_CONFIG); } catch { /* may not exist */ }
        await pushChannel(
          `You were removed from the swarm by an admin. Your local config has been deleted. Use 'register' to rejoin.`,
          { event_type: "agent_removed" }
        );
      } else {
        await pushChannel(
          `Agent "${d.name}" (${d.id}) was removed from the swarm.`,
          { event_type: "agent_removed", agent_id: sanitizeKey(d.id) }
        );
      }
      break;
    case "properties_updated":
      if (d.id && d.id !== agentId) {
        agentId = d.id;
        saveLocalConfig({ id: d.id, autoconnect: true });
      }
      await pushChannel(
        `Your properties were updated by the swarm admin. No action required. New values — ID: "${d.id || agentId}", Name: "${d.name}", Description: "${d.description}".${d.publicDescription ? ` Public description: "${d.publicDescription}".` : ""}`,
        { event_type: "properties_updated" }
      );
      break;
    case "task_created":
      await pushChannel(
        `New task from ${d.from}: "${d.title || "(untitled)"}" (${d.id}, status: ${d.status})\n${d.content}`,
        { event_type: "task_created", task_id: sanitizeKey(d.id), from: sanitizeKey(d.from) }
      );
      break;
    case "task_updated":
      await pushChannel(
        `Task ${d.id} updated to "${d.status}"${d.updatedBy ? ` by ${d.updatedBy}` : ""}.${d.content ? ` Message: ${d.content}` : ""}`,
        { event_type: "task_updated", task_id: sanitizeKey(d.id) }
      );
      break;
    case "task_message":
      await pushChannel(
        `Task ${d.taskId} — message from ${d.from}: ${d.content}`,
        { event_type: "task_message", task_id: sanitizeKey(d.taskId), from: sanitizeKey(d.from) }
      );
      break;
    case "task_artifact": {
      const art = (data as Record<string, unknown>).artifact as Record<string, string>;
      await pushChannel(
        `Task ${d.taskId} — new artifact: "${art.name}" (${art.mimeType})`,
        { event_type: "task_artifact", task_id: sanitizeKey(d.taskId) }
      );
      break;
    }
    // connected, heartbeat, and unknown events are silently ignored
  }
}

async function connectSSE(id: string): Promise<void> {
  disconnectSSE();

  sseAbort = new AbortController();
  const { signal } = sseAbort;

  try {
    const sseUrl = agentApiKey
      ? `${SERVICE_URL}/events/${id}?token=${encodeURIComponent(agentApiKey)}`
      : `${SERVICE_URL}/events/${id}`;
    const sseHeaders: Record<string, string> = {};
    if (lastEventId) sseHeaders["Last-Event-ID"] = lastEventId;
    const res = await fetch(sseUrl, { signal, headers: sseHeaders });

    // Stop retrying on auth errors — re-register needed
    if (res.status === 401 || res.status === 403) {
      console.error(`[swarm] SSE auth failed (${res.status}) — stopping reconnect`);
      await pushChannel(
        `SSE connection rejected: authentication failed (${res.status}). Your API key may be invalid or expired. Use 'register' to re-register and get a new key.`,
        { event_type: "auth_failed" }
      );
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) return;

    // Connection succeeded — reset backoff
    sseRetryDelay = 1000;

    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const parsed = parseSSEBlock(part);
        if (!parsed) continue;

        if (parsed.id) lastEventId = parsed.id;

        let data: unknown;
        try {
          data = JSON.parse(parsed.data);
        } catch (err) {
          console.error(`[swarm] SSE JSON parse error for event "${parsed.event}":`, err);
          continue;
        }

        await handleSSEEvent(parsed.event, data);
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      const delay = backoffDelay();
      console.error(`[swarm] SSE connection error, retrying in ${delay}ms:`, (err as Error).message);

      // Escalate backoff: 1s → 2s → 4s → 8s → 16s → 30s cap
      sseRetryDelay = Math.min(sseRetryDelay * 2, 30000);

      setTimeout(async () => {
        if (agentId !== id) return;
        try {
          const reconnHeaders: Record<string, string> = {};
          if (agentApiKey) reconnHeaders["Authorization"] = `Bearer ${agentApiKey}`;
          const reconnRes = await fetch(`${SERVICE_URL}/agents/${id}/connect`, { method: "POST", headers: reconnHeaders });
          if (reconnRes.status === 401 || reconnRes.status === 403) {
            console.error(`[swarm] Reconnect auth failed (${reconnRes.status}) — stopping`);
            await pushChannel(
              `Reconnect failed: authentication rejected (${reconnRes.status}). Use 'register' to re-register.`,
              { event_type: "auth_failed" }
            );
            return;
          }
          console.error(`[swarm] Reconnected ${id}`);
        } catch { /* service might still be down */ }
        connectSSE(id);
      }, delay);
    }
  }
}

function disconnectSSE(): void {
  if (sseAbort) {
    sseAbort.abort();
    sseAbort = null;
  }
}

// ── Start ───────────────────────────────────────────────────────

async function autoRegister(): Promise<void> {
  const config = loadLocalConfig();
  if (!config) return;
  if (!config.autoconnect) return;

  // Load apiKey from config for authenticated requests
  agentApiKey = config.apiKey || null;

  try {
    // Try reconnect (agent already known to service)
    const connectHeaders: Record<string, string> = {};
    if (agentApiKey) connectHeaders["Authorization"] = `Bearer ${agentApiKey}`;
    const connectRes = await fetch(`${SERVICE_URL}/agents/${config.id}/connect`, { method: "POST", headers: connectHeaders });

    if (connectRes.ok) {
      const data = await connectRes.json() as {
        agent: { id: string; name: string; description: string };
        connections: Array<{ id: string; name: string; description: string; status: string }>;
      };
      agentId = config.id;
      connectSSE(config.id);

      const connList = data.connections.length > 0
        ? `Connected to: ${data.connections.map((c) => `${c.name} (${c.id}, ${c.status})`).join(", ")}.`
        : "No connections yet — an admin needs to add you to the topology.";

      await pushChannel(
        `Reconnected to swarm as "${data.agent.name}" (${data.agent.id}). ${data.agent.description} ${connList} If your capabilities have changed (new skills, MCPs, etc.), use update_profile to update your swarm description.`,
        { event_type: "auto_connected", agent_id: sanitizeKey(config.id) }
      );
      console.error(`[swarm] Auto-connected as ${config.id}`);
    } else if (connectRes.status === 404) {
      // Agent was removed or doesn't exist — clean up local config
      try { fs.unlinkSync(AGENT_CONFIG); } catch { /* may not exist */ }
      await pushChannel(
        `Auto-connect failed: agent "${config.id}" was removed or is unknown to the swarm service. Local config deleted. Use 'register' to rejoin with a full description of your capabilities.`,
        { event_type: "auto_connect_failed" }
      );
      console.error(`[swarm] Auto-connect failed: ${config.id} not found, local config deleted`);
    }
  } catch (err) {
    console.error(`[swarm] Auto-connect failed:`, err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Wait for Claude Code to set up channel listener
  await delay(1000);
  await autoRegister();

  // Cleanup on exit
  const cleanup = async () => {
    disconnectSSE(); // SSE close triggers service-side removal
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch(console.error);
