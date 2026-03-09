import { getEffectivePorts, type StageDef, type ArgDef } from "./manifest.js";
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

      // Pick port IDs that will actually be rendered by the node component.
      // getEffectivePorts computes the full list (explicit + arg-ports +
      // implicit stdout/stderr/exitcode), so the chosen IDs always match a
      // rendered handle — making dependency edges visible on the canvas.
      const srcPorts = source.stage ? getEffectivePorts(source.stage) : null;
      const tgtPorts = target.stage ? getEffectivePorts(target.stage) : null;
      const sourcePort = srcPorts?.outputs[0]?.id ?? "out";
      const targetPort = tgtPorts?.inputs[0]?.id ?? "in";

      edges.push({
        sourceNode: depName,
        sourcePort,
        targetNode: step.name,
        targetPort,
      });
    }
  }

  // Collect all existing node IDs for deduplication of generated control nodes.
  const existingIds = new Set(nodes.map((n) => n.id));

  /**
   * Find the first explicit (non-arg:*) input port for a stage.
   * Falls back to the first effective input (even arg:*) or "in".
   */
  function firstExplicitInputPort(stage: StageDef | undefined): string {
    if (!stage) return "in";
    const effective = getEffectivePorts(stage);
    const explicit = effective.inputs.find((p) => !p.id.startsWith("arg:"));
    return explicit?.id ?? effective.inputs[0]?.id ?? "in";
  }

  /** Generate a unique ID with the given prefix, avoiding collisions. */
  function uniqueId(prefix: string): string {
    let id = prefix;
    let i = 0;
    while (existingIds.has(id)) {
      id = `${prefix}_${++i}`;
    }
    existingIds.add(id);
    return id;
  }

  // Reconstruct a cron control node from pipeline.schedule if there
  // is no matching control node already in _controls (i.e., imported YAML).
  const hasCronControl = pipeline._controls?.some(
    (c) => c.stageCommand === "control/cron",
  );
  if (pipeline.schedule && !hasCronControl) {
    const cronId = uniqueId("_cron");
    const cronArgs: Record<string, string | number | boolean> = {
      expression: pipeline.schedule.cron,
    };
    if (pipeline.schedule.timezone) cronArgs.timezone = pipeline.schedule.timezone;
    if (pipeline.schedule.enabled !== undefined) cronArgs.enabled = pipeline.schedule.enabled;
    nodes.push({
      id: cronId,
      stageCommand: "control/cron",
      argValues: cronArgs,
    });
  }

  // Build a set of step names that already have a matching control node
  // wired from _controls, so we only reconstruct missing ones per-step.
  const stepsWithDelayControl = new Set<string>();
  const stepsWithCondControl = new Set<string>();
  const stepsWithLoopControl = new Set<string>();
  if (pipeline._controls) {
    for (const ctrl of pipeline._controls) {
      for (const ce of ctrl.edges) {
        if (ctrl.stageCommand === "control/delay") stepsWithDelayControl.add(ce.targetNode);
        if (ctrl.stageCommand === "control/conditional") stepsWithCondControl.add(ce.targetNode);
        if (ctrl.stageCommand === "control/loop") stepsWithLoopControl.add(ce.targetNode);
      }
    }
  }

  // Reconstruct delay control nodes from steps with delay_seconds
  // when no matching delay control already targets this step.
  for (const step of pipeline.steps) {
    if (step.delay_seconds == null || step.delay_seconds <= 0) continue;
    if (stepsWithDelayControl.has(step.name)) continue;
    let duration = step.delay_seconds;
    let unit: string = "seconds";
    if (duration >= 3600 && duration % 3600 === 0) {
      duration = duration / 3600;
      unit = "hours";
    } else if (duration >= 60 && duration % 60 === 0) {
      duration = duration / 60;
      unit = "minutes";
    }
    const delayId = uniqueId(`_delay_${step.name}`);
    nodes.push({
      id: delayId,
      stageCommand: "control/delay",
      argValues: { duration, unit },
    });
    // Wire the delay node to the target step's first explicit input port
    // (not arg:*, which would make the arg appear linked/readonly in the editor).
    const targetInfo = nodeMap.get(step.name);
    if (targetInfo) {
      edges.push({
        sourceNode: delayId,
        sourcePort: "delay",
        targetNode: step.name,
        targetPort: firstExplicitInputPort(targetInfo.stage),
      });
    }
  }

  // Reconstruct conditional control nodes from steps with condition
  // when no matching conditional control already targets this step.
  // Group steps by their condition signature (field+operator+value) to
  // reconstruct a single conditional node per unique condition.
  const condGroups = new Map<string, { condition: NonNullable<(typeof pipeline.steps)[0]["condition"]>; steps: string[] }>();
  for (const step of pipeline.steps) {
    if (!step.condition) continue;
    if (stepsWithCondControl.has(step.name)) continue;
    const key = `${step.condition.field}|${step.condition.operator}|${step.condition.value}`;
    if (!condGroups.has(key)) {
      condGroups.set(key, { condition: step.condition, steps: [] });
    }
    condGroups.get(key)!.steps.push(step.name);
  }
  // Precompute step name → condition for O(1) lookup during edge wiring
  const stepCondMap = new Map(
    pipeline.steps.filter((s) => s.condition).map((s) => [s.name, s.condition!]),
  );

  let condIdx = 0;
  for (const [, group] of condGroups) {
    const condId = uniqueId(`_cond_${condIdx++}`);
    nodes.push({
      id: condId,
      stageCommand: "control/conditional",
      argValues: {
        field: group.condition.field,
        operator: group.condition.operator,
        compare_value: group.condition.value,
      },
    });
    // Wire the conditional's true/false ports to the downstream steps
    for (const stepName of group.steps) {
      const stepCond = stepCondMap.get(stepName);
      if (!stepCond) continue;
      const targetInfo = nodeMap.get(stepName);
      edges.push({
        sourceNode: condId,
        sourcePort: stepCond.branch,
        targetNode: stepName,
        targetPort: firstExplicitInputPort(targetInfo?.stage),
      });
    }
  }

  // Reconstruct loop control nodes from steps with loop
  // when no matching loop control already targets this step.
  for (const step of pipeline.steps) {
    if (!step.loop) continue;
    if (stepsWithLoopControl.has(step.name)) continue;
    const loopId = uniqueId(`_loop_${step.name}`);
    const loopArgs: Record<string, string | number | boolean> = {
      mode: step.loop.mode,
    };
    if (step.loop.batch_size != null) loopArgs.batch_size = step.loop.batch_size;
    if (step.loop.range_start != null) loopArgs.range_start = step.loop.range_start;
    if (step.loop.range_end != null) loopArgs.range_end = step.loop.range_end;
    if (step.loop.range_step != null) loopArgs.range_step = step.loop.range_step;
    if (step.loop.max_parallel != null) loopArgs.max_parallel = step.loop.max_parallel;
    nodes.push({
      id: loopId,
      stageCommand: "control/loop",
      argValues: loopArgs,
    });
    // Wire loop's "item" output to the step's first explicit input port
    const targetInfo = nodeMap.get(step.name);
    edges.push({
      sourceNode: loopId,
      sourcePort: "item",
      targetNode: step.name,
      targetPort: firstExplicitInputPort(targetInfo?.stage),
    });
    // Wire the "over" source step's output to the loop's "items" input
    if (step.loop.over && nodeMap.has(step.loop.over)) {
      const overInfo = nodeMap.get(step.loop.over);
      const overEffective = overInfo?.stage ? getEffectivePorts(overInfo.stage) : null;
      const overPort = overEffective?.outputs[0]?.id ?? "out";
      edges.push({
        sourceNode: step.loop.over,
        sourcePort: overPort,
        targetNode: loopId,
        targetPort: "items",
      });
    }
  }

  // Reconstruct control nodes from _controls metadata.
  // First pass: add all control nodes so IDs are available for edge wiring.
  if (pipeline._controls) {
    for (const ctrl of pipeline._controls) {
      const ctrlArgs = { ...ctrl.argValues };

      // Secret nodes have their value stripped during serialization.
      // Set an empty value so the user is prompted to re-enter the secret.
      if (ctrl.stageCommand === "control/secret" && !("value" in ctrlArgs)) {
        ctrlArgs.value = "";
      }

      const node: GraphNode = {
        id: ctrl.id,
        label: ctrl.label,
        stageCommand: ctrl.stageCommand,
        argValues: ctrlArgs,
        position: ctrl._layout ? { x: ctrl._layout.x, y: ctrl._layout.y } : undefined,
        size:
          ctrl._layout && ctrl._layout.w != null && ctrl._layout.h != null
            ? { w: ctrl._layout.w, h: ctrl._layout.h }
            : undefined,
      };
      nodes.push(node);
    }
  }

  // Second pass: reconstruct edges from control nodes.
  // All node IDs (steps + control nodes) are now available.
  const allNodeIds = new Set(nodes.map((n) => n.id));
  if (pipeline._controls) {
    for (const ctrl of pipeline._controls) {
      const stage = findStage(ctrl.stageCommand) ?? byKey.get(ctrl.stageCommand);
      const defaultSourcePort = stage?.outputs[0]?.id ?? "value";
      for (const ce of ctrl.edges) {
        if (!allNodeIds.has(ce.targetNode)) continue;

        if (ce.targetPort.startsWith("arg:")) {
          // Validate that the target node's stage actually has this arg key
          const targetInfo = nodeMap.get(ce.targetNode);
          if (targetInfo?.stage) {
            const argKey = ce.targetPort.slice(4);
            const hasArg = targetInfo.stage.args.some((a) => a.key === argKey);
            if (!hasArg) continue; // skip edges to non-existent arg handles
          }
        }

        edges.push({
          sourceNode: ctrl.id,
          sourcePort: ce.sourcePort ?? defaultSourcePort,
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
