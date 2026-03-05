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

export interface Pipeline {
  version: string;
  steps: PipelineStep[];
}

/**
 * Topologically sort graph nodes and emit a pipeline.yaml-shaped object.
 * The caller is responsible for YAML stringification (keeps this package
 * dependency-free).
 */
export function graphToPipeline(
  graph: Graph,
  stages: StageDef[],
): Pipeline {
  const stageMap = new Map(
    stages.map((s) => [`${s.stage}/${s.command}`, s]),
  );

  // Build adjacency for topo sort
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  const parentMap = new Map<string, string[]>();

  for (const n of graph.nodes) {
    inDegree.set(n.id, 0);
    children.set(n.id, []);
    parentMap.set(n.id, []);
  }

  for (const e of graph.edges) {
    children.get(e.sourceNode)!.push(e.targetNode);
    parentMap.get(e.targetNode)!.push(e.sourceNode);
    inDegree.set(e.targetNode, (inDegree.get(e.targetNode) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue = graph.nodes
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

  if (sorted.length !== graph.nodes.length) {
    throw new Error("Graph contains a cycle — cannot serialize to pipeline");
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  const steps: PipelineStep[] = sorted.map((id) => {
    const node = nodeMap.get(id)!;
    const stage = stageMap.get(node.stageCommand);
    const deps = parentMap.get(id) ?? [];

    const step: PipelineStep = {
      name: id,
      command: stage?.cli ?? node.stageCommand,
      args: { ...node.argValues },
    };
    if (node.label && node.label !== id) step.label = node.label;
    if (deps.length > 0) step.depends_on = deps;
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

  return { version: "1", steps };
}
