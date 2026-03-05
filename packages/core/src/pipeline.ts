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

  // Keys that only the pipeline runner understands — individual stage CLIs
  // will reject these as unrecognized flags so we strip them before submission.
  const PIPELINE_RUNNER_ONLY_KEYS = new Set(["period", "dry_run"]);

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

    // Pass through all args except pipeline-runner-only keys that individual
    // stage CLIs don't understand.  The server-side executor handles positional
    // arg mapping, so positional args like "path" must NOT be stripped.
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.args)) {
      if (!PIPELINE_RUNNER_ONLY_KEYS.has(k)) {
        args[k] = v;
      }
    }
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
 * Build a human-readable CLI preview string for a pipeline step.
 * This mirrors the server-side `_args_dict_to_argv` logic so the editor
 * can show what would run without actually calling the backend.
 */
export function stepToCliPreview(step: PipelineStep): string {
  const raw = step.command.replace(/^zyra\s+/, "");
  const parts = [raw];

  for (const [key, value] of Object.entries(step.args)) {
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
