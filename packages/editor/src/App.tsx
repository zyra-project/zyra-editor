import { useCallback, useMemo, useState } from "react";
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
import type { StageDef, Graph, GraphNode, GraphEdge } from "@zyra/core";
import { portsCompatible } from "@zyra/core";
import { ManifestProvider, useManifest } from "./ManifestLoader";
import { NodePalette } from "./NodePalette";
import { ZyraNode, type ZyraNodeData } from "./ZyraNode";
import { ArgPanel } from "./ArgPanel";
import { Toolbar } from "./Toolbar";
import { LogPanel } from "./LogPanel";
import { useExecution } from "./useExecution";

let nodeIdCounter = 0;
function nextId() {
  return `node-${++nodeIdCounter}`;
}

/** Convert React Flow state to @zyra/core Graph for serialization. */
function toGraph(nodes: Node[], edges: Edge[]): Graph {
  const graphNodes: GraphNode[] = nodes.map((n) => {
    const d = n.data as ZyraNodeData;
    return {
      id: n.id,
      stageCommand: `${d.stageDef.stage}/${d.stageDef.command}`,
      argValues: { ...d.argValues },
    };
  });
  const graphEdges: GraphEdge[] = edges
    .filter((e) => e.source && e.target)
    .map((e) => ({
      sourceNode: e.source,
      sourcePort: e.sourceHandle ?? "",
      targetNode: e.target,
      targetPort: e.targetHandle ?? "",
    }));
  return { nodes: graphNodes, edges: graphEdges };
}

function Editor() {
  const manifest = useManifest();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const exec = useExecution();

  const nodeTypes = useMemo(() => ({ zyra: ZyraNode }), []);

  // Inject run status into node data so ZyraNode can render badges
  const nodesWithStatus = useMemo(() => {
    if (exec.runState.size === 0) return nodes;
    return nodes.map((n) => {
      const rs = exec.runState.get(n.id);
      if (!rs) return n;
      const d = n.data as ZyraNodeData;
      return {
        ...n,
        data: {
          ...d,
          runStatus: rs.status,
          dryRunArgv: rs.dryRunArgv,
        },
      };
    });
  }, [nodes, exec.runState]);

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

  const handleDryRun = useCallback(() => {
    const graph = toGraph(nodes, edges);
    exec.dryRun(graph, manifest.stages);
  }, [nodes, edges, manifest.stages, exec.dryRun]);

  const handleRun = useCallback(() => {
    const graph = toGraph(nodes, edges);
    exec.runPipeline(graph, manifest.stages);
  }, [nodes, edges, manifest.stages, exec.runPipeline]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#0d1117",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Toolbar
        onDryRun={handleDryRun}
        onRun={handleRun}
        onCancel={exec.cancelAll}
        onReset={exec.reset}
        running={exec.running}
        nodeCount={nodes.length}
        runState={exec.runState}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <NodePalette onAddNode={handleAddNode} />

        <div style={{ flex: 1, position: "relative" }}>
          <ReactFlow
            nodes={nodesWithStatus}
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
            <Controls style={{ background: "#1a1a2e", borderColor: "#444" }} />
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

      <LogPanel runState={exec.runState} selectedNodeId={selectedNodeId} />

      {/* Pulse animation for running status indicator */}
      <style>{`
        @keyframes zyra-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
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
