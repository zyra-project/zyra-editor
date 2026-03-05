import type { StageDef } from "./manifest.js";
import type { Graph } from "./serializer.js";
import { graphToPipeline } from "./serializer.js";
import type { RunStepRequest } from "./execution.js";

/**
 * Convert an editor graph into an ordered list of RunStepRequests
 * suitable for submission to `POST /v1/cli/run`.
 *
 * When `dryRun` is true the `dry_run` arg is injected so Zyra resolves
 * argv without actually executing the stage.
 */
export function graphToRunRequests(
  graph: Graph,
  stages: StageDef[],
  options?: { dryRun?: boolean },
): RunStepRequest[] {
  const pipeline = graphToPipeline(graph, stages);

  return pipeline.steps.map((step) => {
    const [stage, ...rest] = step.command.replace(/^zyra\s+/, "").split(/\s+/);
    const command = rest.join(" ") || stage;

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
}
