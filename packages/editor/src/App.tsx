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
import type { StageDef, ArgDef, PortDef, Graph, GraphNode, GraphEdge, Pipeline, PipelineStep, PipelineGroup, NodeRunStatus } from "@zyra/core";
import { portsCompatible, getEffectivePorts, graphToPipeline, pipelineToGraph, resolvePeriodISO, validateArgs } from "@zyra/core";
import { ManifestProvider, useManifest } from "./ManifestLoader";
import { NodePalette } from "./NodePalette";
import { ZyraNode, type ZyraNodeData } from "./ZyraNode";
import { GroupBoxNode, type GroupBoxData } from "./GroupBoxNode";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { Toolbar } from "./Toolbar";
import { LogPanel } from "./LogPanel";
import { useExecution } from "./useExecution";
import { YamlPanel, normalizePipeline } from "./YamlPanel";
import { parseOptions } from "./ChoiceOptionsEditor";
import { PlannerPanel, type PlanHistoryEntry, type PlanBatch } from "./PlannerPanel";
import { RunHistoryPanel } from "./RunHistoryPanel";
import yaml from "js-yaml";
import { useTheme } from "./useTheme";
import { useBackendStatus } from "./useBackendStatus";

/** Control-flow commands that can wire to non-arg input ports. */
const CONTROL_FLOW_COMMANDS = new Set(["delay", "cron", "conditional", "loop"]);

/**
 * Derive a display value string for a control node's output port.
 * Handles all control node types including control-flow nodes (delay, cron,
 * conditional, loop) whose output port IDs don't map to arg keys.
 */
function resolveControlDisplayValue(
  srcData: ZyraNodeData,
  sourceHandle: string | null | undefined,
): string | null {
  const args = srcData.argValues ?? {};
  const cmd = srcData.stageDef.command;
  const portKey = sourceHandle ?? "value";

  // Control-flow nodes: derive display from args, not port-to-arg mapping
  if (cmd === "delay") {
    const d = args.duration;
    const u = args.unit ?? "seconds";
    return d != null ? `${d} ${u}` : null;
  }
  if (cmd === "cron") {
    const expr = args.expression;
    return expr != null && expr !== "" ? String(expr) : null;
  }
  if (cmd === "conditional") {
    const f = args.field ?? "";
    const op = args.operator ?? "";
    const v = args.compare_value ?? "";
    const branch = portKey === "true" ? "true" : portKey === "false" ? "false" : "";
    const summary = f || op || v ? `${f} ${op} ${v}`.trim() : null;
    return branch && summary ? `${summary} → ${branch}` : summary;
  }
  if (cmd === "loop") {
    const mode = args.mode ?? "";
    if (portKey === "index") return "index";
    if (portKey === "done") return "done";
    return mode ? `${mode}` : null;
  }
  if (cmd === "extract") {
    const expr = args.expression;
    return expr != null && expr !== "" ? `$.${expr}` : null;
  }

  // Data-value control nodes: resolve from matching arg key
  let val = portKey !== "value" && args[portKey] !== undefined
    ? args[portKey]
    : args.value;

  // Date "period" port: resolve enum → ISO 8601
  if (cmd === "date" && portKey === "period") {
    const iso = resolvePeriodISO(val, args.custom_period);
    if (iso !== undefined) {
      val = iso;
    } else if (val === "custom" && !args.custom_period) {
      return null;  // Treat missing custom_period as unset
    }
  }

  if (val !== undefined && val !== "") {
    let result = String(val);
    // Choice "label" port: resolve the label of the selected option
    if (cmd === "choice" && sourceHandle === "label") {
      try {
        const opts = parseOptions(typeof args.options === "string" ? args.options : "");
        const sel = opts.find((o) => o.value === String(args.value ?? ""));
        if (sel) result = sel.label;
      } catch { /* keep result as-is */ }
    }
    return result;
  }

  // Fall back to arg default/placeholder
  const argKey = portKey !== "value" ? portKey : "value";
  const valueDef = srcData.stageDef.args.find((a: ArgDef) => a.key === argKey)
    ?? srcData.stageDef.args.find((a: ArgDef) => a.key === "value");
  const fallback = valueDef?.default ?? valueDef?.placeholder;
  if (fallback != null && fallback !== "") return String(fallback);

  return null;
}

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
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [useCache, setUseCache] = useState(true);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [plannerIntent, setPlannerIntent] = useState("");
  const [plannerHistory, setPlannerHistory] = useState<PlanHistoryEntry[]>([]);
  const [planBatches, setPlanBatches] = useState<PlanBatch[]>([]);
  const backendStatus = useBackendStatus();
  // Ref for stable graph snapshot callback (nodesRef is declared further down for lock checks)
  const graphNodesRef = useRef(nodes);
  graphNodesRef.current = nodes;
  const graphEdgesRef = useRef(edges);
  graphEdgesRef.current = edges;
  const getGraphSnapshot = useCallback(() => ({
    nodes: graphNodesRef.current,
    edges: graphEdgesRef.current,
  }), []);
  const exec = useExecution(getGraphSnapshot, useCache);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (prevRunningRef.current && !exec.running) {
      setHistoryRefreshKey((k) => k + 1);
    }
    prevRunningRef.current = exec.running;
  }, [exec.running]);
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

      // Filter out position and dimension changes for locked groups and their children
      const filtered = changes.filter((change) => {
        if ((change.type !== "position" && change.type !== "dimensions") || !("id" in change)) return true;
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

  // Build per-node connected port maps from edges
  // connectedInputMap: nodeId → Map<portId, displayValue>
  // connectedOutputMap: nodeId → Set<portId>
  const { connectedInputMap, connectedOutputMap } = useMemo(() => {
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const inMap = new Map<string, Map<string, string>>();
    const outMap = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!inMap.has(e.target)) inMap.set(e.target, new Map());
      if (e.targetHandle) {
        // Look up the source node to extract a display value
        const srcNode = nodeById.get(e.source);
        const srcData = srcNode?.data as ZyraNodeData | undefined;
        let displayValue = srcData?.nodeLabel || srcData?.stageDef.label || "";
        // For control nodes, show the actual explicitly set value or default;
        // otherwise mark as unset so the UI doesn't imply a value will be inlined
        if (srcData?.stageDef.stage === "control") {
          const resolved = resolveControlDisplayValue(srcData, e.sourceHandle);
          displayValue = resolved ?? "(unset)";
        } else if (e.sourceHandle?.startsWith("argout:")) {
          // Arg-to-arg wire: show source node label + arg value
          const argKey = e.sourceHandle.slice(7);
          const val = srcData?.argValues[argKey];
          const nodeLabel = srcData?.nodeLabel || srcData?.stageDef.label || "";
          displayValue = val !== undefined && val !== ""
            ? `${nodeLabel}: ${String(val)}`
            : `${nodeLabel}: (unset)`;
        }
        inMap.get(e.target)!.set(e.targetHandle, displayValue);
      }
      if (!outMap.has(e.source)) outMap.set(e.source, new Set());
      if (e.sourceHandle) outMap.get(e.source)!.add(e.sourceHandle);
    }
    return { connectedInputMap: inMap, connectedOutputMap: outMap };
  }, [edges, nodes]);

  // Inject run status + connected port sets into node data (skip group nodes)
  const nodesWithStatus = useMemo(() => {
    return nodes.map((n) => {
      if (n.type === "group") return n;
      const rs = exec.runState.get(n.id);
      const d = n.data as ZyraNodeData;
      const newStatus = rs?.status;
      const newArgv = rs?.dryRunArgv;
      const connIn = connectedInputMap.get(n.id);
      const connOut = connectedOutputMap.get(n.id);
      if (
        d.runStatus === newStatus &&
        d.dryRunArgv === newArgv &&
        d.onRunNode === onRunNode &&
        d.connectedInputPorts === connIn &&
        d.connectedOutputPorts === connOut
      ) {
        return n;
      }
      return {
        ...n,
        data: {
          ...d,
          runStatus: newStatus,
          dryRunArgv: newArgv,
          onRunNode,
          connectedInputPorts: connIn,
          connectedOutputPorts: connOut,
        },
      };
    });
  }, [nodes, exec.runState, onRunNode, connectedInputMap, connectedOutputMap]);

  // Pipeline from current canvas state
  const pipeline = useMemo<Pipeline>(() => {
    try {
      const p = graphToPipeline(toGraph(nodes, edges), manifest.stages);

      // Serialize group boxes into _groups (editor-only metadata)
      const groupNodes = nodes.filter((n) => n.type === "group");
      if (groupNodes.length > 0) {
        // Derive children from current parentId — includes steps and control nodes
        const stepNames = new Set(p.steps.map((s: PipelineStep) => s.name));
        if (p._controls) for (const c of p._controls) stepNames.add(c.id);
        const groups = groupNodes.map((g) => {
          const d = g.data as GroupBoxData;
          const w = g.measured?.width ?? (typeof g.style?.width === "number" ? g.style.width : 400);
          const h = g.measured?.height ?? (typeof g.style?.height === "number" ? g.style.height : 260);
          const children = nodes
            .filter((n) => n.parentId === g.id && stepNames.has(n.id))
            .map((n) => n.id);
          const group: PipelineGroup = {
            id: g.id,
            label: d.label,
            color: d.color,
            position: { x: Math.round(g.position.x), y: Math.round(g.position.y) },
            size: { w: Math.round(w), h: Math.round(h) },
            children,
          };
          if (d.description) group.description = d.description;
          if (d.locked) group.locked = true;
          return group;
        });
        return { ...p, _groups: groups };
      }

      return p;
    } catch {
      return { version: "1", steps: [] };
    }
  }, [nodes, edges, manifest.stages]);

  // YAML -> canvas
  const handlePipelineChange = useCallback(
    (newPipeline: Pipeline) => {
      const graph = pipelineToGraph(newPipeline, manifest.stages);
      const stageMap = new Map(
        manifest.stages.map((s: StageDef) => [`${s.stage}/${s.command}`, s]),
      );

      const hasLayout = graph.nodes.some((gn: GraphNode) => gn.position);
      const autoPositions = hasLayout
        ? new Map<string, { x: number; y: number }>()
        : computeAutoLayout(graph);

      let newNodes: Node[] = graph.nodes.map((gn: GraphNode) => {
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

      const newEdges: Edge[] = graph.edges.map((ge: GraphEdge, i: number) => ({
        id: `e-yaml-${i}`,
        source: ge.sourceNode,
        sourceHandle: ge.sourcePort,
        target: ge.targetNode,
        targetHandle: ge.targetPort,
        type: "smoothstep",
        style: { stroke: "var(--accent-blue)", strokeWidth: 2 },
        animated: exec.running,
      }));

      // Restore group boxes and parent-child relationships from _groups
      if (newPipeline._groups && newPipeline._groups.length > 0) {
        const nodeIdSet = new Set(newNodes.map((n) => n.id));
        const groupNodes: Node[] = [];

        for (const g of newPipeline._groups) {
          groupNodes.push({
            id: g.id,
            type: "group",
            position: { x: g.position.x, y: g.position.y },
            style: { width: g.size.w, height: g.size.h },
            zIndex: -1,
            data: {
              label: g.label,
              description: g.description,
              color: g.color,
              locked: g.locked,
            } satisfies GroupBoxData,
          });

          // Set parentId on children and convert their positions to relative
          for (const childId of g.children) {
            if (!nodeIdSet.has(childId)) continue;
            const child = newNodes.find((n) => n.id === childId);
            if (child) {
              child.parentId = g.id;
              child.position = {
                x: child.position.x - g.position.x,
                y: child.position.y - g.position.y,
              };
            }
          }
        }

        // Update group ID counter
        const maxGroupNum = newPipeline._groups.reduce((max: number, g: PipelineGroup) => {
          const m = g.id.match(/^group-(\d+)$/);
          return m ? Math.max(max, Number(m[1])) : max;
        }, groupIdCounter);
        groupIdCounter = maxGroupNum;

        // Groups before children (React Flow requirement)
        newNodes = ensureParentOrder([...groupNodes, ...newNodes]);
      }

      const maxNum = graph.nodes.reduce((max: number, n: GraphNode) => {
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
        ...(parentId ? { parentId } : {}),
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
      // Use effective ports so arg-ports and implicit outputs participate
      const srcPorts = getEffectivePorts(srcDef);
      const tgtPorts = getEffectivePorts(tgtDef);
      const srcPort = srcPorts.outputs.find((p: PortDef) => p.id === connection.sourceHandle);
      const tgtPort = tgtPorts.inputs.find((p: PortDef) => p.id === connection.targetHandle);
      if (!srcPort || !tgtPort) return false;

      // Only control nodes and argout:* ports can wire into arg-ports.
      // Regular output ports from non-control nodes cannot target arg-ports.
      if (tgtPort.argKey && srcDef.stage !== "control") {
        if (!connection.sourceHandle?.startsWith("argout:")) return false;
      }
      // Control-flow nodes (delay, cron, conditional, loop) can wire to
      // non-arg input ports but NOT to arg-ports (they don't inline values).
      if (srcDef.stage === "control" && CONTROL_FLOW_COMMANDS.has(srcDef.command)) {
        if (tgtPort.argKey) return false;
      }
      // Value-inlining control nodes (string, number, boolean, choice, filepath,
      // date, secret) are only meaningful when targeting arg-ports.
      if (srcDef.stage === "control" && !CONTROL_FLOW_COMMANDS.has(srcDef.command) && !tgtPort.argKey) return false;
      // Arg-output ports are only meaningful when targeting arg-ports.
      if (connection.sourceHandle?.startsWith("argout:") && !tgtPort.argKey) return false;

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
                    expandParent: undefined,
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
        // Compute absolute position for nodes inside groups (which have relative positions)
        let absX = target.position.x ?? 0;
        let absY = target.position.y ?? 0;
        if (target.parentId) {
          const parent = nodes.find((n) => n.id === target.parentId);
          if (parent) {
            absX += parent.position.x;
            absY += parent.position.y;
          }
        }
        const x = absX + ((target.measured?.width ?? 200) / 2);
        const y = absY + ((target.measured?.height ?? 100) / 2);
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
    // Validate all nodes before running
    const errors: string[] = [];
    for (const n of nodes) {
      if (n.type === "group") continue;
      const d = n.data as ZyraNodeData;
      const linkedKeys = new Set(
        edges
          .filter((e) => e.target === n.id && e.targetHandle?.startsWith("arg:"))
          .map((e) => e.targetHandle!.slice(4)),
      );
      const nodeErrors = validateArgs(d.stageDef.args, d.argValues, linkedKeys);
      if (nodeErrors.length > 0) {
        const label = d.nodeLabel || d.stageDef.label;
        errors.push(`${label}: ${nodeErrors.map((ve) => ve.message).join(", ")}`);
      }
    }
    if (errors.length > 0) {
      alert(`Validation errors:\n\n${errors.join("\n")}`);
      return;
    }
    const graph = toGraph(nodes, edges);
    exec.runPipeline(graph, manifest.stages);
  }, [nodes, edges, manifest.stages, exec.runPipeline]);

  const handleRunNode = useCallback(
    async (nodeId: string) => {
      // Validate this node before running
      const n = nodes.find((nd) => nd.id === nodeId);
      if (n && n.type !== "group") {
        const d = n.data as ZyraNodeData;
        const linkedKeys = new Set(
          edges
            .filter((e) => e.target === nodeId && e.targetHandle?.startsWith("arg:"))
            .map((e) => e.targetHandle!.slice(4)),
        );
        const nodeErrors = validateArgs(d.stageDef.args, d.argValues, linkedKeys);
        if (nodeErrors.length > 0) {
          alert(`Validation errors:\n\n${nodeErrors.map((ve) => ve.message).join("\n")}`);
          return;
        }
      }
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

  // Open pipeline file from disk
  const handleOpenFile = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".yaml,.yml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const raw = yaml.load(text, { schema: yaml.JSON_SCHEMA });
        const p = normalizePipeline(raw);
        if (p) handlePipelineChange(p);
      } catch (err) {
        console.error("Failed to load YAML file", err);
        alert(`Failed to load pipeline file: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    };
    input.click();
  }, [handlePipelineChange]);

  // Apply AI-generated plan to the canvas
  const handlePlanApply = useCallback(
    (newNodes: Node[], newEdges: Edge[]) => {
      // Offset so new nodes don't overlap existing ones
      const maxX = nodes.reduce((mx, n) => {
        if (n.type === "group") return mx;
        const w = n.measured?.width ?? 260;
        return Math.max(mx, n.position.x + w);
      }, 0);
      const offsetX = nodes.length > 0 ? maxX + 120 : 0;
      const offsetNodes = newNodes.map((n) => ({
        ...n,
        position: { x: n.position.x + offsetX, y: n.position.y },
      }));

      // Update ID counter
      const maxNum = offsetNodes.reduce((max, n) => {
        const m = n.id.match(/^node-(\d+)$/);
        return m ? Math.max(max, Number(m[1])) : max;
      }, nodeIdCounter);
      nodeIdCounter = maxNum;

      setNodes((prev) => [...prev, ...offsetNodes]);
      setEdges((prev) => [...prev, ...newEdges]);

      // Record batch for undo
      setPlanBatches((prev) => [
        ...prev,
        {
          nodeIds: offsetNodes.map((n) => n.id),
          edgeIds: newEdges.map((e) => e.id),
          intent: plannerIntent,
          timestamp: Date.now(),
        },
      ]);
    },
    [nodes, setNodes, setEdges, plannerIntent],
  );

  // Undo the most recent AI batch
  const handleUndoLastBatch = useCallback(() => {
    const last = planBatches[planBatches.length - 1];
    if (!last) return;
    const nodeSet = new Set(last.nodeIds);
    const edgeSet = new Set(last.edgeIds);
    setNodes((prev) => prev.filter((n) => !nodeSet.has(n.id)));
    setEdges((prev) => prev.filter((e) => !edgeSet.has(e.id)));
    setPlanBatches((prev) => prev.slice(0, -1));
  }, [planBatches, setNodes, setEdges]);

  // Planner history management
  const handleHistoryAdd = useCallback((entry: PlanHistoryEntry) => {
    setPlannerHistory((prev) => [entry, ...prev].slice(0, 10));
  }, []);

  const handleHistoryRemove = useCallback((idx: number) => {
    setPlannerHistory((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Escape: close yaml → planner → detail panel → deselect
      if (e.key === "Escape") {
        if (yamlOpen) {
          setYamlOpen(false);
        } else if (plannerOpen) {
          setPlannerOpen(false);
        } else if (historyOpen) {
          setHistoryOpen(false);
        } else if (selectedNodeId) {
          setSelectedNodeId(null);
        }
        return;
      }
      // Cmd/Ctrl+O: open pipeline file
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        handleOpenFile();
        return;
      }
      // Cmd/Ctrl+S: export YAML
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        setYamlOpen(true);
        return;
      }
      // Cmd/Ctrl+P: toggle AI Planner
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setPlannerOpen((v) => !v);
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedNodeId, yamlOpen, plannerOpen, historyOpen, handleOpenFile]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  // Compute connected ports for the detail panel
  const connectedInputs = useMemo(() => {
    if (!selectedNodeId) return [];
    return edges
      .filter((e) => e.target === selectedNodeId)
      .map((e) => {
        const srcNode = nodes.find((n) => n.id === e.source);
        const srcData = srcNode?.data as ZyraNodeData | undefined;
        // For control nodes, extract the actual value (or placeholder/default) to show alongside the label
        let peerValue: string | undefined;
        let peerLabel = srcData?.nodeLabel || srcData?.stageDef.label || e.source;
        if (srcData?.stageDef.stage === "control") {
          peerValue = resolveControlDisplayValue(srcData, e.sourceHandle) ?? undefined;
        } else if (e.sourceHandle?.startsWith("argout:")) {
          // Arg-to-arg wire: show source arg name in label and arg value as peerValue
          const argKey = e.sourceHandle.slice(7);
          const argDef = srcData?.stageDef.args.find((a: ArgDef) => a.key === argKey);
          const argLabel = argDef?.label ?? argKey;
          peerLabel = `${peerLabel} / ${argLabel}`;
          const val = srcData?.argValues[argKey];
          peerValue = val !== undefined && val !== "" ? String(val) : undefined;
        }
        return {
          portId: e.targetHandle ?? "",
          peerNodeId: e.source,
          peerLabel,
          peerValue,
          peerSensitive: srcData?.stageDef.command === "secret",
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
        onOpen={handleOpenFile}
        onDryRun={handleDryRun}
        onRun={handleRun}
        onCancel={exec.cancelAll}
        onReset={exec.reset}
        running={exec.running}
        nodeCount={nodes.filter((n) => n.type !== "group").length}
        runState={exec.runState}
        yamlOpen={yamlOpen}
        onToggleYaml={() => setYamlOpen((v) => !v)}
        plannerOpen={plannerOpen}
        onTogglePlanner={() => setPlannerOpen((v) => !v)}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        useCache={useCache}
        onToggleCache={() => setUseCache((v) => !v)}
        theme={theme}
        onToggleTheme={toggleTheme}
        backendStatus={backendStatus}
      />

      <NodePalette
        onAddNode={handleAddNode}
        onAddGroup={handleAddGroup}
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
          onEdgeClick={() => setSelectedNodeId(null)}
          onPaneClick={() => setSelectedNodeId(null)}
          onDragOver={onDragOver}
          onDrop={onDrop}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          fitView
          panOnDrag
          selectionOnDrag={false}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={["Backspace", "Delete"]}
          defaultEdgeOptions={{
            type: "smoothstep",
            style: { stroke: "var(--accent-blue)", strokeWidth: 2 },
            animated: exec.running,
            interactionWidth: 20,
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

      {/* Run History Panel */}
      {historyOpen && (
        <RunHistoryPanel
          onClose={() => setHistoryOpen(false)}
          onRestoreGraph={(snapshot) => {
            setNodes(snapshot.nodes as Node[]);
            setEdges(snapshot.edges as Edge[]);
          }}
          refreshKey={historyRefreshKey}
        />
      )}

      {/* AI Planner Panel */}
      {plannerOpen && (
        <PlannerPanel
          manifest={manifest}
          onApply={handlePlanApply}
          onClose={() => setPlannerOpen(false)}
          intent={plannerIntent}
          onIntentChange={setPlannerIntent}
          history={plannerHistory}
          onHistoryAdd={handleHistoryAdd}
          onHistoryRemove={handleHistoryRemove}
          batches={planBatches}
          onUndoBatch={handleUndoLastBatch}
          backendStatus={backendStatus}
        />
      )}

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
