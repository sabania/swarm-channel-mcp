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

// ── Local Agent Config ──────────────────────────────────────────

interface SavedAgent {
  id: string;
  name: string;
  capabilities: string[];
  autoconnect: boolean;
}

function saveAgentConfig(agent: SavedAgent): void {
  fs.writeFileSync(AGENT_CONFIG, JSON.stringify(agent, null, 2), "utf-8");
}

function loadAgentConfig(): SavedAgent | null {
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
      "Messages from other agents arrive as notifications automatically (fire and forget, no inbox).",
      "Available tools: register, unregister, list_agents, discover, send_message, broadcast, set_status.",
      "You must call 'register' first before using other tools.",
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
        capabilities: {
          type: "array",
          items: { type: "string" },
          description: "List of capabilities, e.g. ['react','typescript']",
        },
      },
      required: ["id", "name", "capabilities"],
    },
  },
  {
    name: "unregister",
    description: "Unregister this agent from the swarm.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_agents",
    description: "List all active agents in the swarm.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "discover",
    description: "Find agents that have a specific capability.",
    inputSchema: {
      type: "object" as const,
      properties: {
        capability: { type: "string", description: "Capability to search for" },
      },
      required: ["capability"],
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
        const { id, name: agentName, capabilities } = args as {
          id: string;
          name: string;
          capabilities: string[];
        };
        await api("POST", "/agents", { id, name: agentName, capabilities });
        agentId = id;
        saveAgentConfig({ id, name: agentName, capabilities, autoconnect: true });
        connectSSE(id);
        return text(
          `Registered as "${agentName}" (${id}). Capabilities: ${capabilities.join(", ")}. Listening for messages. Config saved for auto-reconnect.`
        );
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
        const agents = await api("GET", "/agents");
        return text(JSON.stringify(agents, null, 2));
      }

      case "discover": {
        const { capability } = args as { capability: string };
        const found = await api("GET", `/agents/discover?capability=${encodeURIComponent(capability)}`);
        return text(JSON.stringify(found, null, 2));
      }

      case "send_message": {
        if (!agentId) return text("You must register first.");
        const { to, content } = args as { to: string; content: string };
        const result = await api("POST", "/messages", { from: agentId, to, content }) as { id: string; delivered: boolean };
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
            `Agent online: ${data.name} (${data.id}) — capabilities: ${data.capabilities?.join(", ")}`,
            { event_type: "agent_online", agent_id: sanitizeKey(data.id) }
          );
        } else if (event === "agent_offline") {
          await pushChannel(
            `Agent offline: ${data.name} (${data.id})`,
            { event_type: "agent_offline", agent_id: sanitizeKey(data.id) }
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
        const saved = loadAgentConfig();
        if (saved) {
          try {
            await api("POST", "/agents", saved);
            console.error(`[swarm] Re-registered ${id} after reconnect`);
          } catch { /* service might still be down, next retry will try again */ }
        }
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
  const saved = loadAgentConfig();
  if (!saved) return; // first time → Claude must call register manually
  if (!saved.autoconnect) return;

  try {
    await api("POST", "/agents", saved);
    agentId = saved.id;
    connectSSE(saved.id);
    console.error(`[swarm] Auto-connected as ${saved.id} (${saved.name})`);
    await pushChannel(
      `Auto-connected to swarm as "${saved.name}" (${saved.id}). Capabilities: ${saved.capabilities.join(", ")}.`,
      { event_type: "auto_connected", agent_id: sanitizeKey(saved.id) }
    );
  } catch (err) {
    console.error(`[swarm] Auto-connect failed:`, err);
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
