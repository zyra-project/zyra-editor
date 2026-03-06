import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type NodeChange,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StageDef, Graph, GraphNode, GraphEdge, Pipeline, NodeRunStatus } from "@zyra/core";
import { portsCompatible, graphToPipeline, pipelineToGraph } from "@zyra/core";
import { ManifestProvider, useManifest } from "./ManifestLoader";
import { NodePalette } from "./NodePalette";
import { ZyraNode, type ZyraNodeData } from "./ZyraNode";
import { GroupBoxNode, type GroupBoxData } from "./GroupBoxNode";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { Toolbar } from "./Toolbar";
import { LogPanel } from "./LogPanel";
import { useExecution } from "./useExecution";
import { YamlPanel } from "./YamlPanel";
import { useTheme } from "./useTheme";

let nodeIdCounter = 0;
function nextId() {
  return `node-${++nodeIdCounter}`;
}
let groupIdCounter = 0;
function nextGroupId() {
  return `group-${++groupIdCounter}`;
}

/** Find the group box that contains the given absolute point. */
function findContainingGroup(
  point: { x: number; y: number },
  nodes: Node[],
  excludeNodeId?: string,
): string | null {
  for (const n of nodes) {
    if (n.type !== "group" || n.id === excludeNodeId) continue;
    const w = n.measured?.width ?? (typeof n.style?.width === "number" ? n.style.width : 400);
    const h = n.measured?.height ?? (typeof n.style?.height === "number" ? n.style.height : 260);
    if (
      point.x >= n.position.x &&
      point.x <= n.position.x + w &&
      point.y >= n.position.y &&
      point.y <= n.position.y + h
    ) {
      return n.id;
    }
  }
  return null;
}

/** Ensure parent nodes appear before their children in the array (React Flow requirement). */
function ensureParentOrder(nodes: Node[]): Node[] {
  const parentIds = new Set(nodes.filter((n) => n.parentId).map((n) => n.parentId!));
  const parents = nodes.filter((n) => parentIds.has(n.id));
  const rest = nodes.filter((n) => !parentIds.has(n.id));
  return [...parents, ...rest];
}

/** Convert React Flow state to @zyra/core Graph for serialization.
 *  Group box nodes are filtered out — they're visual-only. */
function toGraph(nodes: Node[], edges: Edge[]): Graph {
  const graphNodes: GraphNode[] = nodes.filter((n) => n.type !== "group").map((n) => {
    const d = n.data as ZyraNodeData;
    // Convert relative position to absolute if node has a parent
    let pos = { x: n.position.x, y: n.position.y };
    if (n.parentId) {
      const parent = nodes.find((p) => p.id === n.parentId);
      if (parent) {
        pos = { x: parent.position.x + n.position.x, y: parent.position.y + n.position.y };
      }
    }
    return {
      id: n.id,
      label: d.nodeLabel || undefined,
      stageCommand: `${d.stageDef.stage}/${d.stageDef.command}`,
      argValues: { ...d.argValues },
      position: pos,
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
 */
function computeAutoLayout(graph: Graph): Map<string, { x: number; y: number }> {
  const NODE_W = 260;
  const NODE_H = 180;
  const PADDING_X = 80;
  const PADDING_Y = 40;

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

  const depth = new Map<string, number>();
  function getDepth(id: string, visited: Set<string>): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);
    const pars = parents.get(id) ?? [];
    const d = pars.length === 0 ? 0 : Math.max(...pars.map((p) => getDepth(p, visited))) + 1;
    depth.set(id, d);
    return d;
  }
  for (const n of graph.nodes) getDepth(n.id, new Set());

  const columns = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(n.id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const col of Array.from(columns.keys()).sort((a, b) => a - b)) {
    const ids = columns.get(col)!;
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
  const { theme, toggle: toggleTheme } = useTheme();
  const [nodes, setNodes, defaultOnNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const exec = useExecution();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, setCenter } = useReactFlow();

  const nodeTypes = useMemo(() => ({ zyra: ZyraNode, group: GroupBoxNode }), []);

  // Use a ref for lock checks to avoid recreating onNodesChange on every node update
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nds = nodesRef.current;

      // On group deletion, un-parent children first
      for (const change of changes) {
        if (change.type === "remove") {
          const node = nds.find((n) => n.id === change.id);
          if (node?.type === "group") {
            setNodes((prev) =>
              prev.map((n) => {
                if (n.parentId !== change.id) return n;
                const parent = prev.find((p) => p.id === change.id);
                return {
                  ...n,
                  parentId: undefined,
                  expandParent: undefined,
                  position: parent
                    ? { x: parent.position.x + n.position.x, y: parent.position.y + n.position.y }
                    : n.position,
                };
              }),
            );
          }
        }
      }

      // Filter out position changes for locked groups and their children
      const filtered = changes.filter((change) => {
        if (change.type !== "position" || !("id" in change)) return true;
        const node = nds.find((n) => n.id === change.id);
        if (!node) return true;

        // Locked group itself
        if (node.type === "group" && (node.data as GroupBoxData).locked) {
          return false;
        }
        // Child of a locked group
        if (node.parentId) {
          const parent = nds.find((n) => n.id === node.parentId);
          if (parent && (parent.data as GroupBoxData).locked) {
            return false;
          }
        }
        return true;
      });

      defaultOnNodesChange(filtered);
    },
    [defaultOnNodesChange, setNodes],
  );

  // Stable ref for the per-node run callback
  const runNodeRef = useRef<(nodeId: string) => void>(() => {});
  const onRunNode = useCallback((nodeId: string) => runNodeRef.current(nodeId), []);

  // Inject run status into node data (skip group nodes)
  const nodesWithStatus = useMemo(() => {
    return nodes.map((n) => {
      if (n.type === "group") return n;
      const rs = exec.runState.get(n.id);
      const d = n.data as ZyraNodeData;
      const newStatus = rs?.status;
      const newArgv = rs?.dryRunArgv;
      if (d.runStatus === newStatus && d.dryRunArgv === newArgv && d.onRunNode === onRunNode) {
        return n;
      }
      return {
        ...n,
        data: {
          ...d,
          runStatus: newStatus,
          dryRunArgv: newArgv,
          onRunNode,
        },
      };
    });
  }, [nodes, exec.runState, onRunNode]);

  // Pipeline from current canvas state
  const pipeline = useMemo<Pipeline>(() => {
    try {
      return graphToPipeline(toGraph(nodes, edges), manifest.stages);
    } catch {
      return { version: "1", steps: [] };
    }
  }, [nodes, edges, manifest.stages]);

  // YAML -> canvas
  const handlePipelineChange = useCallback(
    (newPipeline: Pipeline) => {
      const graph = pipelineToGraph(newPipeline, manifest.stages);
      const stageMap = new Map(
        manifest.stages.map((s) => [`${s.stage}/${s.command}`, s]),
      );

      const hasLayout = graph.nodes.some((gn) => gn.position);
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
            nodeLabel: gn.label && gn.label !== gn.id ? gn.label : undefined,
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
        type: "smoothstep",
        style: { stroke: "var(--accent-blue)", strokeWidth: 2 },
        animated: exec.running,
      }));

      const maxNum = graph.nodes.reduce((max, n) => {
        const m = n.id.match(/^node-(\d+)$/);
        return m ? Math.max(max, Number(m[1])) : max;
      }, nodeIdCounter);
      nodeIdCounter = maxNum;

      setNodes(newNodes);
      setEdges(newEdges);
    },
    [manifest.stages, nodes, setNodes, setEdges, exec.running],
  );

  const handleAddNode = useCallback(
    (stageDef: StageDef, position?: { x: number; y: number }, parentId?: string) => {
      const id = nextId();
      const newNode: Node = {
        id,
        type: "zyra",
        position: position ?? { x: 280 + Math.random() * 200, y: 80 + Math.random() * 300 },
        data: {
          stageDef,
          argValues: {},
        } satisfies ZyraNodeData,
        ...(parentId ? { parentId, expandParent: true } : {}),
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  const handleAddGroup = useCallback(() => {
    const id = nextGroupId();
    const newNode: Node = {
      id,
      type: "group",
      position: { x: 200 + Math.random() * 100, y: 80 + Math.random() * 100 },
      style: { width: 400, height: 260 },
      zIndex: -1,
      data: {
        label: "Group",
        color: "#3b82f6",
      } satisfies GroupBoxData,
    };
    setNodes((nds) => [newNode, ...nds]);
  }, [setNodes]);

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

      // Check if the drop lands inside a group box
      const groupId = findContainingGroup(position, nodes);
      if (groupId) {
        const group = nodes.find((n) => n.id === groupId)!;
        const relativePos = {
          x: position.x - group.position.x,
          y: position.y - group.position.y,
        };
        handleAddNode(stageDef, relativePos, groupId);
      } else {
        handleAddNode(stageDef, position);
      }
    },
    [screenToFlowPosition, handleAddNode, nodes],
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
            type: "smoothstep",
            style: { stroke: "var(--accent-blue)", strokeWidth: 2 },
            animated: exec.running,
          },
          eds,
        ),
      );
    },
    [setEdges, exec.running],
  );

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === "group") return;

      setNodes((nds) => {
        const currentNode = nds.find((n) => n.id === node.id);
        if (!currentNode) return nds;

        // Compute absolute position
        let absPos = { ...currentNode.position };
        if (currentNode.parentId) {
          const parent = nds.find((n) => n.id === currentNode.parentId);
          if (parent) {
            absPos = {
              x: parent.position.x + currentNode.position.x,
              y: parent.position.y + currentNode.position.y,
            };
          }
        }

        const newGroupId = findContainingGroup(absPos, nds, node.id);

        // No change needed
        if (newGroupId === (currentNode.parentId ?? null)) return nds;

        // Entering or switching to a group
        if (newGroupId) {
          const group = nds.find((n) => n.id === newGroupId)!;
          return ensureParentOrder(
            nds.map((n) =>
              n.id === node.id
                ? {
                    ...n,
                    parentId: newGroupId,
                    expandParent: true,
                    position: { x: absPos.x - group.position.x, y: absPos.y - group.position.y },
                  }
                : n,
            ),
          );
        }

        // Leaving all groups
        return ensureParentOrder(
          nds.map((n) =>
            n.id === node.id
              ? {
                  ...n,
                  parentId: undefined,
                  expandParent: undefined,
                  position: absPos,
                }
              : n,
          ),
        );
      });
    },
    [setNodes],
  );

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === "group") return; // groups don't open detail panel
    setSelectedNodeId(node.id);
  }, []);

  const handleSelectNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      const target = nodes.find((n) => n.id === nodeId);
      if (target) {
        const x = (target.position.x ?? 0) + ((target.measured?.width ?? 200) / 2);
        const y = (target.position.y ?? 0) + ((target.measured?.height ?? 100) / 2);
        setCenter(x, y, { zoom: 1, duration: 300 });
      }
    },
    [nodes, setCenter],
  );

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

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Escape: close detail panel / deselect
      if (e.key === "Escape") {
        if (yamlOpen) {
          setYamlOpen(false);
        } else if (selectedNodeId) {
          setSelectedNodeId(null);
        }
        return;
      }
      // Cmd/Ctrl+S: export YAML
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        setYamlOpen(true);
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedNodeId, yamlOpen]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  // Compute connected ports for the detail panel
  const connectedInputs = useMemo(() => {
    if (!selectedNodeId) return [];
    return edges
      .filter((e) => e.target === selectedNodeId)
      .map((e) => {
        const srcNode = nodes.find((n) => n.id === e.source);
        const srcData = srcNode?.data as ZyraNodeData | undefined;
        return {
          portId: e.targetHandle ?? "",
          peerNodeId: e.source,
          peerLabel: srcData?.nodeLabel || srcData?.stageDef.label || e.source,
          peerStatus: exec.runState.get(e.source)?.status as NodeRunStatus | undefined,
        };
      });
  }, [selectedNodeId, edges, nodes, exec.runState]);

  const connectedOutputs = useMemo(() => {
    if (!selectedNodeId) return [];
    return edges
      .filter((e) => e.source === selectedNodeId)
      .map((e) => {
        const tgtNode = nodes.find((n) => n.id === e.target);
        const tgtData = tgtNode?.data as ZyraNodeData | undefined;
        return {
          portId: e.sourceHandle ?? "",
          peerNodeId: e.target,
          peerLabel: tgtData?.nodeLabel || tgtData?.stageDef.label || e.target,
          peerStatus: exec.runState.get(e.target)?.status as NodeRunStatus | undefined,
        };
      });
  }, [selectedNodeId, edges, nodes, exec.runState]);

  return (
    <div className="zyra-editor">
      <Toolbar
        onDryRun={handleDryRun}
        onRun={handleRun}
        onCancel={exec.cancelAll}
        onReset={exec.reset}
        running={exec.running}
        nodeCount={nodes.filter((n) => n.type !== "group").length}
        runState={exec.runState}
        yamlOpen={yamlOpen}
        onToggleYaml={() => setYamlOpen((v) => !v)}
        onAddGroup={handleAddGroup}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <NodePalette
        onAddNode={handleAddNode}
        collapsed={paletteCollapsed}
        onToggleCollapse={() => setPaletteCollapsed((v) => !v)}
      />

      <div className="zyra-canvas" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodesWithStatus}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={handleNodeClick}
          onPaneClick={() => setSelectedNodeId(null)}
          onDragOver={onDragOver}
          onDrop={onDrop}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          fitView
          panOnDrag
          selectionOnDrag={false}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: "smoothstep",
            style: { stroke: "var(--accent-blue)", strokeWidth: 2 },
            animated: false,
          }}
          style={{ width: "100%", height: "100%" }}
        >
          <Background variant={BackgroundVariant.Dots} color="var(--canvas-dot)" gap={20} size={1} />
          <Controls />
        </ReactFlow>
      </div>

      {selectedNode && (
        <NodeDetailPanel
          nodeId={selectedNode.id}
          data={selectedNode.data as ZyraNodeData}
          runState={exec.runState.get(selectedNode.id)}
          connectedInputs={connectedInputs}
          connectedOutputs={connectedOutputs}
          onArgChange={handleArgChange}
          onSelectNode={handleSelectNode}
          onClose={() => setSelectedNodeId(null)}
        />
      )}

      <LogPanel
        runState={exec.runState}
        selectedNodeId={selectedNodeId}
        onClearNode={exec.clearNode}
        onSelectNode={handleSelectNode}
      />

      {/* YAML Drawer Overlay */}
      {yamlOpen && (
        <>
          <div
            className="zyra-drawer-backdrop"
            onClick={() => setYamlOpen(false)}
          />
          <div className="zyra-drawer">
            <YamlPanel
              pipeline={pipeline}
              onPipelineChange={handlePipelineChange}
              onClose={() => setYamlOpen(false)}
            />
          </div>
        </>
      )}
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
