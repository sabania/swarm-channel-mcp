export interface AgentInfo {
  id: string;
  name: string;
  description: string;         // internal - full context, private
  publicDescription: string;   // external - shown to other agents (fallback: description)
  cwd: string;
  autoconnect: boolean;
  status: "available" | "busy" | "offline";
  registeredAt: string;
  lastSeen: string;
}

/** What other agents see */
export interface AgentPublicView {
  id: string;
  name: string;
  description: string;  // publicDescription or fallback to description
  status: "available" | "busy" | "offline";
}

export interface SwarmTopology {
  nodes: Record<string, AgentInfo>;
  edges: [string, string][];
}
