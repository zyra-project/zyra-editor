import type { StageDef } from "./manifest.js";
import type { Graph, Pipeline, PipelineStep } from "./serializer.js";
import { graphToPipeline } from "./serializer.js";
import type { RunStepRequest } from "./execution.js";

export interface RunPlan {
  requests: RunStepRequest[];
  pipeline: Pipeline;
}

/**
 * Convert an editor graph into an ordered list of RunStepRequests
 * suitable for submission to `POST /v1/cli/run`, alongside the
 * computed pipeline (so callers don't need to call graphToPipeline
 * separately).
 *
 * When `dryRun` is true the `dry_run` arg is injected so Zyra resolves
 * argv without actually executing the stage.
 */
export function graphToRunRequests(
  graph: Graph,
  stages: StageDef[],
  options?: { dryRun?: boolean },
): RunPlan {
  const pipeline = graphToPipeline(graph, stages);

  const requests = pipeline.steps.map((step) => {
    const raw = step.command.replace(/^zyra\s+/, "");

    let stage: string;
    let command: string;

    if (!/\s/.test(raw) && raw.includes("/")) {
      const [stagePart, commandPart] = raw.split("/", 2);
      stage = stagePart;
      command = commandPart;
    } else {
      const [parsedStage, ...rest] = raw.split(/\s+/);
      stage = parsedStage;
      command = rest.join(" ") || stage;
    }

    const args = normalizeStepArgs(step.args);
    if (options?.dryRun) {
      args.dry_run = true;
    }

    return {
      stage,
      command,
      args,
      mode: options?.dryRun ? "sync" as const : "async" as const,
    };
  });

  return { requests, pipeline };
}

/**
 * Normalize step args for stage invocation — maps pipeline-runner-only
 * args to their CLI equivalents.  Used by both graphToRunRequests (for
 * execution) and stepToCliPreview (for display) so they stay in sync.
 */
function normalizeStepArgs(
  args: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "period") {
      // Map pipeline runner's "period" to the CLI's "since_period"
      out.since_period = v;
    } else if (k === "dry_run") {
      // Skip — only meaningful for the pipeline runner
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build a human-readable CLI preview string for a pipeline step.
 * This mirrors the server-side `_args_dict_to_argv` logic so the editor
 * can show what would run without actually calling the backend.
 */
export function stepToCliPreview(step: PipelineStep): string {
  const raw = step.command.replace(/^zyra\s+/, "");
  const parts = [raw];
  const args = normalizeStepArgs(step.args);

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === "") continue;
    const flag = `--${key.replace(/_/g, "-")}`;
    if (typeof value === "boolean") {
      if (value) parts.push(flag);
    } else {
      parts.push(flag, String(value));
    }
  }

  return `zyra ${parts.join(" ")}`;
}
