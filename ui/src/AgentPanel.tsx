import { useState } from "react";
import type { AgentInfo } from "./api";
import { updateAgent, removeAgent, launchAgent } from "./api";
import { TaskList } from "./TaskList";
import { TaskDetail } from "./TaskDetail";

type Tab = "properties" | "tasks";

interface Props {
  agent: AgentInfo;
  onClose: () => void;
  onUpdate: () => void;
  onSelectAgent: (id: string) => void;
}

export function AgentPanel({ agent, onClose, onUpdate, onSelectAgent }: Props) {
  const [tab, setTab] = useState<Tab>("properties");
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [agentId, setAgentId] = useState(agent.id);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [publicDesc, setPublicDesc] = useState(agent.publicDescription);
  const [autoconnect, setAutoconnect] = useState(agent.autoconnect);
  const DEFAULT_LAUNCH_CMD = "claude --continue --dangerously-load-development-channels plugin:swarm@swarm-channel";
  const [launchCmd, setLaunchCmd] = useState(agent.launchCommand || DEFAULT_LAUNCH_CMD);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const statusColor: Record<string, string> = {
    available: "#22c55e",
    busy: "#f59e0b",
    offline: "#6b7280",
  };

  async function handleSave() {
    setSaving(true);
    setError("");
    const idChanged = agentId !== agent.id;
    const result = await updateAgent(agent.id, {
      ...(idChanged ? { id: agentId } : {}),
      name,
      description,
      publicDescription: publicDesc,
      autoconnect,
      launchCommand: launchCmd,
    });
    setSaving(false);
    if (!result || result.error) {
      setError(result?.error || "Failed to update. ID might be taken.");
      return;
    }
    if (idChanged) onSelectAgent(agentId);
    onUpdate();
  }

  async function handleLaunch() {
    setError("");
    const result = await launchAgent(agent.id);
    if (result.error) {
      setError(result.error);
    }
    onUpdate();
  }

  async function handleRemove() {
    if (confirm(`Remove agent "${agent.name}"?`)) {
      await removeAgent(agent.id);
      onClose();
      onUpdate();
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: 360,
        background: "#181825",
        borderLeft: "1px solid #313244",
        padding: 20,
        overflowY: "auto",
        fontFamily: "system-ui, sans-serif",
        color: "#cdd6f4",
        zIndex: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Agent Details</h2>
        <button onClick={onClose} style={btnStyle}>✕</button>
      </div>

      {/* Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: statusColor[agent.status] }} />
        <span style={{ fontSize: 13, color: "#a6adc8" }}>{agent.status}</span>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "1px solid #313244" }}>
        {(["properties", "tasks"] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setSelectedTask(null); }}
            style={{
              padding: "8px 16px",
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid #89b4fa" : "2px solid transparent",
              color: tab === t ? "#cdd6f4" : "#585b70",
              fontSize: 13,
              fontWeight: tab === t ? 600 : 400,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: "#f38ba822", border: "1px solid #f38ba8", borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "#f38ba8", marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Properties Tab */}
      {tab === "properties" && (
        <>
          <label style={labelStyle}>ID</label>
          <input style={inputStyle} value={agentId} onChange={(e) => setAgentId(e.target.value)} />

          <label style={labelStyle}>Name</label>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />

          <label style={labelStyle}>Internal Description (private)</label>
          <textarea style={{ ...inputStyle, height: 80, resize: "vertical" }} value={description} onChange={(e) => setDescription(e.target.value)} />

          <label style={labelStyle}>Public Description (shown to others)</label>
          <textarea
            style={{ ...inputStyle, height: 80, resize: "vertical" }}
            value={publicDesc}
            onChange={(e) => setPublicDesc(e.target.value)}
            placeholder="Leave empty to use internal description"
          />

          <label style={labelStyle}>Working Directory</label>
          <input style={{ ...inputStyle, color: "#585b70" }} value={agent.cwd} readOnly />

          <label style={labelStyle}>Launch Command</label>
          <input style={inputStyle} value={launchCmd} onChange={(e) => setLaunchCmd(e.target.value)} />

          <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={autoconnect} onChange={(e) => setAutoconnect(e.target.checked)} />
            Autoconnect on startup
          </label>

          <div style={{ fontSize: 11, color: "#585b70", marginTop: 12 }}>
            Registered: {new Date(agent.registeredAt).toLocaleString()}<br />
            Last seen: {new Date(agent.lastSeen).toLocaleString()}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            <button onClick={handleSave} disabled={saving} style={{ ...btnStyle, background: "#89b4fa", color: "#1e1e2e", flex: 1 }}>
              {saving ? "Saving..." : "Save"}
            </button>
            {agent.status === "offline" && agent.cwd && (
              <button onClick={handleLaunch} style={{ ...btnStyle, background: "#a6e3a1", color: "#1e1e2e" }}>
                Launch
              </button>
            )}
            <button onClick={handleRemove} style={{ ...btnStyle, background: "#f38ba8", color: "#1e1e2e" }}>
              Remove
            </button>
          </div>
        </>
      )}

      {/* Tasks Tab */}
      {tab === "tasks" && !selectedTask && (
        <TaskList agentId={agent.id} onSelectTask={setSelectedTask} />
      )}

      {tab === "tasks" && selectedTask && (
        <TaskDetail taskId={selectedTask} onBack={() => setSelectedTask(null)} />
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#a6adc8",
  marginTop: 12,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 6,
  color: "#cdd6f4",
  fontSize: 13,
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  padding: "6px 12px",
  background: "#313244",
  border: "none",
  borderRadius: 6,
  color: "#cdd6f4",
  cursor: "pointer",
  fontSize: 13,
};
