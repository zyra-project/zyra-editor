import type { StageDef } from "./manifest.js";
import type { PipelineResource } from "./resources.js";

/** Map human-readable period enum values to ISO 8601 durations. */
export const PERIOD_TO_ISO: Record<string, string> = {
  daily: "P1D",
  weekly: "P1W",
  monthly: "P1M",
  yearly: "P1Y",
};

/** Resolve a Date node period value to an ISO 8601 duration string. */
export function resolvePeriodISO(
  period: string | number | boolean | undefined,
  customPeriod: string | number | boolean | undefined,
): string | undefined {
  if (period === undefined || period === "") return undefined;
  const p = String(period);
  if (p === "custom") return customPeriod ? String(customPeriod) : undefined;
  return PERIOD_TO_ISO[p] ?? p;
}

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
  /** Edges from upstream nodes into this control node (e.g. Extract's input). */
  inputEdges?: { sourceNode: string; sourcePort: string; targetPort?: string }[];
  _layout?: { x: number; y: number; w?: number; h?: number };
}

/** Recurring schedule definition for the pipeline. */
export interface PipelineSchedule {
  cron: string;
  timezone?: string;
  enabled?: boolean;
}

/** Editor-only arg-to-arg wire metadata — not used by the Zyra CLI. */
export interface PipelineArgWire {
  sourceNode: string;
  sourceArgKey: string;
  targetNode: string;
  targetArgKey: string;
}

export interface Pipeline {
  version: string;
  /** Recurring execution schedule (from a control/cron node). */
  schedule?: PipelineSchedule;
  /** Named pipeline-level resources, referenced in args via ${res:name}. */
  resources?: PipelineResource[];
  steps: PipelineStep[];
  /** Editor-only group box layout — not used by the Zyra CLI. */
  _groups?: PipelineGroup[];
  /** Editor-only control nodes — not used by the Zyra CLI. */
  _controls?: PipelineControl[];
  /** Editor-only arg-to-arg wires — not used by the Zyra CLI. */
  _argWires?: PipelineArgWire[];
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
      if (schedule) {
        diagnostics?.push({
          level: "warn",
          message: `Multiple cron schedule nodes found — only the first will be used. Node "${n.id}" will be ignored.`,
        });
        continue;
      }
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
    // Apply delay to the target step regardless of port type — delay is a
    // step-level concept, not tied to a specific argument.
    const dur = Number(srcNode.argValues.duration);
    if (isNaN(dur) || dur <= 0) continue;
    const unit = srcNode.argValues.unit ?? "seconds";
    const multiplier = unit === "hours" ? 3600 : unit === "minutes" ? 60 : 1;
    const delaySecs = dur * multiplier;
    const existing = delayMap.get(e.targetNode);
    if (existing !== undefined && existing !== delaySecs) {
      diagnostics?.push({
        level: "warn",
        message: `Multiple delay nodes target step "${e.targetNode}" — later delay of ${delaySecs}s will override earlier delay of ${existing}s.`,
      });
    }
    delayMap.set(e.targetNode, delaySecs);
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
    const validOperators = new Set(["==", "!=", ">", "<", ">=", "<=", "contains", "matches"]);
    const op = typeof operator === "string" && validOperators.has(operator) ? operator as StepCondition["operator"] : undefined;
    if (!op) {
      diagnostics?.push({
        level: "warn",
        message: `Conditional node "${e.sourceNode}" has an invalid operator "${String(operator)}" — defaulting to "==".`,
      });
    }
    if (conditionMap.has(e.targetNode)) {
      diagnostics?.push({
        level: "warn",
        message: `Multiple conditions target step "${e.targetNode}" — later condition from "${e.sourceNode}" will override the earlier one.`,
      });
    }
    conditionMap.set(e.targetNode, {
      field,
      operator: op ?? "==",
      value: String(compareValue ?? ""),
      branch: e.sourcePort as "true" | "false",
    });
  }

  // ── Extract loops from loop nodes ─────────────────────────────
  // Precompute an index of edges by (targetNode, targetPort) for O(1) lookup
  // when finding what provides items to a loop node.
  const edgesByTarget = new Map<string, string>();
  for (const e of graph.edges) {
    const key = `${e.targetNode}:${e.targetPort}`;
    if (!edgesByTarget.has(key)) {
      edgesByTarget.set(key, e.sourceNode);
    } else if (e.targetPort === "items") {
      // Multiple providers for a loop's "items" input — keep first for determinism
      diagnostics?.push({
        level: "warn",
        message: `Loop node "${e.targetNode}" has multiple sources for "items": "${edgesByTarget.get(key)}" and "${e.sourceNode}". Using "${edgesByTarget.get(key)}".`,
      });
    }
  }

  // Map from target step node ID → StepLoop
  const loopMap = new Map<string, StepLoop>();
  for (const e of graph.edges) {
    const srcNode = nodeMap.get(e.sourceNode);
    if (!srcNode || srcNode.stageCommand !== "control/loop") continue;
    // Only process data-flow edges from "item" or "index" output ports (per-iteration values).
    // "done" represents post-loop flow and is preserved via _controls edges, not step.loop.
    if (e.sourcePort !== "item" && e.sourcePort !== "index") continue;

    // Only build the loop definition once per target, from the first edge
    if (loopMap.has(e.targetNode)) continue;

    const mode = srcNode.argValues.mode;
    const validModes = new Set(["each", "batch", "range"]);
    if (!mode || !validModes.has(String(mode))) {
      diagnostics?.push({
        level: "warn",
        message: `Loop node "${srcNode.id}" has an invalid mode "${String(mode ?? "")}" — loop will be omitted.`,
      });
      continue;
    }

    // Find what provides items to the loop node (O(1) lookup)
    const over = edgesByTarget.get(`${srcNode.id}:items`);

    const loop: StepLoop = {
      mode: mode as StepLoop["mode"],
    };
    // loop.over must reference a pipeline step name; omit it if items are
    // driven by a control node (which won't appear as a step).
    if (over && !controlNodeIds.has(over)) loop.over = over;
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
      || srcCmd === "control/conditional" || srcCmd === "control/loop"
      || srcCmd === "control/extract") continue;
    if (!e.targetPort.startsWith("arg:")) {
      diagnostics?.push({
        level: "warn",
        message: `Control node "${e.sourceNode}" has an unsupported edge to "${e.targetNode}:${e.targetPort}" — this connection will be dropped from the pipeline.`,
      });
      continue;
    }
    const srcNode = nodeMap.get(e.sourceNode);
    if (!srcNode) continue;

    // Secret nodes emit an env-var reference instead of the plaintext value
    const isSecretVar = srcNode.stageCommand === "control/secret";

    // Resolve value from the source port's matching arg key, falling back to "value"
    let val = e.sourcePort && e.sourcePort !== "value" && srcNode.argValues[e.sourcePort] !== undefined
      ? srcNode.argValues[e.sourcePort]
      : srcNode.argValues.value;

    // Date "period" port: resolve enum value ("yearly") → ISO 8601 duration ("P1Y")
    if (srcNode.stageCommand === "control/date" && e.sourcePort === "period") {
      const resolved = resolvePeriodISO(val, srcNode.argValues.custom_period);
      if (resolved !== undefined) {
        val = resolved;
      } else if (val === "custom" && !srcNode.argValues.custom_period) {
        diagnostics?.push({
          level: "warn",
          message: `Control date node "${e.sourceNode}" has period "custom" but no valid custom_period; this connection will be treated as unset.`,
        });
        continue;
      }
    }

    // Choice "label" port: resolve the label of the currently selected option
    if (srcNode.stageCommand === "control/choice" && e.sourcePort === "label") {
      try {
        const opts = JSON.parse(String(srcNode.argValues.options ?? "[]")) as { label: string; value: string }[];
        const sel = opts.find((o) => o.value === String(val ?? ""));
        val = sel?.label ?? val;
      } catch { /* keep val as-is if options aren't valid JSON */ }
    }

    // Fall back to the ArgDef default so wired control nodes with
    // defaults (e.g., boolean false) still serialize correctly.
    // Treat empty string as unset for non-string control types (matches UI display).
    // Secret nodes are exempt — their value is intentionally empty in the editor;
    // the real value comes from environment variables at runtime.
    if (!isSecretVar && (val === undefined || (val === "" && !srcNode.stageCommand.endsWith("/string")))) {
      const ctrlStage = stageMap.get(srcNode.stageCommand);
      const argKey = e.sourcePort && e.sourcePort !== "value" ? e.sourcePort : "value";
      const valueDef = ctrlStage?.args?.find((a) => a.key === argKey)
        ?? ctrlStage?.args?.find((a) => a.key === "value");
      if (valueDef?.default !== undefined) {
        val = valueDef.default;
      } else {
        continue;
      }
    }

    if (isSecretVar) {
      const varName = srcNode.argValues.name;
      if (typeof varName === "string" && varName.length > 0) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
          diagnostics?.push({
            level: "warn",
            message: `Secret node "${e.sourceNode}" has an invalid name "${varName}" — environment variable names must match [A-Za-z_][A-Za-z0-9_]*. The secret value will be omitted.`,
          });
          continue;
        }
        val = `\${${varName}}`;
      } else {
        diagnostics?.push({
          level: "warn",
          message: `Secret node "${e.sourceNode}" has no name — the secret value will be omitted.`,
        });
        continue;
      }
    }

    const argKey = e.targetPort.slice(4); // strip "arg:" prefix
    if (!inlinedArgs.has(e.targetNode)) inlinedArgs.set(e.targetNode, new Map());
    inlinedArgs.get(e.targetNode)!.set(argKey, val);
  }

  // ── Process arg-to-arg edges ──────────────────────────────────────
  // When a non-control node's argout:<key> port is wired to another
  // non-control node's arg:<key> port, copy the source arg value into
  // the target's args and record the edge for round-tripping.
  const argWires: PipelineArgWire[] = [];
  const argWireDeps = new Map<string, Set<string>>();

  for (const e of graph.edges) {
    if (controlNodeIds.has(e.sourceNode) || controlNodeIds.has(e.targetNode)) continue;
    if (!e.sourcePort.startsWith("argout:") || !e.targetPort.startsWith("arg:")) continue;

    const srcNode = nodeMap.get(e.sourceNode);
    if (!srcNode) continue;

    const srcArgKey = e.sourcePort.slice(7); // strip "argout:"
    const tgtArgKey = e.targetPort.slice(4); // strip "arg:"
    const val = srcNode.argValues[srcArgKey];

    if (val !== undefined && val !== "") {
      if (!inlinedArgs.has(e.targetNode)) inlinedArgs.set(e.targetNode, new Map());
      inlinedArgs.get(e.targetNode)!.set(tgtArgKey, val);
    }

    // Record dependency
    if (!argWireDeps.has(e.targetNode)) argWireDeps.set(e.targetNode, new Set());
    argWireDeps.get(e.targetNode)!.add(e.sourceNode);

    argWires.push({
      sourceNode: e.sourceNode,
      sourceArgKey: srcArgKey,
      targetNode: e.targetNode,
      targetArgKey: tgtArgKey,
    });
  }

  // ── Derive transitive dependencies through control nodes ────────
  // When step A → control node → step B, step B should depend on step A.
  // Build a map: control node ID → set of non-control source step IDs feeding into it.
  const controlInputSteps = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!controlNodeIds.has(e.targetNode)) continue;
    if (controlNodeIds.has(e.sourceNode)) continue; // skip control→control
    if (!controlInputSteps.has(e.targetNode)) controlInputSteps.set(e.targetNode, new Set());
    controlInputSteps.get(e.targetNode)!.add(e.sourceNode);
  }

  // Collect transitive edges: for each control→step edge, add dependencies
  // from the control node's upstream steps to the downstream step.
  const transitiveDeps = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!controlNodeIds.has(e.sourceNode)) continue;
    if (controlNodeIds.has(e.targetNode)) continue; // skip control→control
    const upstreamSteps = controlInputSteps.get(e.sourceNode);
    if (!upstreamSteps || upstreamSteps.size === 0) continue;
    if (!transitiveDeps.has(e.targetNode)) transitiveDeps.set(e.targetNode, new Set());
    for (const dep of upstreamSteps) {
      transitiveDeps.get(e.targetNode)!.add(dep);
    }
  }

  // Filter out control-node edges and arg-wire edges from the graph for topo sort
  // and depends_on.  Arg-wire edges (argout:→arg:) are value-wiring, not data-flow;
  // their dependencies are injected separately via argWireDeps.
  const nonControlEdges = graph.edges.filter(
    (e) => !controlNodeIds.has(e.sourceNode) && !controlNodeIds.has(e.targetNode)
      && !(e.sourcePort.startsWith("argout:") && e.targetPort.startsWith("arg:")),
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

  // Inject transitive dependencies from control nodes (step A → cond/loop → step B)
  for (const [targetId, deps] of transitiveDeps) {
    if (!parentMap.has(targetId)) continue;
    const existing = new Set(parentMap.get(targetId));
    for (const dep of deps) {
      if (!existing.has(dep) && inDegree.has(dep)) {
        parentMap.get(targetId)!.push(dep);
        children.get(dep)!.push(targetId);
        inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
      }
    }
  }

  // Inject arg-wire dependencies (step A's arg → step B's arg creates A→B dep)
  for (const [targetId, deps] of argWireDeps) {
    if (!parentMap.has(targetId)) continue;
    const existing = new Set(parentMap.get(targetId));
    for (const dep of deps) {
      if (!existing.has(dep) && inDegree.has(dep)) {
        parentMap.get(targetId)!.push(dep);
        children.get(dep)!.push(targetId);
        inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
      }
    }
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
      .map((e) => {
        const edge: { targetNode: string; targetPort: string; sourcePort?: string } = {
          targetNode: e.targetNode,
          targetPort: e.targetPort,
        };
        if (e.sourcePort) edge.sourcePort = e.sourcePort;
        return edge;
      });
    // Strip plaintext secret values from the YAML — only keep the variable name
    const ctrlArgs = { ...n.argValues };
    if (n.stageCommand === "control/secret") {
      delete ctrlArgs.value;
    }

    // Collect incoming edges for control nodes that receive data (e.g. Extract)
    const ctrlInputEdges = graph.edges
      .filter((e) => e.targetNode === n.id && !controlNodeIds.has(e.sourceNode))
      .map((e) => {
        const ie: { sourceNode: string; sourcePort: string; targetPort?: string } = {
          sourceNode: e.sourceNode,
          sourcePort: e.sourcePort,
        };
        if (e.targetPort) ie.targetPort = e.targetPort;
        return ie;
      });

    const ctrl: PipelineControl = {
      id: n.id,
      stageCommand: n.stageCommand,
      argValues: ctrlArgs,
      edges: ctrlEdges,
    };
    if (ctrlInputEdges.length > 0) ctrl.inputEdges = ctrlInputEdges;
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
  if (argWires.length > 0) result._argWires = argWires;
  return result;
}
