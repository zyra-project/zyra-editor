import { useCallback, useRef, useState } from "react";
import type {
  Graph,
  StageDef,
  NodeRunState,
  RunStepRequest,
} from "@zyra/core";
import { emptyRunState, graphToRunRequests, graphToPipeline } from "@zyra/core";
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
  /** Cancel all running jobs and stop the pipeline. */
  cancelAll: () => void;
  /** Clear all execution state. */
  reset: () => void;
}

export function useExecution(): ExecutionControls {
  const [runState, setRunState] = useState<RunStateMap>(new Map());
  const [running, setRunning] = useState(false);
  const cancelledRef = useRef(false);
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

      const requests = graphToRunRequests(graph, stages, { dryRun: true });
      const pipeline = graphToPipeline(graph, stages);

      // Initialise all nodes to dry-run state
      const init = new Map<string, NodeRunState>();
      for (const step of pipeline.steps) {
        init.set(step.name, { ...emptyRunState(), status: "dry-run" });
      }
      setRunState(init);

      for (let i = 0; i < requests.length; i++) {
        if (cancelledRef.current) break;
        const nodeId = pipeline.steps[i].name;
        try {
          const res = await postRun(requests[i]);
          updateNode(nodeId, {
            status: "dry-run",
            dryRunArgv: res.stdout?.trim() ?? "",
            stderr: res.stderr ?? "",
            exitCode: res.exit_code,
          });
        } catch (err) {
          updateNode(nodeId, {
            status: "failed",
            stderr: err instanceof Error ? err.message : String(err),
          });
        }
      }

      setRunning(false);
    },
    [updateNode],
  );

  // ── Full pipeline run ──────────────────────────────────────────

  const runPipeline = useCallback(
    async (graph: Graph, stages: StageDef[]) => {
      setRunning(true);
      cancelledRef.current = false;
      activeJobsRef.current = new Map();
      wsRefs.current = [];

      const requests = graphToRunRequests(graph, stages);
      const pipeline = graphToPipeline(graph, stages);

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
            if (cancelledRef.current) {
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
        if (!depsOk || cancelledRef.current) {
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
            updateNode(nodeId, {
              status: res.exit_code === 0 ? "succeeded" : "failed",
              stdout: res.stdout ?? "",
              stderr: res.stderr ?? "",
              exitCode: res.exit_code,
            });
            resolved.set(nodeId, res.exit_code === 0 ? "succeeded" : "failed");
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
                if (msg.params?.stdout) {
                  setRunState((prev) => {
                    const next = new Map(prev);
                    const cur = next.get(nodeId) ?? emptyRunState();
                    next.set(nodeId, {
                      ...cur,
                      stdout: cur.stdout + msg.params.stdout,
                    });
                    return next;
                  });
                }
                if (msg.params?.stderr) {
                  setRunState((prev) => {
                    const next = new Map(prev);
                    const cur = next.get(nodeId) ?? emptyRunState();
                    next.set(nodeId, {
                      ...cur,
                      stderr: cur.stderr + msg.params.stderr,
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
        while (!cancelledRef.current) {
          try {
            const status = await getJobStatus(jobId);
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
            // retry
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // Launch all steps — they each wait for their deps internally
      const promises = pipeline.steps.map((step, i) =>
        runStep(step.name, requests[i]),
      );
      await Promise.all(promises);

      setRunning(false);
    },
    [updateNode],
  );

  // ── Cancel ─────────────────────────────────────────────────────

  const cancelAll = useCallback(() => {
    cancelledRef.current = true;
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

  return { runState, running, dryRun, runPipeline, cancelAll, reset };
}
