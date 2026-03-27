import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AgentInfo } from "./api";

export type AgentNodeData = {
  agent: AgentInfo;
  selected: boolean;
  onSelect: (id: string) => void;
};

const statusColor: Record<string, string> = {
  available: "#22c55e",
  busy: "#f59e0b",
  offline: "#6b7280",
};

export function AgentNode({ data }: NodeProps) {
  const { agent, selected, onSelect } = data as unknown as AgentNodeData;
  const color = statusColor[agent.status] || "#6b7280";

  return (
    <div
      onClick={() => onSelect(agent.id)}
      style={{
        background: selected ? "#242438" : "#1e1e2e",
        border: `2px solid ${selected ? "#89b4fa" : color}`,
        borderRadius: 12,
        padding: "12px 16px",
        minWidth: 160,
        cursor: "pointer",
        color: "#cdd6f4",
        fontFamily: "system-ui, sans-serif",
        boxShadow: selected ? "0 0 12px rgba(137,180,250,0.3)" : "none",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        <strong style={{ fontSize: 14 }}>{agent.name}</strong>
      </div>
      <div style={{ fontSize: 11, color: "#a6adc8", lineHeight: 1.3 }}>
        {(agent.publicDescription || agent.description || "").slice(0, 80)}
        {(agent.publicDescription || agent.description || "").length > 80 ? "…" : ""}
      </div>
      <div style={{ fontSize: 10, color: "#585b70", marginTop: 4 }}>
        {agent.id}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}
