import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAllTasks, type Task, type TaskStatus } from "../api";
import { colors, fonts } from "../theme";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const statusColors: Record<string, string> = {
  submitted: colors.overlay0,
  working: colors.blue,
  "input-required": colors.yellow,
  completed: colors.green,
  failed: colors.red,
  canceled: colors.overlay0,
};

const allStatuses: TaskStatus[] = ["submitted", "working", "input-required", "completed", "failed", "canceled"];

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const filters = statusFilter ? { status: statusFilter as TaskStatus } : undefined;
        const data = await fetchAllTasks(filters);
        if (!cancelled) setTasks(data);
      } catch { /* auth dialog handles 401 */ }
      if (!cancelled) setLoading(false);
    }
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [statusFilter]);

  return (
    <div style={{ padding: 24, fontFamily: fonts.body, color: colors.text, maxWidth: 960 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Tasks</h1>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as TaskStatus | "")}
          style={{
            background: colors.base,
            border: `1px solid ${colors.surface0}`,
            borderRadius: 6,
            color: colors.text,
            padding: "6px 10px",
            fontSize: 12,
          }}
        >
          <option value="">All statuses</option>
          {allStatuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {loading && tasks.length === 0 ? (
        <div style={{ color: colors.overlay0, fontSize: 13, textAlign: "center", padding: 40 }}>Loading...</div>
      ) : tasks.length === 0 ? (
        <div style={{ color: colors.overlay0, fontSize: 13, textAlign: "center", padding: 40 }}>No tasks found</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {tasks.map((task) => (
            <div
              key={task.id}
              onClick={() => navigate(`/tasks/${task.id}`)}
              style={{
                background: colors.base,
                border: `1px solid ${colors.surface0}`,
                borderRadius: 8,
                padding: "12px 14px",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{task.title || task.id}</span>
                <span style={{
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: (statusColors[task.status] || colors.overlay0) + "33",
                  color: statusColors[task.status] || colors.overlay0,
                  fontWeight: 600,
                }}>
                  {task.status}
                </span>
              </div>
              <div style={{ fontSize: 11, color: colors.overlay0, display: "flex", justifyContent: "space-between" }}>
                <span>{task.fromAgent} → {task.toAgent}</span>
                <span>{timeAgo(task.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
