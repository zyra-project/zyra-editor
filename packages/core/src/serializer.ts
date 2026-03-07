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

/** Condition gate — step only runs when this evaluates to true. */
export interface StepCondition {
  /** The field or property to evaluate from the upstream output. */
  field: string;
  /** Comparison operator. */
  operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "matches";
  /** Value to compare against. */
  value: string;
  /** Which branch of the conditional this step is on. */
  branch: "true" | "false";
}

/** Loop wrapper — step executes once per iteration. */
export interface StepLoop {
  /** Iteration mode. */
  mode: "each" | "batch" | "range";
  /** Step name whose output provides the items (for "each" and "batch" modes). */
  over?: string;
  /** Number of items per batch (batch mode only). */
  batch_size?: number;
  /** Numeric range start (range mode only). */
  range_start?: number;
  /** Numeric range end (range mode only). */
  range_end?: number;
  /** Numeric range step size (range mode only). */
  range_step?: number;
  /** Maximum concurrent iterations. */
  max_parallel?: number;
}

export interface PipelineStep {
  name: string;
  /** User-facing label for YAML display (defaults to name if unset). */
  label?: string;
  command: string;
  args: Record<string, string | number | boolean>;
  depends_on?: string[];
  /** Delay in seconds to wait before executing this step. */
  delay_seconds?: number;
  /** Condition gate — step is skipped unless the condition matches. */
  condition?: StepCondition;
  /** Loop wrapper — step runs once per iteration. */
  loop?: StepLoop;
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
  /** Edges from this control node to downstream nodes. */
  edges: { sourcePort?: string; targetNode: string; targetPort: string }[];
  _layout?: { x: number; y: number; w?: number; h?: number };
}

/** Recurring schedule definition for the pipeline. */
export interface PipelineSchedule {
  cron: string;
  timezone?: string;
  enabled?: boolean;
}

export interface Pipeline {
  version: string;
  /** Recurring execution schedule (from a control/cron node). */
  schedule?: PipelineSchedule;
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

  // ── Extract schedule from cron nodes ─────────────────────────────
  let schedule: PipelineSchedule | undefined;
  for (const n of graph.nodes) {
    if (n.stageCommand !== "control/cron") continue;
    const expr = n.argValues.expression;
    if (typeof expr === "string" && expr.trim().length > 0) {
      schedule = { cron: expr.trim() };
      const tz = n.argValues.timezone;
      if (typeof tz === "string" && tz.trim().length > 0) schedule.timezone = tz.trim();
      if (n.argValues.enabled === false) schedule.enabled = false;
    } else {
      diagnostics?.push({
        level: "warn",
        message: `Cron schedule node "${n.id}" has no expression — schedule will be omitted.`,
      });
    }
  }

  // ── Extract delay targets from delay nodes ──────────────────────
  // Map from target step node ID → delay in seconds
  const delayMap = new Map<string, number>();
  for (const e of graph.edges) {
    const srcNode = nodeMap.get(e.sourceNode);
    if (!srcNode || srcNode.stageCommand !== "control/delay") continue;
    if (!e.targetPort.startsWith("arg:")) continue;
    const dur = Number(srcNode.argValues.duration);
    if (isNaN(dur) || dur <= 0) continue;
    const unit = srcNode.argValues.unit ?? "seconds";
    const multiplier = unit === "hours" ? 3600 : unit === "minutes" ? 60 : 1;
    delayMap.set(e.targetNode, dur * multiplier);
  }

  // ── Extract conditions from conditional nodes ───────────────────
  // Map from target step node ID → StepCondition
  const conditionMap = new Map<string, StepCondition>();
  for (const e of graph.edges) {
    const srcNode = nodeMap.get(e.sourceNode);
    if (!srcNode || srcNode.stageCommand !== "control/conditional") continue;
    // Only process data-flow edges from "true" or "false" output ports
    if (e.sourcePort !== "true" && e.sourcePort !== "false") continue;

    const field = srcNode.argValues.field;
    const operator = srcNode.argValues.operator;
    const compareValue = srcNode.argValues.compare_value;
    if (typeof field !== "string" || !field) {
      diagnostics?.push({
        level: "warn",
        message: `Conditional node "${e.sourceNode}" has no field — condition will be omitted.`,
      });
      continue;
    }
    conditionMap.set(e.targetNode, {
      field,
      operator: (operator as StepCondition["operator"]) ?? "==",
      value: String(compareValue ?? ""),
      branch: e.sourcePort as "true" | "false",
    });
  }

  // ── Extract loops from loop nodes ─────────────────────────────
  // Map from target step node ID → StepLoop
  const loopMap = new Map<string, StepLoop>();
  for (const e of graph.edges) {
    const srcNode = nodeMap.get(e.sourceNode);
    if (!srcNode || srcNode.stageCommand !== "control/loop") continue;
    // Only process data-flow edges from "item", "index", or "done" output ports
    if (e.sourcePort !== "item" && e.sourcePort !== "index" && e.sourcePort !== "done") continue;

    // Only build the loop definition once per target, from the first edge
    if (loopMap.has(e.targetNode)) continue;

    const mode = srcNode.argValues.mode;
    if (!mode) continue;

    // Find what provides items to the loop node (edge into the loop's "items" input)
    let over: string | undefined;
    for (const itemEdge of graph.edges) {
      if (itemEdge.targetNode === srcNode.id && itemEdge.targetPort === "items") {
        over = itemEdge.sourceNode;
        break;
      }
    }

    const loop: StepLoop = {
      mode: mode as StepLoop["mode"],
    };
    if (over) loop.over = over;
    if (mode === "batch") {
      const bs = Number(srcNode.argValues.batch_size);
      if (!isNaN(bs) && bs > 0) loop.batch_size = bs;
    } else if (mode === "range") {
      const rs = Number(srcNode.argValues.range_start);
      const re = Number(srcNode.argValues.range_end);
      const rst = Number(srcNode.argValues.range_step);
      if (!isNaN(rs)) loop.range_start = rs;
      if (!isNaN(re)) loop.range_end = re;
      if (!isNaN(rst) && rst > 0) loop.range_step = rst;
    }
    const mp = Number(srcNode.argValues.max_parallel);
    if (!isNaN(mp) && mp > 1) loop.max_parallel = mp;

    loopMap.set(e.targetNode, loop);
  }

  // Build a map of inlined arg values from control-node edges.
  // Key: targetNodeId, Value: Map<argKey, inlined value>
  const inlinedArgs = new Map<string, Map<string, string | number | boolean>>();
  for (const e of graph.edges) {
    if (!controlNodeIds.has(e.sourceNode)) continue;
    // Skip delay, cron, conditional, and loop nodes from the standard inlining path —
    // they are handled separately above.
    const srcCmd = nodeMap.get(e.sourceNode)?.stageCommand;
    if (srcCmd === "control/delay" || srcCmd === "control/cron"
      || srcCmd === "control/conditional" || srcCmd === "control/loop") continue;
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
    const delay = delayMap.get(id);
    if (delay !== undefined) step.delay_seconds = delay;
    const condition = conditionMap.get(id);
    if (condition) step.condition = condition;
    const loop = loopMap.get(id);
    if (loop) step.loop = loop;
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
      .filter((e) => e.sourceNode === n.id)
      .map((e) => ({ sourcePort: e.sourcePort, targetNode: e.targetNode, targetPort: e.targetPort }));
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
  if (schedule) result.schedule = schedule;
  if (controls.length > 0) result._controls = controls;
  return result;
}
