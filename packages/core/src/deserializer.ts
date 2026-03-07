import type { StageDef, ArgDef } from "./manifest.js";
import type { Graph, GraphNode, GraphEdge, Pipeline } from "./serializer.js";

/**
 * Convert a Pipeline (parsed from YAML) back into a Graph suitable for
 * the editor.  Each step is matched to a StageDef by comparing the step's
 * `command` against `stage.cli` and the shorthand `stage/command` form.
 *
 * Edge reconstruction uses `depends_on` — one edge per dependency, using
 * the first output port of the source stage and the first input port of
 * the target stage (falling back to "out" and "in" when stage metadata
 * is absent).
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

  /** Normalize a raw command string to "stage/command" form for round-tripping. */
  function normalizeCommand(cmd: string): string {
    const stripped = cmd.replace(/^zyra\s+/, "");
    const parts = stripped.split(/\s+/);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return stripped;
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, { node: GraphNode; stage?: StageDef }>();

  for (const step of pipeline.steps) {
    const stage = findStage(step.command);
    const node: GraphNode = {
      id: step.name,
      label: step.label,
      stageCommand: stage
        ? `${stage.stage}/${stage.command}`
        : normalizeCommand(step.command),
      argValues: stage ? remapArgs(step.args, stage.args) : { ...step.args },
      position: step._layout ? { x: step._layout.x, y: step._layout.y } : undefined,
      size:
        step._layout && step._layout.w != null && step._layout.h != null
          ? { w: step._layout.w, h: step._layout.h }
          : undefined,
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

  // Reconstruct control nodes from _controls metadata
  if (pipeline._controls) {
    for (const ctrl of pipeline._controls) {
      const node: GraphNode = {
        id: ctrl.id,
        label: ctrl.label,
        stageCommand: ctrl.stageCommand,
        argValues: { ...ctrl.argValues },
        position: ctrl._layout ? { x: ctrl._layout.x, y: ctrl._layout.y } : undefined,
        size:
          ctrl._layout && ctrl._layout.w != null && ctrl._layout.h != null
            ? { w: ctrl._layout.w, h: ctrl._layout.h }
            : undefined,
      };
      nodes.push(node);

      // Reconstruct edges from control node to downstream arg-ports
      const stage = findStage(ctrl.stageCommand) ?? byKey.get(ctrl.stageCommand);
      const sourcePort = stage?.outputs[0]?.id ?? "value";
      for (const ce of ctrl.edges) {
        // Only reconstruct edges targeting valid arg-ports on existing nodes
        if (!ce.targetPort.startsWith("arg:")) continue;
        if (!nodeMap.has(ce.targetNode)) continue;
        edges.push({
          sourceNode: ctrl.id,
          sourcePort,
          targetNode: ce.targetNode,
          targetPort: ce.targetPort,
        });
      }
    }
  }

  return { nodes, edges };
}

// ── arg key normalization ──────────────────────────────────────────

/** Normalize a key for fuzzy matching: lowercase, strip hyphens/underscores. */
function norm(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/**
 * Remap YAML arg keys to manifest arg keys using fuzzy matching.
 * For each YAML key, tries:
 *   1. Exact match against manifest arg key
 *   2. Normalized match (ignore hyphens/underscores/case)
 *   3. Match against the flag field (e.g. --since-period → since_period)
 * Unmatched keys are preserved as-is (they'll show as "Extra Arguments").
 */
function remapArgs(
  yamlArgs: Record<string, string | number | boolean>,
  argDefs: ArgDef[],
): Record<string, string | number | boolean> {
  // Build lookup maps from various key forms → canonical manifest key
  const exactMap = new Map<string, string>();
  const normMap = new Map<string, string>();

  for (const arg of argDefs) {
    exactMap.set(arg.key, arg.key);
    normMap.set(norm(arg.key), arg.key);
    if (arg.flag) {
      const flagKey = arg.flag.replace(/^-+/, "");
      exactMap.set(flagKey, arg.key);
      normMap.set(norm(flagKey), arg.key);
    }
  }

  /** Try suffix match: YAML "period" matches manifest "since_period" on a word boundary.
   *  Only matches when unambiguous (exactly one candidate) and key is at least 3 chars. */
  function suffixMatch(key: string): string | undefined {
    const trimmed = key.trim().toLowerCase();
    if (trimmed.length < 3) return undefined;
    const matches: string[] = [];
    for (const arg of argDefs) {
      const argLower = arg.key.toLowerCase();
      if (argLower.endsWith(`_${trimmed}`) || argLower.endsWith(`-${trimmed}`)) {
        matches.push(arg.key);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(yamlArgs)) {
    const exact = exactMap.get(k);
    if (exact) {
      out[exact] = v;
      continue;
    }
    const byNorm = normMap.get(norm(k));
    if (byNorm) {
      // Fuzzy match — preserve under raw key if it would collide
      if (byNorm !== k && Object.prototype.hasOwnProperty.call(out, byNorm)) {
        out[k] = v;
      } else {
        out[byNorm] = v;
      }
      continue;
    }
    const bySuffix = suffixMatch(k);
    if (bySuffix) {
      if (Object.prototype.hasOwnProperty.call(out, bySuffix)) {
        out[k] = v;
      } else {
        out[bySuffix] = v;
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}
