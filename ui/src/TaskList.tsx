import { useEffect, useState } from "react";
import { fetchTasks, type Task, type TaskStatus } from "./api";

interface Props {
  agentId: string;
  onSelectTask: (taskId: string) => void;
}

const statusBadge: Record<TaskStatus, { bg: string; color: string; label: string }> = {
  submitted:        { bg: "#585b7033", color: "#a6adc8", label: "Submitted" },
  working:          { bg: "#89b4fa33", color: "#89b4fa", label: "Working" },
  "input-required": { bg: "#f9e2af33", color: "#f9e2af", label: "Input Required" },
  completed:        { bg: "#a6e3a133", color: "#a6e3a1", label: "Completed" },
  failed:           { bg: "#f38ba833", color: "#f38ba8", label: "Failed" },
  canceled:         { bg: "#585b7022", color: "#585b70", label: "Canceled" },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function TaskList({ agentId, onSelectTask }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const data = await fetchTasks(agentId);
        if (!cancelled) setTasks(data);
      } catch {
        if (!cancelled) setError("Failed to load tasks");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [agentId]);

  if (loading && tasks.length === 0) {
    return <div style={{ color: "#585b70", fontSize: 13, padding: "20px 0", textAlign: "center" }}>Loading tasks...</div>;
  }

  if (error) {
    return <div style={{ color: "#f38ba8", fontSize: 13, padding: "20px 0", textAlign: "center" }}>{error}</div>;
  }

  if (tasks.length === 0) {
    return <div style={{ color: "#585b70", fontSize: 13, padding: "20px 0", textAlign: "center" }}>No tasks yet</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {tasks.map((task) => {
        const badge = statusBadge[task.status];
        return (
          <div
            key={task.id}
            onClick={() => onSelectTask(task.id)}
            style={{
              background: "#1e1e2e",
              border: "1px solid #313244",
              borderRadius: 8,
              padding: "10px 12px",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#cdd6f4" }}>
                {task.title || task.id}
              </span>
              <span style={{
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: 4,
                background: badge.bg,
                color: badge.color,
                fontWeight: 600,
                textDecoration: task.status === "canceled" ? "line-through" : "none",
              }}>
                {badge.label}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "#585b70", display: "flex", justifyContent: "space-between" }}>
              <span>{task.fromAgent} → {task.toAgent}</span>
              <span>{timeAgo(task.updatedAt)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
