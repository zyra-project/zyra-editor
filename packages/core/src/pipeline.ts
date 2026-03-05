import type { StageDef } from "./manifest.js";
import type { Graph, Pipeline } from "./serializer.js";
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

    const args: Record<string, unknown> = { ...step.args };
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
