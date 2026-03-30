export const DEFAULT_LAUNCH_CMD = "claude --continue --dangerously-load-development-channels plugin:swarm@swarm-channel";

export interface AgentCapabilities {
  skills?: string[];
  languages?: string[];
  frameworks?: string[];
  tools?: string[];
  mcps?: string[];
  domains?: string[];
}

export type AgentStatus = "provisioned" | "claimed" | "available" | "busy" | "offline" | "suspended" | "decommissioned";

export interface AgentInfo {
  id: string;
  name: string;
  description: string;         // internal - full context, private
  publicDescription: string;   // external - shown to other agents (fallback: description)
  cwd: string;
  autoconnect: boolean;
  launchCommand: string;       // customizable per agent
  status: AgentStatus;
  capabilities?: AgentCapabilities;
  email?: string;
  department?: string;
  role?: string;
  claimToken?: string;         // one-time token for claiming provisioned agents
  registeredAt: string;
  lastSeen: string;
}

// ── Typed Edges ─────────────────────────────────────────────────

export type EdgeType = "peer" | "reports-to" | "team" | "department" | "custom";

export interface EdgePermissions {
  canDelegate?: boolean;
  canAudit?: boolean;
  canOverride?: boolean;
  canManage?: boolean;
}

export interface Edge {
  id: string;
  fromAgent: string;
  toAgent: string;
  type: EdgeType;
  permissions: EdgePermissions | null;
  createdAt: string;
  createdBy: string;
}

// ── Connection Requests ─────────────────────────────────────────

export type ConnectionRequestStatus = "pending" | "accepted" | "declined" | "expired";

export interface ConnectionRequest {
  id: string;
  fromAgent: string;
  toAgent: string;
  type: EdgeType;
  reason: string | null;
  status: ConnectionRequestStatus;
  createdAt: string;
  respondedAt: string | null;
}

/** What other agents see */
export interface AgentPublicView {
  id: string;
  name: string;
  description: string;  // publicDescription or fallback to description
  status: AgentStatus;
}

export interface SwarmTopology {
  nodes: Record<string, AgentInfo>;
  edges: [string, string][];
}

// ── Task Engine (A2A-compatible) ────────────────────────────────

export type TaskStatus = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";

/** Valid state transitions: from → allowed targets */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  submitted:        ["working", "canceled", "failed"],
  working:          ["completed", "failed", "canceled", "input-required"],
  "input-required": ["working", "canceled", "failed"],
  completed:        [],
  failed:           [],
  canceled:         [],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface Task {
  id: string;
  contextId: string | null;
  fromAgent: string;
  toAgent: string;
  status: TaskStatus;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  ttlSeconds: number;
  retryCount: number;
  metadata: Record<string, unknown> | null;
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

export interface TaskDetail extends Task {
  messages: TaskMessage[];
  artifacts: TaskArtifact[];
}
