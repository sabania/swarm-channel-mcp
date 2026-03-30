import { useEffect, useState } from "react";
import { fetchTask, type TaskDetail as TaskDetailType, type TaskStatus } from "./api";

interface Props {
  taskId: string;
  onBack: () => void;
}

const statusColors: Record<TaskStatus, string> = {
  submitted: "#a6adc8",
  working: "#89b4fa",
  "input-required": "#f9e2af",
  completed: "#a6e3a1",
  failed: "#f38ba8",
  canceled: "#585b70",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function TaskDetail({ taskId, onBack }: Props) {
  const [detail, setDetail] = useState<TaskDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchTask(taskId);
        if (!cancelled) setDetail(data);
      } catch {
        if (!cancelled) setError("Failed to load task");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [taskId]);

  if (loading && !detail) {
    return <div style={{ color: "#585b70", fontSize: 13, padding: "20px 0", textAlign: "center" }}>Loading...</div>;
  }

  if (error || !detail) {
    return <div style={{ color: "#f38ba8", fontSize: 13, padding: "20px 0", textAlign: "center" }}>{error || "Task not found"}</div>;
  }

  const { task, messages, artifacts } = detail;
  const color = statusColors[task.status];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          color: "#89b4fa",
          cursor: "pointer",
          fontSize: 12,
          padding: 0,
          textAlign: "left",
        }}
      >
        ← Back to tasks
      </button>

      {/* Header */}
      <div>
        <h3 style={{ margin: "0 0 6px", fontSize: 15, color: "#cdd6f4" }}>
          {task.title || task.id}
        </h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
          <span style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: color + "33",
            color,
            fontWeight: 600,
          }}>
            {task.status}
          </span>
          <span style={{ color: "#585b70" }}>{task.fromAgent} → {task.toAgent}</span>
        </div>
      </div>

      {/* Timestamps */}
      <div style={{ fontSize: 11, color: "#585b70" }}>
        Created: {formatTime(task.createdAt)}<br />
        Updated: {formatTime(task.updatedAt)}
        {task.completedAt && <><br />Completed: {formatTime(task.completedAt)}</>}
      </div>

      {/* Messages */}
      {messages.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: "#a6adc8", marginBottom: 6, fontWeight: 600 }}>Messages</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  background: msg.role === "sender" ? "#1e1e2e" : "#242438",
                  border: "1px solid #313244",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontSize: 11, color: "#585b70", marginBottom: 4 }}>
                  <span style={{ color: msg.role === "sender" ? "#89b4fa" : "#a6e3a1", fontWeight: 600 }}>
                    {msg.agentId}
                  </span>
                  {" · "}
                  {formatTime(msg.createdAt)}
                </div>
                <div style={{ fontSize: 13, color: "#cdd6f4", whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                  {msg.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Artifacts */}
      {artifacts.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: "#a6adc8", marginBottom: 6, fontWeight: 600 }}>Artifacts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {artifacts.map((art) => (
              <a
                key={art.id}
                href={`data:${art.mimeType};base64,${art.data}`}
                download={art.name}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#1e1e2e",
                  border: "1px solid #313244",
                  borderRadius: 6,
                  padding: "6px 10px",
                  color: "#89b4fa",
                  fontSize: 12,
                  textDecoration: "none",
                }}
              >
                <span>{art.name}</span>
                <span style={{ color: "#585b70", fontSize: 10 }}>{art.mimeType}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
