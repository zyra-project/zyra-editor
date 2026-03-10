import type { Node, Edge } from "@xyflow/react";
import type { Manifest, StageDef, ArgDef } from "@zyra/core";
import type { ZyraNodeData } from "./ZyraNode";

/** Shape of a single agent returned by `zyra plan`. */
export interface PlanAgent {
  id: string;
  stage: string;
  command: string;
  depends_on: string[];
  args: Record<string, string>;
}

/** Shape of a value-engine suggestion. */
export interface PlanSuggestion {
  stage: string;
  description: string;
  confidence: number;
  origin: "heuristic" | "bundle" | "llm";
  intent_text?: string;
  agent_template?: PlanAgent;
}

/** Full response from `POST /v1/plan`. */
export interface PlanResponse {
  intent: string;
  agents: PlanAgent[];
  plan_summary: string;
  suggestions: PlanSuggestion[];
  accepted_suggestions?: string[];
}

/** Fallback StageDef for commands not in the manifest. */
function placeholderStage(stage: string, command: string): StageDef {
  return {
    stage,
    command,
    label: `${stage} ${command}`.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    cli: `zyra ${stage} ${command}`,
    status: "planned",
    color: "#6e7681",
    inputs: [{ id: "in", label: "input", types: ["any"] }],
    outputs: [{ id: "out", label: "output", types: ["any"] }],
    args: [],
  };
}

const NODE_W = 260;
const NODE_H = 180;
const PAD_X = 80;
const PAD_Y = 40;

/**
 * Convert an array of plan agents into React Flow nodes and edges.
 *
 * Uses a simple left-to-right topological layout.
 */
export function planToGraph(
  agents: PlanAgent[],
  manifest: Manifest,
): { nodes: Node[]; edges: Edge[] } {
  const stageMap = new Map<string, StageDef>(
    manifest.stages.map((s: StageDef) => [`${s.stage}/${s.command}`, s]),
  );

  // Namespace agent IDs to avoid collisions when applying multiple plans
  const ns = crypto.randomUUID().slice(0, 8);
  const nsId = (id: string) => `${ns}-${id}`;

  // Compute topological depth for layout
  const depthMap = new Map<string, number>();
  const agentById = new Map(agents.map((a) => [a.id, a]));

  function getDepth(id: string, visited: Set<string>): number {
    if (depthMap.has(id)) return depthMap.get(id)!;
    if (visited.has(id)) return 0; // cycle detected
    visited.add(id);
    try {
      const agent = agentById.get(id);
      if (!agent || agent.depends_on.length === 0) {
        depthMap.set(id, 0);
        return 0;
      }
      const d = Math.max(...agent.depends_on.map((dep) => getDepth(dep, visited))) + 1;
      depthMap.set(id, d);
      return d;
    } finally {
      visited.delete(id);
    }
  }
  for (const a of agents) getDepth(a.id, new Set());

  // Group agents by column (depth)
  const columns = new Map<number, PlanAgent[]>();
  for (const a of agents) {
    const d = depthMap.get(a.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(a);
  }

  // Assign positions
  const positions = new Map<string, { x: number; y: number }>();
  for (const col of Array.from(columns.keys()).sort((a, b) => a - b)) {
    const items = columns.get(col)!;
    const x = PAD_X + col * (NODE_W + PAD_X);
    const totalH = items.length * NODE_H + (items.length - 1) * PAD_Y;
    const startY = Math.max(PAD_Y, (600 - totalH) / 2);
    items.forEach((a, row) => {
      positions.set(nsId(a.id), { x, y: startY + row * (NODE_H + PAD_Y) });
    });
  }

  // Build nodes
  const nodes: Node[] = agents.map((a) => {
    const key = `${a.stage}/${a.command}`;
    const stageDef = stageMap.get(key) ?? placeholderStage(a.stage, a.command);
    // Map plan args (flag-style keys) to ArgDef keys
    const argValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.args)) {
      // Try matching by key directly
      const byKey = stageDef.args.find((ad: ArgDef) => ad.key === k);
      if (byKey) {
        argValues[byKey.key] = v;
        continue;
      }
      // Try matching by flag (--flag or -f)
      const byFlag = stageDef.args.find(
        (ad: ArgDef) => ad.flag === k || ad.flag === `--${k}` || ad.flag === `-${k}`,
      );
      if (byFlag) {
        argValues[byFlag.key] = v;
        continue;
      }
      // Case-insensitive key/label match (clarification answers may differ in casing)
      const kLower = k.toLowerCase();
      const byLower = stageDef.args.find(
        (ad: ArgDef) =>
          ad.key.toLowerCase() === kLower ||
          (ad.flag && ad.flag.replace(/^-+/, "").toLowerCase() === kLower),
      );
      if (byLower) {
        argValues[byLower.key] = v;
        continue;
      }
      // Fallback: use raw key
      argValues[k] = v;
    }

    return {
      id: nsId(a.id),
      type: "zyra",
      position: positions.get(nsId(a.id)) ?? { x: 80, y: 80 },
      data: {
        stageDef,
        argValues,
      } satisfies ZyraNodeData,
    };
  });

  // Build a map for O(1) node lookup by id
  const nodesById = new Map(nodes.map((n) => [n.id, n] as const));

  // Build edges from depends_on (unique prefix avoids ID collisions across plans)
  const edges: Edge[] = [];
  const edgePrefix = `e-plan-${crypto.randomUUID()}-`;
  let edgeIdx = 0;
  for (const a of agents) {
    for (const dep of a.depends_on) {
      const srcNode = nodesById.get(nsId(dep));
      const tgtNode = nodesById.get(nsId(a.id));
      if (!srcNode || !tgtNode) continue;
      const srcDef = (srcNode.data as ZyraNodeData).stageDef;
      const tgtDef = (tgtNode.data as ZyraNodeData).stageDef;
      const sourceHandle = srcDef.outputs[0]?.id ?? "file";
      const targetHandle = tgtDef.inputs[0]?.id ?? "file";
      edges.push({
        id: `${edgePrefix}${edgeIdx++}`,
        source: nsId(dep),
        sourceHandle,
        target: nsId(a.id),
        targetHandle,
        type: "smoothstep",
        style: { stroke: "var(--accent-blue)", strokeWidth: 2 },
      });
    }
  }

  return { nodes, edges };
}
