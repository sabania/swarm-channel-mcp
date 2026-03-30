import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchMetrics, fetchAllTasks, type Metrics, type Task } from "../api";
import { StatCard } from "../components/StatCard";
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

export function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [m, tasks] = await Promise.all([fetchMetrics(), fetchAllTasks()]);
        if (cancelled) return;
        setMetrics(m);
        setRecentTasks(tasks.slice(0, 10));
      } catch { /* auth dialog will handle 401 */ }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const activeTasks = metrics
    ? (metrics.tasks.byStatus["submitted"] || 0) +
      (metrics.tasks.byStatus["working"] || 0) +
      (metrics.tasks.byStatus["input-required"] || 0)
    : 0;

  return (
    <div style={{ padding: 24, fontFamily: fonts.body, color: colors.text, maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 20px" }}>Dashboard</h1>

      {/* Stat Cards */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 32 }}>
        <StatCard
          title="Agents Online"
          value={metrics ? `${metrics.agents.online}/${metrics.agents.total}` : "—"}
          accentColor={colors.green}
        />
        <StatCard
          title="Active Tasks"
          value={metrics ? activeTasks : "—"}
          accentColor={colors.blue}
        />
        <StatCard
          title="Completed"
          value={metrics?.tasks.byStatus["completed"] ?? "—"}
          accentColor={colors.mauve}
        />
        <StatCard
          title="Uptime"
          value={metrics ? `${Math.floor(metrics.uptime / 60)}m` : "—"}
          accentColor={colors.peach}
        />
      </div>

      {/* Recent Tasks */}
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 12px" }}>Recent Tasks</h2>
      {recentTasks.length === 0 ? (
        <div style={{ color: colors.overlay0, fontSize: 13 }}>No tasks yet</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {recentTasks.map((task) => (
            <div
              key={task.id}
              onClick={() => navigate(`/tasks/${task.id}`)}
              style={{
                background: colors.base,
                border: `1px solid ${colors.surface0}`,
                borderRadius: 8,
                padding: "10px 14px",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{task.title || task.id}</span>
                <span style={{ fontSize: 11, color: colors.overlay0, marginLeft: 8 }}>
                  {task.fromAgent} → {task.toAgent}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                <span style={{ fontSize: 11, color: colors.overlay0 }}>{timeAgo(task.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
