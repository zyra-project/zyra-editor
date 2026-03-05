import type { StageDef } from "./manifest.js";

/**
 * A placed node in the editor graph.
 * The editor populates `argValues` as the user fills in the config panel.
 */
export interface GraphNode {
  id: string;
  stageCommand: string;   // "acquire/http"
  argValues: Record<string, string | number | boolean>;
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
  command: string;
  args: Record<string, string | number | boolean>;
  depends_on?: string[];
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
    if (deps.length > 0) step.depends_on = deps;
    return step;
  });

  return { version: "1", steps };
}
