export interface AgentInfo {
  id: string;
  name: string;
  capabilities: string[];
  status: "available" | "busy" | "offline";
  registeredAt: string;
  lastSeen: string;
}
