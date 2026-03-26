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

import { AgentNode } from "./AgentNode";
import { AgentPanel } from "./AgentPanel";
import { fetchTopology, addEdge, removeEdge, type AgentInfo } from "./api";

const nodeTypes = { agent: AgentNode };

function topologyToFlow(
  agents: Record<string, AgentInfo>,
  topoEdges: [string, string][],
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
    data: { agent: agents[id], onSelect },
  }));

  const edges: Edge[] = topoEdges.map(([a, b]) => ({
    id: `${a}-${b}`,
    source: a,
    target: b,
    style: { stroke: "#585b70", strokeWidth: 2 },
    animated: agents[a]?.status !== "offline" && agents[b]?.status !== "offline",
  }));

  return { nodes, edges };
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [allAgents, setAllAgents] = useState<Record<string, AgentInfo>>({});
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const loadTopology = useCallback(async () => {
    const topo = await fetchTopology();
    setAllAgents(topo.nodes);
    const flow = topologyToFlow(topo.nodes, topo.edges, setSelectedAgent);
    setNodes((prev) => {
      const posMap = new Map(prev.map((n) => [n.id, n.position]));
      return flow.nodes.map((n) => ({
        ...n,
        position: posMap.get(n.id) || n.position,
      }));
    });
    setEdges(flow.edges);
  }, [setNodes, setEdges]);

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
            { ...connection, style: { stroke: "#585b70", strokeWidth: 2 }, animated: true },
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
    <div style={{ width: "100vw", height: "100vh", background: "#11111b" }}>
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 10,
          color: "#cdd6f4",
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          background: "#181825",
          padding: "8px 14px",
          borderRadius: 8,
          border: "1px solid #313244",
        }}
      >
        <strong>Swarm Topology</strong>
        <span style={{ color: "#585b70", marginLeft: 12 }}>
          {Object.values(allAgents).filter((a) => a.status !== "offline").length} online
          {" / "}
          {Object.keys(allAgents).length} total
        </span>
        <span style={{ color: "#585b70", marginLeft: 12, fontSize: 11 }}>
          Drag between nodes to connect — Double-click edge to disconnect
        </span>
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
        style={{ background: "#11111b" }}
      >
        <Background color="#313244" gap={20} />
        <Controls
          style={{ background: "#181825", border: "1px solid #313244", borderRadius: 8 }}
        />
      </ReactFlow>
      {selected && (
        <AgentPanel
          agent={selected}
          onClose={() => setSelectedAgent(null)}
          onUpdate={loadTopology}
          onSelectAgent={setSelectedAgent}
        />
      )}
    </div>
  );
}
