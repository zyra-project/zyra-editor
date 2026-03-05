import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Node,
  type Edge,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StageDef, Graph, GraphNode, GraphEdge, Pipeline } from "@zyra/core";
import { portsCompatible, graphToPipeline, pipelineToGraph } from "@zyra/core";
import { ManifestProvider, useManifest } from "./ManifestLoader";
import { NodePalette } from "./NodePalette";
import { ZyraNode, type ZyraNodeData } from "./ZyraNode";
import { ArgPanel } from "./ArgPanel";
import { Toolbar } from "./Toolbar";
import { LogPanel } from "./LogPanel";
import { useExecution } from "./useExecution";
import { YamlPanel } from "./YamlPanel";

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
      label: d.nodeLabel || undefined,
      stageCommand: `${d.stageDef.stage}/${d.stageDef.command}`,
      argValues: { ...d.argValues },
      position: { x: n.position.x, y: n.position.y },
      size: n.measured?.width && n.measured?.height
        ? { w: n.measured.width, h: n.measured.height }
        : n.width && n.height
          ? { w: n.width, h: n.height }
          : undefined,
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

/** Fallback StageDef for commands not found in the manifest. */
function placeholderStage(stageCommand: string): StageDef {
  const [stage, command] = stageCommand.includes("/")
    ? stageCommand.split("/", 2)
    : [stageCommand, stageCommand];
  return {
    stage,
    command,
    label: stageCommand,
    cli: stageCommand,
    status: "planned",
    color: "#6e7681",
    inputs: [{ id: "in", label: "input", types: ["any"] }],
    outputs: [{ id: "out", label: "output", types: ["any"] }],
    args: [],
  };
}

/**
 * Compute a left-to-right layout based on dependency depth.
 * Nodes at the same depth are stacked vertically.
 */
function computeAutoLayout(graph: Graph): Map<string, { x: number; y: number }> {
  const NODE_W = 260;
  const NODE_H = 180;
  const PADDING_X = 80;
  const PADDING_Y = 40;

  // Build adjacency: parent → children
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const n of graph.nodes) {
    children.set(n.id, []);
    parents.set(n.id, []);
  }
  for (const e of graph.edges) {
    children.get(e.sourceNode)?.push(e.targetNode);
    parents.get(e.targetNode)?.push(e.sourceNode);
  }

  // Compute depth (longest path from a root)
  const depth = new Map<string, number>();
  function getDepth(id: string, visited: Set<string>): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);
    const pars = parents.get(id) ?? [];
    const d = pars.length === 0 ? 0 : Math.max(...pars.map((p) => getDepth(p, visited))) + 1;
    depth.set(id, d);
    return d;
  }
  for (const n of graph.nodes) getDepth(n.id, new Set());

  // Group by depth
  const columns = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(n.id);
  }

  // Assign positions
  const positions = new Map<string, { x: number; y: number }>();
  for (const [col, ids] of columns) {
    const x = PADDING_X + col * (NODE_W + PADDING_X);
    const totalHeight = ids.length * NODE_H + (ids.length - 1) * PADDING_Y;
    const startY = Math.max(PADDING_Y, (600 - totalHeight) / 2);
    ids.forEach((id, row) => {
      positions.set(id, { x, y: startY + row * (NODE_H + PADDING_Y) });
    });
  }

  return positions;
}

function Editor() {
  const manifest = useManifest();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const exec = useExecution();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const nodeTypes = useMemo(() => ({ zyra: ZyraNode }), []);

  // Stable ref for the per-node run callback so memo doesn't churn
  const runNodeRef = useRef<(nodeId: string) => void>(() => {});

  // Inject run status + run callback into node data so ZyraNode can render badges / play button
  const nodesWithStatus = useMemo(() => {
    const onRunNode = (nodeId: string) => runNodeRef.current(nodeId);
    return nodes.map((n) => {
      const rs = exec.runState.get(n.id);
      const d = n.data as ZyraNodeData;
      return {
        ...n,
        data: {
          ...d,
          runStatus: rs?.status,
          dryRunArgv: rs?.dryRunArgv,
          onRunNode,
        },
      };
    });
  }, [nodes, exec.runState]);

  // Compute pipeline from current canvas state (for YAML panel)
  const pipeline = useMemo<Pipeline>(() => {
    try {
      return graphToPipeline(toGraph(nodes, edges), manifest.stages);
    } catch {
      return { version: "1", steps: [] };
    }
  }, [nodes, edges, manifest.stages]);

  // YAML → canvas: rebuild React Flow nodes/edges from a parsed Pipeline
  const handlePipelineChange = useCallback(
    (newPipeline: Pipeline) => {
      const graph = pipelineToGraph(newPipeline, manifest.stages);
      const stageMap = new Map(
        manifest.stages.map((s) => [`${s.stage}/${s.command}`, s]),
      );

      // Check if any nodes have saved positions
      const hasLayout = graph.nodes.some((gn) => gn.position);

      // Compute auto-layout positions when no _layout metadata exists
      const autoPositions = hasLayout
        ? new Map<string, { x: number; y: number }>()
        : computeAutoLayout(graph);

      const newNodes: Node[] = graph.nodes.map((gn) => {
        const stageDef = stageMap.get(gn.stageCommand);
        const existing = nodes.find((n) => n.id === gn.id);
        const pos =
          gn.position ??
          existing?.position ??
          autoPositions.get(gn.id) ??
          { x: 350, y: 80 };
        const node: Node = {
          id: gn.id,
          type: "zyra",
          position: pos,
          data: {
            stageDef: stageDef ?? placeholderStage(gn.stageCommand),
            argValues: { ...gn.argValues },
            nodeLabel: gn.label || undefined,
          } satisfies ZyraNodeData,
        };
        if (gn.size) {
          node.width = gn.size.w;
          node.height = gn.size.h;
          node.style = { width: gn.size.w, height: gn.size.h };
        }
        return node;
      });

      const newEdges: Edge[] = graph.edges.map((ge, i) => ({
        id: `e-yaml-${i}`,
        source: ge.sourceNode,
        sourceHandle: ge.sourcePort,
        target: ge.targetNode,
        targetHandle: ge.targetPort,
        style: { stroke: "#58a6ff", strokeWidth: 2 },
        animated: true,
      }));

      // Update the counter so new nodes don't collide
      const maxNum = graph.nodes.reduce((max, n) => {
        const m = n.id.match(/^node-(\d+)$/);
        return m ? Math.max(max, Number(m[1])) : max;
      }, nodeIdCounter);
      nodeIdCounter = maxNum;

      setNodes(newNodes);
      setEdges(newEdges);
    },
    [manifest.stages, nodes, setNodes, setEdges],
  );

  const handleAddNode = useCallback(
    (stageDef: StageDef, position?: { x: number; y: number }) => {
      const id = nextId();
      const newNode: Node = {
        id,
        type: "zyra",
        position: position ?? { x: 280 + Math.random() * 200, y: 80 + Math.random() * 300 },
        data: {
          stageDef,
          argValues: {},
        } satisfies ZyraNodeData,
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const json = e.dataTransfer.getData("application/zyra-stage");
      if (!json) return;
      const stageDef: StageDef = JSON.parse(json);
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      handleAddNode(stageDef, position);
    },
    [screenToFlowPosition, handleAddNode],
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

  const handleRunNode = useCallback(
    async (nodeId: string) => {
      const graph = toGraph(nodes, edges);
      const err = await exec.runSingleNode(nodeId, graph, manifest.stages);
      if (err) {
        alert(err);
      } else {
        setSelectedNodeId(nodeId);
      }
    },
    [nodes, edges, manifest.stages, exec.runSingleNode],
  );
  runNodeRef.current = handleRunNode;

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
        yamlOpen={yamlOpen}
        onToggleYaml={() => setYamlOpen((v) => !v)}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <NodePalette onAddNode={handleAddNode} />

        <div ref={reactFlowWrapper} style={{ flex: 1, position: "relative" }}>
          <ReactFlow
            nodes={nodesWithStatus}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={handleNodeClick}
            onPaneClick={() => setSelectedNodeId(null)}
            onDragOver={onDragOver}
            onDrop={onDrop}
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

        {yamlOpen && (
          <YamlPanel
            pipeline={pipeline}
            onPipelineChange={handlePipelineChange}
            onClose={() => setYamlOpen(false)}
          />
        )}
      </div>

      <LogPanel runState={exec.runState} selectedNodeId={selectedNodeId} onClearNode={exec.clearNode} />

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
      <ReactFlowProvider>
        <Editor />
      </ReactFlowProvider>
    </ManifestProvider>
  );
}
