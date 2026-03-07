import type { StageDef } from "./manifest.js";

/**
 * A placed node in the editor graph.
 * The editor populates `argValues` as the user fills in the config panel.
 */
export interface GraphNode {
  id: string;
  /** User-facing display label for the editor (optional, display-only metadata). */
  label?: string;
  stageCommand: string;   // "acquire/http"
  argValues: Record<string, string | number | boolean>;
  /** Canvas position (for round-tripping through YAML). */
  position?: { x: number; y: number };
  /** Canvas size (for round-tripping through YAML). */
  size?: { w: number; h: number };
}

/** An edge between two nodes (output port → input port). */
export interface GraphEdge {
  sourceNode: string;
  sourcePort: string;
  targetNode: string;
  targetPort: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── pipeline.yaml serialization ───────────────────────────────────

export interface PipelineStep {
  name: string;
  /** User-facing label for YAML display (defaults to name if unset). */
  label?: string;
  command: string;
  args: Record<string, string | number | boolean>;
  depends_on?: string[];
  /** Editor layout metadata — not used by the Zyra CLI. */
  _layout?: { x: number; y: number; w?: number; h?: number };
}

/** Editor-only group box metadata — ignored by the Zyra CLI. */
export interface PipelineGroup {
  id: string;
  label: string;
  description?: string;
  color: string;
  locked?: boolean;
  position: { x: number; y: number };
  size: { w: number; h: number };
  children: string[];
}

/** Editor-only control node metadata — not used by the Zyra CLI. */
export interface PipelineControl {
  id: string;
  /** The control type, e.g. "control/string", "control/number". */
  stageCommand: string;
  label?: string;
  argValues: Record<string, string | number | boolean>;
  /** Edges from this control node to downstream arg-ports. */
  edges: { targetNode: string; targetPort: string }[];
  _layout?: { x: number; y: number; w?: number; h?: number };
}

export interface Pipeline {
  version: string;
  steps: PipelineStep[];
  /** Editor-only group box layout — not used by the Zyra CLI. */
  _groups?: PipelineGroup[];
  /** Editor-only control nodes — not used by the Zyra CLI. */
  _controls?: PipelineControl[];
}

/**
 * Topologically sort graph nodes and emit a pipeline.yaml-shaped object.
 * The caller is responsible for YAML stringification (keeps this package
 * dependency-free).
 */
export interface PipelineDiagnostic {
  level: "warn" | "error";
  message: string;
}

export function graphToPipeline(
  graph: Graph,
  stages: StageDef[],
  diagnostics?: PipelineDiagnostic[],
): Pipeline {
  const stageMap = new Map(
    stages.map((s) => [`${s.stage}/${s.command}`, s]),
  );

  // Identify control nodes — these are editor-only and should not appear
  // as pipeline steps.  Instead their values are inlined into downstream args.
  const controlNodeIds = new Set(
    graph.nodes
      .filter((n) => n.stageCommand.startsWith("control/"))
      .map((n) => n.id),
  );
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // Build a map of inlined arg values from control-node edges.
  // Key: targetNodeId, Value: Map<argKey, inlined value>
  const inlinedArgs = new Map<string, Map<string, string | number | boolean>>();
  for (const e of graph.edges) {
    if (!controlNodeIds.has(e.sourceNode)) continue;
    if (!e.targetPort.startsWith("arg:")) {
      diagnostics?.push({
        level: "warn",
        message: `Control node "${e.sourceNode}" has an unsupported edge to "${e.targetNode}:${e.targetPort}" — this connection will be dropped from the pipeline.`,
      });
      continue;
    }
    const srcNode = nodeMap.get(e.sourceNode);
    if (!srcNode) continue;

    // Secret variables emit an env-var reference instead of the plaintext value
    const isSecretVar = srcNode.stageCommand === "control/variable"
      && srcNode.argValues.var_type === "secret";

    let val = srcNode.argValues.value;
    // Fall back to the ArgDef default so wired control nodes with
    // defaults (e.g., boolean false) still serialize correctly.
    // Treat empty string as unset for non-string control types (matches UI display).
    // Secret variables are exempt — their value is intentionally empty in the editor;
    // the real value comes from environment variables at runtime.
    if (!isSecretVar && (val === undefined || (val === "" && !srcNode.stageCommand.endsWith("/string")))) {
      const ctrlStage = stageMap.get(srcNode.stageCommand);
      const valueDef = ctrlStage?.args?.find((a) => a.key === "value");
      if (valueDef?.default !== undefined) {
        val = valueDef.default;
      } else {
        continue;
      }
    }

    if (isSecretVar) {
      const varName = srcNode.argValues.name;
      if (typeof varName === "string" && varName.length > 0) {
        val = `\${${varName}}`;
      } else {
        diagnostics?.push({
          level: "warn",
          message: `Secret variable node "${e.sourceNode}" has no name — the secret value will be omitted.`,
        });
        continue;
      }
    }

    const argKey = e.targetPort.slice(4); // strip "arg:" prefix
    if (!inlinedArgs.has(e.targetNode)) inlinedArgs.set(e.targetNode, new Map());
    inlinedArgs.get(e.targetNode)!.set(argKey, val);
  }

  // Filter out control-node edges from the graph for topo sort and depends_on
  const nonControlEdges = graph.edges.filter(
    (e) => !controlNodeIds.has(e.sourceNode) && !controlNodeIds.has(e.targetNode),
  );
  const nonControlNodes = graph.nodes.filter((n) => !controlNodeIds.has(n.id));

  // Build adjacency for topo sort
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  const parentMap = new Map<string, string[]>();

  for (const n of nonControlNodes) {
    inDegree.set(n.id, 0);
    children.set(n.id, []);
    parentMap.set(n.id, []);
  }

  for (const e of nonControlEdges) {
    children.get(e.sourceNode)!.push(e.targetNode);
    parentMap.get(e.targetNode)!.push(e.sourceNode);
    inDegree.set(e.targetNode, (inDegree.get(e.targetNode) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue = nonControlNodes
    .filter((n) => inDegree.get(n.id) === 0)
    .map((n) => n.id);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const child of children.get(id) ?? []) {
      const deg = inDegree.get(child)! - 1;
      inDegree.set(child, deg);
      if (deg === 0) queue.push(child);
    }
  }

  if (sorted.length !== nonControlNodes.length) {
    throw new Error("Graph contains a cycle — cannot serialize to pipeline");
  }

  const steps: PipelineStep[] = sorted.map((id) => {
    const node = nodeMap.get(id)!;
    const stage = stageMap.get(node.stageCommand);
    const deps = parentMap.get(id) ?? [];

    // Merge node's own argValues with any inlined values from control nodes
    const mergedArgs = { ...node.argValues };
    const inlined = inlinedArgs.get(id);
    if (inlined) {
      for (const [k, v] of inlined) mergedArgs[k] = v;
    }

    const step: PipelineStep = {
      name: id,
      command: stage?.cli ?? node.stageCommand,
      args: mergedArgs,
    };
    if (node.label && node.label !== id) step.label = node.label;
    const uniqueDeps = [...new Set(deps)];
    if (uniqueDeps.length > 0) step.depends_on = uniqueDeps;
    if (node.position || node.size) {
      const layout: PipelineStep["_layout"] = {
        x: Math.round(node.position?.x ?? 0),
        y: Math.round(node.position?.y ?? 0),
      };
      if (node.size) {
        layout.w = Math.round(node.size.w);
        layout.h = Math.round(node.size.h);
      }
      step._layout = layout;
    }
    return step;
  });

  // Serialize control nodes as editor-only metadata for round-tripping
  const controls: PipelineControl[] = [];
  for (const n of graph.nodes) {
    if (!controlNodeIds.has(n.id)) continue;
    const ctrlEdges = graph.edges
      .filter((e) => e.sourceNode === n.id && e.targetPort.startsWith("arg:"))
      .map((e) => ({ targetNode: e.targetNode, targetPort: e.targetPort }));
    // Strip plaintext secret values from the YAML — only keep the variable name and type
    const ctrlArgs = { ...n.argValues };
    if (n.stageCommand === "control/variable" && ctrlArgs.var_type === "secret") {
      delete ctrlArgs.value;
    }

    const ctrl: PipelineControl = {
      id: n.id,
      stageCommand: n.stageCommand,
      argValues: ctrlArgs,
      edges: ctrlEdges,
    };
    if (n.label) ctrl.label = n.label;
    if (n.position || n.size) {
      const layout: PipelineControl["_layout"] = {
        x: Math.round(n.position?.x ?? 0),
        y: Math.round(n.position?.y ?? 0),
      };
      if (n.size) {
        layout.w = Math.round(n.size.w);
        layout.h = Math.round(n.size.h);
      }
      ctrl._layout = layout;
    }
    controls.push(ctrl);
  }

  const result: Pipeline = { version: "1", steps };
  if (controls.length > 0) result._controls = controls;
  return result;
}
