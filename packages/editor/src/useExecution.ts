import { useCallback, useRef, useState } from "react";
import type {
  Graph,
  StageDef,
  NodeRunState,
  RunStepRequest,
} from "@zyra/core";
import { emptyRunState, graphToRunRequests, graphToPipeline, stepToCliPreview } from "@zyra/core";
import { postRun, getJobStatus, connectJobWs, cancelJob } from "./api";

export type RunStateMap = Map<string, NodeRunState>;

export interface ExecutionControls {
  /** Per-node execution state keyed by node id. */
  runState: RunStateMap;
  /** True while a run or dry-run is in progress. */
  running: boolean;
  /** Dry-run: resolve argv for every step without executing. */
  dryRun: (graph: Graph, stages: StageDef[]) => Promise<void>;
  /** Execute the full pipeline (async, with log streaming). */
  runPipeline: (graph: Graph, stages: StageDef[]) => Promise<void>;
  /** Run a single node by id. Returns an error string if deps are unmet. */
  runSingleNode: (nodeId: string, graph: Graph, stages: StageDef[]) => Promise<string | null>;
  /** Cancel all running jobs and stop the pipeline. */
  cancelAll: () => void;
  /** Clear all execution state. */
  reset: () => void;
}

/** Max consecutive poll failures before marking a node as failed. */
const MAX_POLL_FAILURES = 20;

export function useExecution(): ExecutionControls {
  const [runState, setRunState] = useState<RunStateMap>(new Map());
  const [running, setRunning] = useState(false);
  const cancelledRef = useRef(false);
  const runGenRef = useRef(0); // generation counter to detect stale runs
  const activeJobsRef = useRef<Map<string, string>>(new Map()); // nodeId → jobId
  const wsRefs = useRef<WebSocket[]>([]);

  const updateNode = useCallback(
    (nodeId: string, patch: Partial<NodeRunState>) => {
      setRunState((prev) => {
        const next = new Map(prev);
        const cur = next.get(nodeId) ?? emptyRunState();
        next.set(nodeId, { ...cur, ...patch });
        return next;
      });
    },
    [],
  );

  // ── Dry run ────────────────────────────────────────────────────

  const dryRun = useCallback(
    async (graph: Graph, stages: StageDef[]) => {
      setRunning(true);
      cancelledRef.current = false;
      const gen = ++runGenRef.current;

      try {
        const pipeline = graphToPipeline(graph, stages);

        // Build CLI preview strings client-side (individual stages
        // don't support --dry-run, only the pipeline runner does)
        const result = new Map<string, NodeRunState>();
        for (const step of pipeline.steps) {
          result.set(step.name, {
            ...emptyRunState(),
            status: "dry-run",
            dryRunArgv: stepToCliPreview(step),
          });
        }
        setRunState(result);
      } finally {
        if (runGenRef.current === gen) setRunning(false);
      }
    },
    [],
  );

  // ── Single-node run ──────────────────────────────────────────

  const runSingleNode = useCallback(
    async (nodeId: string, graph: Graph, stages: StageDef[]): Promise<string | null> => {
      const { requests, pipeline } = graphToRunRequests(graph, stages);
      const stepIndex = pipeline.steps.findIndex((s) => s.name === nodeId);
      if (stepIndex === -1) return `Node "${nodeId}" not found in pipeline`;

      const step = pipeline.steps[stepIndex];
      const deps = step.depends_on ?? [];

      // Check that all upstream dependencies have succeeded
      if (deps.length > 0) {
        const unmet: string[] = [];
        for (const dep of deps) {
          const depState = runState.get(dep);
          if (!depState || depState.status !== "succeeded") {
            unmet.push(dep);
          }
        }
        if (unmet.length > 0) {
          return `Cannot run "${nodeId}" — upstream dependencies not yet succeeded: ${unmet.join(", ")}`;
        }
      }

      setRunning(true);
      cancelledRef.current = false;
      const gen = ++runGenRef.current;

      updateNode(nodeId, { ...emptyRunState(), status: "running" });

      try {
        const req = requests[stepIndex];
        const res = await postRun(req);

        if (res.status === "error") {
          updateNode(nodeId, {
            status: "failed",
            stdout: res.stdout ?? "",
            stderr: res.stderr ?? "",
            exitCode: res.exit_code,
          });
          return null;
        }

        const jobId = res.job_id;
        if (!jobId) {
          const exitOk = (res.exit_code ?? 0) === 0;
          updateNode(nodeId, {
            status: exitOk ? "succeeded" : "failed",
            stdout: res.stdout ?? "",
            stderr: res.stderr ?? "",
            exitCode: res.exit_code,
          });
          return null;
        }

        activeJobsRef.current.set(nodeId, jobId);
        updateNode(nodeId, { jobId });

        // Poll until done (simpler than full pipeline WS logic)
        let consecutiveFailures = 0;
        while (!cancelledRef.current && runGenRef.current === gen) {
          try {
            const status = await getJobStatus(jobId);
            consecutiveFailures = 0;
            updateNode(nodeId, {
              stdout: status.stdout ?? "",
              stderr: status.stderr ?? "",
              exitCode: status.exit_code,
            });
            if (
              status.status === "succeeded" ||
              status.status === "failed" ||
              status.status === "canceled"
            ) {
              updateNode(nodeId, { status: status.status });
              break;
            }
          } catch {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_POLL_FAILURES) {
              updateNode(nodeId, {
                status: "failed",
                stderr: `Lost connection to job ${jobId}`,
              });
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        updateNode(nodeId, {
          status: "failed",
          stderr: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (runGenRef.current === gen) setRunning(false);
      }
      return null;
    },
    [runState, updateNode],
  );

  // ── Full pipeline run ──────────────────────────────────────────

  const runPipeline = useCallback(
    async (graph: Graph, stages: StageDef[]) => {
      setRunning(true);
      cancelledRef.current = false;
      const gen = ++runGenRef.current;
      activeJobsRef.current = new Map();
      wsRefs.current = [];

      try {
        const { requests, pipeline } = graphToRunRequests(graph, stages);

        // Build dependency map: nodeId → set of nodeIds it depends on
        const deps = new Map<string, string[]>();
        for (const step of pipeline.steps) {
          deps.set(step.name, step.depends_on ?? []);
        }

        // Initialise all nodes as queued
        const init = new Map<string, NodeRunState>();
        for (const step of pipeline.steps) {
          init.set(step.name, { ...emptyRunState(), status: "queued" });
        }
        setRunState(init);

        // Track resolved status locally (state updates are async)
        const resolved = new Map<string, "succeeded" | "failed" | "canceled">();

        /** Wait until all dependencies of a node are resolved. */
        function waitForDeps(nodeId: string): Promise<boolean> {
          return new Promise((resolve) => {
            const check = () => {
              if (cancelledRef.current || runGenRef.current !== gen) {
                resolve(false);
                return;
              }
              const nodeDeps = deps.get(nodeId) ?? [];
              const allDone = nodeDeps.every((d) => resolved.has(d));
              if (!allDone) {
                setTimeout(check, 250);
                return;
              }
              const allOk = nodeDeps.every((d) => resolved.get(d) === "succeeded");
              resolve(allOk);
            };
            check();
          });
        }

        /** Run a single step: submit, stream logs, wait for completion. */
        async function runStep(
          nodeId: string,
          req: RunStepRequest,
        ): Promise<void> {
          const depsOk = await waitForDeps(nodeId);
          if (!depsOk || cancelledRef.current || runGenRef.current !== gen) {
            updateNode(nodeId, { status: "canceled" });
            resolved.set(nodeId, "canceled");
            return;
          }

          updateNode(nodeId, { status: "running" });

          try {
            const res = await postRun(req);

            if (res.status === "error") {
              updateNode(nodeId, {
                status: "failed",
                stdout: res.stdout ?? "",
                stderr: res.stderr ?? "",
                exitCode: res.exit_code,
              });
              resolved.set(nodeId, "failed");
              return;
            }

            const jobId = res.job_id;
            if (!jobId) {
              // Sync fallback — already completed
              const exitOk = (res.exit_code ?? 0) === 0;
              updateNode(nodeId, {
                status: exitOk ? "succeeded" : "failed",
                stdout: res.stdout ?? "",
                stderr: res.stderr ?? "",
                exitCode: res.exit_code,
              });
              resolved.set(nodeId, exitOk ? "succeeded" : "failed");
              return;
            }

            activeJobsRef.current.set(nodeId, jobId);
            updateNode(nodeId, { jobId });

            // Stream logs via WebSocket
            await new Promise<void>((resolve) => {
              const ws = connectJobWs(jobId, ["stdout", "stderr", "progress"]);
              wsRefs.current.push(ws);

              ws.onmessage = (ev) => {
                try {
                  const msg = JSON.parse(ev.data);
                  const stdoutChunk = msg.params?.stdout ?? "";
                  const stderrChunk = msg.params?.stderr ?? "";
                  if (stdoutChunk || stderrChunk) {
                    setRunState((prev) => {
                      const next = new Map(prev);
                      const cur = next.get(nodeId) ?? emptyRunState();
                      next.set(nodeId, {
                        ...cur,
                        stdout: cur.stdout + stdoutChunk,
                        stderr: cur.stderr + stderrChunk,
                      });
                      return next;
                    });
                  }
                  if (
                    msg.params?.status === "succeeded" ||
                    msg.params?.status === "failed" ||
                    msg.params?.status === "canceled"
                  ) {
                    updateNode(nodeId, {
                      status: msg.params.status,
                      exitCode: msg.params.exit_code,
                    });
                    resolved.set(nodeId, msg.params.status);
                    ws.close();
                    resolve();
                  }
                } catch {
                  // ignore malformed messages
                }
              };

              let fallbackStarted = false;
              const startPollingFallback = () => {
                if (fallbackStarted || resolved.has(nodeId)) return;
                fallbackStarted = true;
                pollUntilDone(nodeId, jobId).then(resolve);
              };

              ws.onerror = () => {
                ws.close();
                startPollingFallback();
              };

              ws.onclose = () => {
                startPollingFallback();
              };
            });
          } catch (err) {
            updateNode(nodeId, {
              status: "failed",
              stderr: err instanceof Error ? err.message : String(err),
            });
            resolved.set(nodeId, "failed");
          }
        }

        /** Poll job status until terminal state. */
        async function pollUntilDone(nodeId: string, jobId: string) {
          let consecutiveFailures = 0;
          while (!cancelledRef.current && runGenRef.current === gen) {
            try {
              const status = await getJobStatus(jobId);
              consecutiveFailures = 0;
              updateNode(nodeId, {
                stdout: status.stdout ?? "",
                stderr: status.stderr ?? "",
                exitCode: status.exit_code,
              });
              if (
                status.status === "succeeded" ||
                status.status === "failed" ||
                status.status === "canceled"
              ) {
                updateNode(nodeId, { status: status.status });
                resolved.set(nodeId, status.status);
                return;
              }
            } catch {
              consecutiveFailures++;
              if (consecutiveFailures >= MAX_POLL_FAILURES) {
                updateNode(nodeId, {
                  status: "failed",
                  stderr: `Lost connection to job ${jobId} after ${MAX_POLL_FAILURES} failed status checks`,
                });
                resolved.set(nodeId, "failed");
                return;
              }
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        // Launch all steps — they each wait for their deps internally
        const promises = pipeline.steps.map((step, i) =>
          runStep(step.name, requests[i]),
        );
        await Promise.all(promises);
      } finally {
        if (runGenRef.current === gen) setRunning(false);
      }
    },
    [updateNode],
  );

  // ── Cancel ─────────────────────────────────────────────────────

  const cancelAll = useCallback(() => {
    cancelledRef.current = true;
    runGenRef.current++;
    for (const ws of wsRefs.current) {
      try { ws.close(); } catch { /* ignore */ }
    }
    wsRefs.current = [];

    for (const [nodeId, jobId] of activeJobsRef.current) {
      cancelJob(jobId).catch(() => {});
      updateNode(nodeId, { status: "canceled" });
    }
    activeJobsRef.current = new Map();
    setRunning(false);
  }, [updateNode]);

  // ── Reset ──────────────────────────────────────────────────────

  const reset = useCallback(() => {
    cancelledRef.current = true;
    runGenRef.current++;
    for (const ws of wsRefs.current) {
      try { ws.close(); } catch { /* ignore */ }
    }
    wsRefs.current = [];

    for (const [, jobId] of activeJobsRef.current) {
      cancelJob(jobId).catch(() => {});
    }
    activeJobsRef.current = new Map();
    setRunState(new Map());
    setRunning(false);
  }, []);

  return { runState, running, dryRun, runPipeline, runSingleNode, cancelAll, reset };
}
