import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type Connection,
  addEdge as rfAddEdge,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { AgentNode } from "../AgentNode";
import { AgentPanel } from "../AgentPanel";
import { CreateAgentDialog } from "../CreateAgentDialog";
import { fetchTopology, addEdge, removeEdge, type AgentInfo } from "../api";
import { colors, fonts } from "../theme";

const nodeTypes = { agent: AgentNode };

function topologyToFlow(
  agents: Record<string, AgentInfo>,
  topoEdges: [string, string][],
  selectedId: string | null,
  onSelect: (id: string) => void
) {
  const ids = Object.keys(agents);
  const cols = Math.ceil(Math.sqrt(ids.length));

  const nodes: Node[] = ids.map((id, i) => ({
    id,
    type: "agent",
    position: {
      x: (i % cols) * 250 + 50,
      y: Math.floor(i / cols) * 180 + 50,
    },
    data: { agent: agents[id], selected: id === selectedId, onSelect },
  }));

  const edges: Edge[] = topoEdges.map(([a, b]) => ({
    id: `${a}-${b}`,
    source: a,
    target: b,
    style: { stroke: colors.overlay0, strokeWidth: 2 },
    animated: agents[a]?.status !== "offline" && agents[b]?.status !== "offline",
  }));

  return { nodes, edges };
}

export function AdminPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [allAgents, setAllAgents] = useState<Record<string, AgentInfo>>({});
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const loadTopology = useCallback(async () => {
    try {
      const topo = await fetchTopology();
      setAllAgents(topo.nodes);
      const flow = topologyToFlow(topo.nodes, topo.edges, selectedAgent, setSelectedAgent);
      setNodes((prev) => {
        const posMap = new Map(prev.map((n) => [n.id, n.position]));
        return flow.nodes.map((n) => ({
          ...n,
          position: posMap.get(n.id) || n.position,
        }));
      });
      setEdges(flow.edges);
    } catch { /* auth dialog handles 401 */ }
  }, [setNodes, setEdges, selectedAgent]);

  useEffect(() => {
    loadTopology();
    const interval = setInterval(loadTopology, 3000);
    return () => clearInterval(interval);
  }, [loadTopology]);

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (connection.source && connection.target) {
        await addEdge(connection.source, connection.target);
        setEdges((eds) =>
          rfAddEdge(
            { ...connection, style: { stroke: colors.overlay0, strokeWidth: 2 }, animated: true },
            eds
          )
        );
      }
    },
    [setEdges]
  );

  const onEdgeDoubleClick = useCallback(
    async (_: React.MouseEvent, edge: Edge) => {
      await removeEdge(edge.source, edge.target);
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [setEdges]
  );

  const selected = selectedAgent ? allAgents[selectedAgent] : null;

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", background: colors.crust }}>
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 10,
          color: colors.text,
          fontFamily: fonts.body,
          fontSize: 13,
          background: colors.mantle,
          padding: "8px 14px",
          borderRadius: 8,
          border: `1px solid ${colors.surface0}`,
        }}
      >
        <strong>Swarm Topology</strong>
        <span style={{ color: colors.overlay0, marginLeft: 12 }}>
          {Object.values(allAgents).filter((a) => a.status !== "offline").length} online
          {" / "}
          {Object.keys(allAgents).length} total
        </span>
        <span style={{ color: colors.overlay0, marginLeft: 12, fontSize: 11 }}>
          Drag between nodes to connect — Double-click edge to disconnect
        </span>
        <button
          onClick={() => setShowCreateDialog(true)}
          style={{
            marginLeft: 12,
            padding: "4px 12px",
            background: colors.green,
            color: colors.base,
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: "bold",
          }}
        >
          + Add Agent
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeDoubleClick={onEdgeDoubleClick}
        nodeTypes={nodeTypes}
        fitView
        style={{ background: colors.crust }}
      >
        <Background color={colors.surface0} gap={20} />
        <Controls
          style={{ background: colors.mantle, border: `1px solid ${colors.surface0}`, borderRadius: 8 }}
        />
      </ReactFlow>
      {selected && (
        <AgentPanel
          key={selectedAgent}
          agent={selected}
          onClose={() => setSelectedAgent(null)}
          onUpdate={loadTopology}
          onSelectAgent={setSelectedAgent}
        />
      )}
      {showCreateDialog && (
        <CreateAgentDialog
          existingIds={Object.keys(allAgents)}
          onClose={() => setShowCreateDialog(false)}
          onCreated={loadTopology}
        />
      )}
    </div>
  );
}
