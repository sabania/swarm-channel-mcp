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
let sseAbort: AbortController | null = null;

// ── Local Config (minimal - just ID + autoconnect) ──────────────

interface LocalConfig {
  id: string;
  autoconnect: boolean;
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
      "Available tools: register, whoami, update_profile, unregister, list_agents, discover, send_message, broadcast, set_status.",
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
    description: "Update your own description or name in the swarm (not ID). Use when your capabilities change, e.g. new MCP installed or workspace changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "New name (optional)" },
        description: { type: "string", description: "New description (optional)" },
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
    description: "Search for agents by what they can do. Searches descriptions of connected agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "What you're looking for, e.g. 'react development' or 'someone who can review code'" },
      },
      required: ["query"],
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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Tool Handlers ───────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${SERVICE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
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
        const { id, name: agentName, description } = args as {
          id: string;
          name: string;
          description: string;
        };
        await api("POST", "/agents", { id, name: agentName, description });
        agentId = id;
        saveLocalConfig({ id, autoconnect: true });
        connectSSE(id);
        return text(
          `Registered as "${agentName}" (${id}). Listening for messages. Auto-reconnect enabled.`
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
        const updates: Record<string, string> = {};
        const a = args as { name?: string; description?: string };
        if (a.name) updates.name = a.name;
        if (a.description) updates.description = a.description;
        if (Object.keys(updates).length === 0) return text("Nothing to update. Provide name and/or description.");
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
        const { query } = args as { query: string };
        const agents = await api("GET", `/agents/${agentId}/connections`);
        return text(`Searching for: "${query}"\n\n${JSON.stringify(agents, null, 2)}`);
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

async function connectSSE(id: string): Promise<void> {
  disconnectSSE();

  sseAbort = new AbortController();
  const { signal } = sseAbort;

  try {
    const res = await fetch(`${SERVICE_URL}/events/${id}`, { signal });
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const eventMatch = part.match(/^event:\s*(.+)$/m);
        const dataMatch = part.match(/^data:\s*(.+)$/m);
        if (!eventMatch || !dataMatch) continue;

        const event = eventMatch[1];
        const data = JSON.parse(dataMatch[1]);

        if (event === "message") {
          await pushChannel(
            `Message from ${data.from}: ${data.content}`,
            { from: sanitizeKey(data.from), msg_id: sanitizeKey(data.id) }
          );
        } else if (event === "agent_online") {
          await pushChannel(
            `Agent online: ${data.name} (${data.id}) — ${data.description}`,
            { event_type: "agent_online", agent_id: sanitizeKey(data.id) }
          );
        } else if (event === "agent_offline") {
          await pushChannel(
            `Agent offline: ${data.name} (${data.id})`,
            { event_type: "agent_offline", agent_id: sanitizeKey(data.id) }
          );
        } else if (event === "connected_to") {
          await pushChannel(
            `New connection: ${data.name} (${data.id}) — ${data.description}`,
            { event_type: "connected_to", agent_id: sanitizeKey(data.id) }
          );
        } else if (event === "disconnected_from") {
          await pushChannel(
            `Connection removed: ${data.id}`,
            { event_type: "disconnected_from", agent_id: sanitizeKey(data.id) }
          );
        } else if (event === "agent_renamed") {
          await pushChannel(
            `Agent renamed: "${data.oldId}" is now "${data.newId}" (${data.name}). Use the new ID for future messages.`,
            { event_type: "agent_renamed", old_id: sanitizeKey(data.oldId), new_id: sanitizeKey(data.newId) }
          );
        } else if (event === "properties_updated") {
          // Update local ID if changed
          if (data.id && data.id !== agentId) {
            agentId = data.id;
            saveLocalConfig({ id: data.id, autoconnect: true });
          }
          await pushChannel(
            `Your properties were updated by the swarm admin. No action required. New values — ID: "${data.id || agentId}", Name: "${data.name}", Description: "${data.description}".${data.publicDescription ? ` Public description: "${data.publicDescription}".` : ""}`,
            { event_type: "properties_updated" }
          );
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      console.error("SSE connection error:", err);
      // Reconnect after 3 seconds: re-register + SSE
      setTimeout(async () => {
        if (agentId !== id) return;
        try {
          await fetch(`${SERVICE_URL}/agents/${id}/connect`, { method: "POST" });
          console.error(`[swarm] Reconnected ${id}`);
        } catch { /* service might still be down */ }
        connectSSE(id);
      }, 3000);
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

  try {
    // Try reconnect (agent already known to service)
    const connectRes = await fetch(`${SERVICE_URL}/agents/${config.id}/connect`, { method: "POST" });

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
      await pushChannel(
        `Auto-connect failed: agent "${config.id}" is not known to the swarm service. Use 'register' to register with a full description of your capabilities.`,
        { event_type: "auto_connect_failed" }
      );
      console.error(`[swarm] Auto-connect failed: ${config.id} not found in service`);
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
