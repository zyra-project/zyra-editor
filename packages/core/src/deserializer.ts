import type { StageDef } from "./manifest.js";
import type { Graph, GraphNode, GraphEdge, Pipeline } from "./serializer.js";

/**
 * Convert a Pipeline (parsed from YAML) back into a Graph suitable for
 * the editor.  Each step is matched to a StageDef by comparing the step's
 * `command` against `stage.cli` and the shorthand `stage/command` form.
 *
 * Edge reconstruction uses `depends_on` — one edge per dependency, using
 * the first compatible output→input port pair (or falling back to the
 * first ports available).
 */
export function pipelineToGraph(
  pipeline: Pipeline,
  stages: StageDef[],
): Graph {
  // Build lookup: cli string → StageDef, and "stage/command" → StageDef
  const byCli = new Map<string, StageDef>();
  const byKey = new Map<string, StageDef>();
  for (const s of stages) {
    byCli.set(s.cli, s);
    byKey.set(`${s.stage}/${s.command}`, s);
  }

  function findStage(command: string): StageDef | undefined {
    // Try exact cli match first
    if (byCli.has(command)) return byCli.get(command);
    // Try "stage/command" shorthand
    if (byKey.has(command)) return byKey.get(command);
    // Try stripping "zyra " prefix
    const stripped = command.replace(/^zyra\s+/, "");
    if (byCli.has(stripped)) return byCli.get(stripped);
    // Try converting "stage command" → "stage/command"
    const parts = stripped.split(/\s+/);
    if (parts.length >= 2) {
      const key = `${parts[0]}/${parts[1]}`;
      if (byKey.has(key)) return byKey.get(key);
    }
    return undefined;
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, { node: GraphNode; stage?: StageDef }>();

  for (const step of pipeline.steps) {
    const stage = findStage(step.command);
    const node: GraphNode = {
      id: step.name,
      label: step.name,
      stageCommand: stage
        ? `${stage.stage}/${stage.command}`
        : step.command,
      argValues: { ...step.args },
      position: step._layout ? { x: step._layout.x, y: step._layout.y } : undefined,
    };
    nodes.push(node);
    nodeMap.set(step.name, { node, stage });
  }

  // Reconstruct edges from depends_on
  for (const step of pipeline.steps) {
    if (!step.depends_on) continue;
    const target = nodeMap.get(step.name);
    if (!target) continue;

    for (const depName of step.depends_on) {
      const source = nodeMap.get(depName);
      if (!source) continue;

      // Pick first output port of source and first input port of target
      const sourcePort = source.stage?.outputs[0]?.id ?? "out";
      const targetPort = target.stage?.inputs[0]?.id ?? "in";

      edges.push({
        sourceNode: depName,
        sourcePort,
        targetNode: step.name,
        targetPort,
      });
    }
  }

  return { nodes, edges };
}
