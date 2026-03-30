import { useEffect, useState } from "react";
import { colors, fonts } from "../theme";

// Types — will move to api.ts when Service-Dev has endpoints
interface ConnectionRequest {
  id: string;
  fromAgent: string;
  toAgent: string;
  message?: string;
  status: "pending" | "accepted" | "declined";
  createdAt: string;
}

interface ConnectedAgent {
  id: string;
  name: string;
  description: string;
  status: "available" | "busy" | "offline";
}

// TODO: Replace with real API calls when endpoints exist
async function fetchConnections(_agentId: string): Promise<ConnectedAgent[]> {
  return [];
}

async function fetchConnectionRequests(_agentId: string): Promise<ConnectionRequest[]> {
  return [];
}

async function acceptRequest(_requestId: string): Promise<void> {}
async function declineRequest(_requestId: string): Promise<void> {}

const statusColor: Record<string, string> = {
  available: colors.green,
  busy: colors.yellow,
  offline: colors.overlay0,
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

type Tab = "connections" | "requests";

export function ConnectionsPage() {
  const [tab, setTab] = useState<Tab>("connections");
  const [connections, setConnections] = useState<ConnectedAgent[]>([]);
  const [requests, setRequests] = useState<ConnectionRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [conns, reqs] = await Promise.all([
          fetchConnections("me"),
          fetchConnectionRequests("me"),
        ]);
        if (cancelled) return;
        setConnections(conns);
        setRequests(reqs);
      } catch { /* */ }
      if (!cancelled) setLoading(false);
    }
    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const pendingRequests = requests.filter((r) => r.status === "pending");

  async function handleAccept(id: string) {
    await acceptRequest(id);
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, status: "accepted" as const } : r));
  }

  async function handleDecline(id: string) {
    await declineRequest(id);
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, status: "declined" as const } : r));
  }

  return (
    <div style={{ padding: 24, fontFamily: fonts.body, color: colors.text, maxWidth: 960 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 20px" }}>Connections</h1>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: `1px solid ${colors.surface0}` }}>
        <button
          onClick={() => setTab("connections")}
          style={{
            padding: "8px 16px",
            background: "none",
            border: "none",
            borderBottom: tab === "connections" ? `2px solid ${colors.blue}` : "2px solid transparent",
            color: tab === "connections" ? colors.text : colors.overlay0,
            fontSize: 13,
            fontWeight: tab === "connections" ? 600 : 400,
            cursor: "pointer",
          }}
        >
          My Connections ({connections.length})
        </button>
        <button
          onClick={() => setTab("requests")}
          style={{
            padding: "8px 16px",
            background: "none",
            border: "none",
            borderBottom: tab === "requests" ? `2px solid ${colors.blue}` : "2px solid transparent",
            color: tab === "requests" ? colors.text : colors.overlay0,
            fontSize: 13,
            fontWeight: tab === "requests" ? 600 : 400,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          Requests
          {pendingRequests.length > 0 && (
            <span style={{
              background: colors.red,
              color: colors.base,
              fontSize: 10,
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: 10,
            }}>
              {pendingRequests.length}
            </span>
          )}
        </button>
      </div>

      {loading && (
        <div style={{ color: colors.overlay0, fontSize: 13, textAlign: "center", padding: 40 }}>Loading...</div>
      )}

      {/* Connections Tab */}
      {!loading && tab === "connections" && (
        connections.length === 0 ? (
          <div style={{ color: colors.overlay0, fontSize: 13, textAlign: "center", padding: 40 }}>
            No connections yet. Use the Topology view to connect agents.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {connections.map((agent) => (
              <div
                key={agent.id}
                style={{
                  background: colors.base,
                  border: `1px solid ${colors.surface0}`,
                  borderRadius: 8,
                  padding: "12px 14px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: statusColor[agent.status] || colors.overlay0,
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{agent.name}</div>
                  <div style={{ fontSize: 11, color: colors.overlay0 }}>{agent.id}</div>
                </div>
                <span style={{ fontSize: 11, color: statusColor[agent.status], fontWeight: 600 }}>
                  {agent.status}
                </span>
              </div>
            ))}
          </div>
        )
      )}

      {/* Requests Tab */}
      {!loading && tab === "requests" && (
        pendingRequests.length === 0 ? (
          <div style={{ color: colors.overlay0, fontSize: 13, textAlign: "center", padding: 40 }}>
            No pending connection requests
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pendingRequests.map((req) => (
              <div
                key={req.id}
                style={{
                  background: colors.base,
                  border: `1px solid ${colors.surface0}`,
                  borderRadius: 8,
                  padding: "14px 16px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{req.fromAgent}</span>
                  <span style={{ fontSize: 11, color: colors.overlay0 }}>{timeAgo(req.createdAt)}</span>
                </div>
                {req.message && (
                  <div style={{ fontSize: 12, color: colors.subtext0, marginBottom: 10, lineHeight: 1.4 }}>
                    "{req.message}"
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => handleAccept(req.id)}
                    style={{
                      padding: "6px 16px",
                      background: colors.green,
                      color: colors.base,
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleDecline(req.id)}
                    style={{
                      padding: "6px 16px",
                      background: colors.surface0,
                      color: colors.text,
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
