import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StageDef } from "@zyra/core";
import { portsCompatible } from "@zyra/core";
import { ManifestProvider, useManifest } from "./ManifestLoader";
import { NodePalette } from "./NodePalette";
import { ZyraNode, type ZyraNodeData } from "./ZyraNode";
import { ArgPanel } from "./ArgPanel";

let nodeIdCounter = 0;
function nextId() {
  return `node-${++nodeIdCounter}`;
}

function Editor() {
  const manifest = useManifest();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const nodeTypes = useMemo(() => ({ zyra: ZyraNode }), []);

  // Build a lookup from stage/command → StageDef for connection validation
  const stageMap = useMemo(() => {
    const m = new Map<string, StageDef>();
    for (const s of manifest.stages) m.set(`${s.stage}/${s.command}`, s);
    return m;
  }, [manifest]);

  const handleAddNode = useCallback(
    (stageDef: StageDef) => {
      const id = nextId();
      const newNode: Node = {
        id,
        type: "zyra",
        position: { x: 280 + Math.random() * 200, y: 80 + Math.random() * 300 },
        data: {
          stageDef,
          argValues: {},
        } satisfies ZyraNodeData,
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (!connection.source || !connection.target) return false;
      const srcNode = nodes.find((n) => n.id === connection.source);
      const tgtNode = nodes.find((n) => n.id === connection.target);
      if (!srcNode || !tgtNode) return false;

      const srcDef = (srcNode.data as ZyraNodeData).stageDef;
      const tgtDef = (tgtNode.data as ZyraNodeData).stageDef;
      const srcPort = srcDef.outputs.find((p) => p.id === connection.sourceHandle);
      const tgtPort = tgtDef.inputs.find((p) => p.id === connection.targetHandle);
      if (!srcPort || !tgtPort) return false;

      return portsCompatible(srcPort, tgtPort);
    },
    [nodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            style: { stroke: "#58a6ff", strokeWidth: 2 },
            animated: true,
          },
          eds,
        ),
      );
    },
    [setEdges],
  );

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const handleArgChange = useCallback(
    (nodeId: string, key: string, value: string | number | boolean) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n;
          const data = n.data as ZyraNodeData;
          return {
            ...n,
            data: {
              ...data,
              argValues: { ...data.argValues, [key]: value },
            },
          };
        }),
      );
    },
    [setNodes],
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#0d1117" }}>
      <NodePalette onAddNode={handleAddNode} />

      <div style={{ marginLeft: 220, marginRight: selectedNode ? 300 : 0, height: "100%" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
          onPaneClick={() => setSelectedNodeId(null)}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          style={{ background: "#0d1117" }}
        >
          <Background variant={BackgroundVariant.Dots} color="#333" gap={20} size={1} />
          <Controls
            style={{ background: "#1a1a2e", borderColor: "#444" }}
          />
        </ReactFlow>
      </div>

      {selectedNode && (
        <ArgPanel
          nodeId={selectedNode.id}
          data={selectedNode.data as ZyraNodeData}
          onArgChange={handleArgChange}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  );
}

export function App() {
  return (
    <ManifestProvider>
      <Editor />
    </ManifestProvider>
  );
}
