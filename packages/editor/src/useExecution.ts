import { useCallback, useRef, useState } from "react";
import type {
  Graph,
  GraphEdge,
  StageDef,
  PipelineStep,
  NodeRunState,
  RunStepRequest,
  RunEventType,
  RunEvent,
  GraphSnapshot,
} from "@zyra/core";
import { emptyRunState, extractByPath, graphToRunRequests, graphToPipeline, stepToCliPreview, buildRunRecord, computeCacheKey } from "@zyra/core";
import { postRun, getJobStatus, connectJobWs, cancelJob, saveRunHistory, lookupCache } from "./api";

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
  /** Clear execution state for a single node. */
  clearNode: (nodeId: string) => void;
  /** Mark a node to skip cache on the next run. */
  forceRerunNode: (nodeId: string) => void;
}

/** Max consecutive poll failures before marking a node as failed. */
const MAX_POLL_FAILURES = 20;

/**
 * Sleep in short intervals for `totalMs` milliseconds, checking for
 * cancellation between intervals.  Returns true if completed, false
 * if cancelled early.
 */
async function cancellableSleep(
  totalMs: number,
  isCancelled: () => boolean,
): Promise<boolean> {
  const pollMs = 200;
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (isCancelled()) return false;
    const remaining = totalMs - (Date.now() - start);
    await new Promise((r) => setTimeout(r, Math.min(remaining, pollMs)));
  }
  return true;
}

export function useExecution(
  getGraphSnapshot?: () => GraphSnapshot | undefined,
  useCache = false,
): ExecutionControls {
  const [runState, setRunState] = useState<RunStateMap>(new Map());
  const [running, setRunning] = useState(false);
  const cancelledRef = useRef(false);
  const runGenRef = useRef(0); // generation counter to detect stale runs
  const activeJobsRef = useRef<Map<string, string>>(new Map()); // nodeId → jobId
  const wsRefs = useRef<WebSocket[]>([]);
  const useCacheRef = useRef(useCache);
  useCacheRef.current = useCache;
  const forceRerunRef = useRef<Set<string>>(new Set());

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

  /** Append a structured event to a node's event timeline. */
  const emitEvent = useCallback(
    (nodeId: string, type: RunEventType, message?: string, detail?: Record<string, unknown>) => {
      const event: RunEvent = { type, timestamp: Date.now(), message, detail };
      setRunState((prev) => {
        const next = new Map(prev);
        const cur = next.get(nodeId) ?? emptyRunState();
        next.set(nodeId, { ...cur, events: [...cur.events, event] });
        return next;
      });
    },
    [],
  );

  /** Persist a completed run to the server (fire-and-forget). */
  const persistRun = useCallback(
    (mode: "pipeline" | "single-node") => {
      // Read the latest runState synchronously via the setter trick
      let snapshot: RunStateMap = new Map();
      setRunState((prev) => { snapshot = prev; return prev; });

      const record = buildRunRecord(snapshot, mode, getGraphSnapshot?.());
      if (!record) return;

      saveRunHistory(record).catch(() => {
        // Silently ignore — history is best-effort
      });
    },
    [getGraphSnapshot],
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
          let preview = stepToCliPreview(step);
          if (step.delay_seconds) {
            preview = `[delay ${step.delay_seconds}s] ${preview}`;
          }
          result.set(step.name, {
            ...emptyRunState(),
            status: "dry-run",
            dryRunArgv: preview,
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
      // Handle Extract nodes client-side (they aren't pipeline steps)
      const gNode = graph.nodes.find((n) => n.id === nodeId);
      if (gNode?.stageCommand === "control/extract") {
        const inputEdge = graph.edges.find(
          (e: GraphEdge) => e.targetNode === nodeId && e.targetPort === "input",
        );
        if (!inputEdge) return "No input connected to Extract node";
        const upState = runState.get(inputEdge.sourceNode);
        if (!upState || upState.status !== "succeeded") {
          return "Upstream node has not succeeded yet";
        }
        const expression = String(gNode.argValues.expression ?? "");
        const fallback = gNode.argValues.fallback !== undefined
          ? String(gNode.argValues.fallback) : undefined;
        const result = extractByPath(upState.stdout, expression, fallback);
        updateNode(nodeId, {
          ...emptyRunState(),
          status: "succeeded",
          stdout: result,
          stderr: "",
          exitCode: 0,
        });
        return null;
      }

      const { requests, pipeline } = graphToRunRequests(graph, stages);
      const stepIndex = pipeline.steps.findIndex((s: PipelineStep) => s.name === nodeId);
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

      // Use async mode with WebSocket streaming for live log output
      const req: RunStepRequest = { ...requests[stepIndex], mode: "async" };

      // ── Cache check (single-node) ─────────────────────────────
      if (useCacheRef.current && !forceRerunRef.current.has(nodeId)) {
        try {
          const cacheKey = await computeCacheKey(req);
          const cached = await lookupCache(cacheKey);
          if (cached.hit) {
            updateNode(nodeId, {
              ...emptyRunState(),
              status: "cached",
              stdout: cached.stdout ?? "",
              stderr: cached.stderr ?? "",
              exitCode: cached.exit_code ?? 0,
              submittedRequest: req,
              completedAt: Date.now(),
            });
            emitEvent(nodeId, "cache-hit", "Using cached result");
            return null;
          }
        } catch {
          // Cache lookup failed — proceed with normal execution
        }
      }
      forceRerunRef.current.delete(nodeId);

      // Respect delay/throttle for single-node runs (consistent with full pipeline runs)
      const delaySecs = step.delay_seconds;
      if (delaySecs && delaySecs > 0) {
        updateNode(nodeId, { ...emptyRunState(), status: "queued", submittedRequest: req });
        const completed = await cancellableSleep(
          delaySecs * 1000,
          () => cancelledRef.current || runGenRef.current !== gen,
        );
        if (!completed) {
          updateNode(nodeId, { status: "canceled" });
          setRunning(false);
          return null;
        }
      }

      const now = Date.now();
      updateNode(nodeId, { ...emptyRunState(), status: "running", submittedRequest: req, startedAt: now });
      emitEvent(nodeId, "submitted", `Submitted ${req.stage}/${req.command}`);

      try {
        const res = await postRun(req);

        if (res.status === "error") {
          const doneAt = Date.now();
          updateNode(nodeId, {
            status: "failed",
            stdout: res.stdout ?? "",
            stderr: res.stderr ?? "",
            exitCode: res.exit_code,
            completedAt: doneAt,
          });
          emitEvent(nodeId, "error", "Server returned error", { exit_code: res.exit_code });
          return null;
        }

        const jobId = res.job_id;
        if (!jobId) {
          // Sync fallback — server returned result directly
          const exitOk = (res.exit_code ?? 0) === 0;
          const doneAt = Date.now();
          updateNode(nodeId, {
            status: exitOk ? "succeeded" : "failed",
            stdout: res.stdout ?? "",
            stderr: res.stderr ?? "",
            exitCode: res.exit_code,
            completedAt: doneAt,
          });
          emitEvent(nodeId, "completed", exitOk ? "Completed successfully" : "Failed", { exit_code: res.exit_code });
          return null;
        }

        activeJobsRef.current.set(nodeId, jobId);
        updateNode(nodeId, { jobId });
        emitEvent(nodeId, "job-accepted", `Job ${jobId} accepted`, { jobId });

        // Stream logs via WebSocket
        await new Promise<void>((resolve) => {
          const ws = connectJobWs(jobId, ["stdout", "stderr", "progress"]);
          wsRefs.current.push(ws);
          let done = false;

          const removeWsRef = () => {
            const idx = wsRefs.current.indexOf(ws);
            if (idx !== -1) wsRefs.current.splice(idx, 1);
          };

          const appendStderr = (text: string) => {
            setRunState((prev) => {
              const next = new Map(prev);
              const cur = next.get(nodeId) ?? emptyRunState();
              next.set(nodeId, { ...cur, stderr: cur.stderr + text });
              return next;
            });
          };

          ws.onopen = () => {
            appendStderr("[ws] Connected to job stream\n");
            emitEvent(nodeId, "ws-connected", "WebSocket connected");
          };

          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data);
              // Skip keepalive frames
              if (msg.keepalive) return;

              const stdoutChunk = msg.stdout ?? msg.params?.stdout ?? "";
              const stderrChunk = msg.stderr ?? msg.params?.stderr ?? "";
              // Filter out the server's initial "listening" frame
              const isListeningFrame = stderrChunk === "listening" && !stdoutChunk;
              if (!isListeningFrame && (stdoutChunk || stderrChunk)) {
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
              // Log progress updates
              if (msg.progress !== undefined && msg.progress < 1.0) {
                appendStderr(`[ws] Progress: ${Math.round(msg.progress * 100)}%\n`);
              }
              // Check for terminal status
              const status = msg.status ?? msg.params?.status;
              const exitCode = msg.exit_code ?? msg.params?.exit_code;
              if (
                status === "succeeded" ||
                status === "failed" ||
                status === "canceled"
              ) {
                const doneAt = Date.now();
                updateNode(nodeId, { status, exitCode, completedAt: doneAt });
                emitEvent(nodeId, "completed", `Run ${status}`, { status, exit_code: exitCode });
                ws.close();
                done = true;
                resolve();
              } else if (exitCode !== undefined && !done) {
                // Final payload with exit_code but no explicit status
                const s = exitCode === 0 ? "succeeded" : "failed";
                const doneAt = Date.now();
                updateNode(nodeId, { status: s, exitCode, completedAt: doneAt });
                emitEvent(nodeId, "completed", `Run ${s}`, { status: s, exit_code: exitCode });
                ws.close();
                done = true;
                resolve();
              }
            } catch {
              // ignore malformed messages
            }
          };

          let fallbackStarted = false;
          const startPollingFallback = () => {
            if (fallbackStarted || done) return;
            if (cancelledRef.current || runGenRef.current !== gen) return;
            fallbackStarted = true;
            appendStderr("[ws] Connection closed, falling back to polling\n");
            emitEvent(nodeId, "poll-fallback", "Fell back to HTTP polling");
            (async () => {
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
                    const doneAt = Date.now();
                    updateNode(nodeId, { status: status.status, completedAt: doneAt });
                    emitEvent(nodeId, "completed", `Run ${status.status}`, { status: status.status, exit_code: status.exit_code });
                    resolve();
                    return;
                  }
                } catch {
                  consecutiveFailures++;
                  if (consecutiveFailures >= MAX_POLL_FAILURES) {
                    const doneAt = Date.now();
                    updateNode(nodeId, {
                      status: "failed",
                      stderr: `Lost connection to job ${jobId}\n`,
                      completedAt: doneAt,
                    });
                    emitEvent(nodeId, "error", `Lost connection after ${MAX_POLL_FAILURES} failures`);
                    resolve();
                    return;
                  }
                }
                await new Promise((r) => setTimeout(r, 1000));
              }
              resolve();
            })();
          };

          ws.onerror = () => {
            appendStderr("[ws] Connection error\n");
            ws.close();
          };
          ws.onclose = () => {
            removeWsRef();
            if (!done) emitEvent(nodeId, "ws-disconnected", "WebSocket disconnected");
            startPollingFallback();
          };
        });
      } catch (err) {
        const doneAt = Date.now();
        updateNode(nodeId, {
          status: "failed",
          stderr: err instanceof Error ? err.message : String(err),
          completedAt: doneAt,
        });
        emitEvent(nodeId, "error", err instanceof Error ? err.message : String(err));
      } finally {
        activeJobsRef.current.delete(nodeId);
        persistRun("single-node");
        if (runGenRef.current === gen) setRunning(false);
      }
      return null;
    },
    [runState, updateNode, emitEvent, persistRun],
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
          delaySecs?: number,
        ): Promise<void> {
          const depsOk = await waitForDeps(nodeId);
          if (!depsOk || cancelledRef.current || runGenRef.current !== gen) {
            updateNode(nodeId, { status: "canceled" });
            resolved.set(nodeId, "canceled");
            return;
          }

          // Respect delay/throttle before executing.
          if (delaySecs && delaySecs > 0) {
            updateNode(nodeId, { status: "queued", submittedRequest: req });
            const completed = await cancellableSleep(
              delaySecs * 1000,
              () => cancelledRef.current || runGenRef.current !== gen,
            );
            if (!completed) {
              updateNode(nodeId, { status: "canceled" });
              resolved.set(nodeId, "canceled");
              return;
            }
          }

          // Inject any values from upstream Extract nodes into this step's args
          const finalReq = injectExtractValues(nodeId, req, graph);

          // ── Cache check ────────────────────────────────────────
          if (useCacheRef.current && !forceRerunRef.current.has(nodeId)) {
            try {
              const cacheKey = await computeCacheKey(finalReq);
              const cached = await lookupCache(cacheKey);
              if (cached.hit) {
                updateNode(nodeId, {
                  status: "cached",
                  stdout: cached.stdout ?? "",
                  stderr: cached.stderr ?? "",
                  exitCode: cached.exit_code ?? 0,
                  submittedRequest: finalReq,
                  completedAt: Date.now(),
                });
                emitEvent(nodeId, "cache-hit", "Using cached result");
                resolved.set(nodeId, "succeeded");
                return;
              }
            } catch {
              // Cache lookup failed — proceed with normal execution
            }
          }

          const stepStartedAt = Date.now();
          updateNode(nodeId, { status: "running", submittedRequest: finalReq, startedAt: stepStartedAt });
          emitEvent(nodeId, "submitted", `Submitted ${finalReq.stage}/${finalReq.command}`);

          try {
            const res = await postRun(finalReq);

            if (res.status === "error") {
              const doneAt = Date.now();
              updateNode(nodeId, {
                status: "failed",
                stdout: res.stdout ?? "",
                stderr: res.stderr ?? "",
                exitCode: res.exit_code,
                completedAt: doneAt,
              });
              emitEvent(nodeId, "error", "Server returned error", { exit_code: res.exit_code });
              resolved.set(nodeId, "failed");
              return;
            }

            const jobId = res.job_id;
            if (!jobId) {
              // Sync fallback — already completed
              const exitOk = (res.exit_code ?? 0) === 0;
              const doneAt = Date.now();
              updateNode(nodeId, {
                status: exitOk ? "succeeded" : "failed",
                stdout: res.stdout ?? "",
                stderr: res.stderr ?? "",
                exitCode: res.exit_code,
                completedAt: doneAt,
              });
              emitEvent(nodeId, "completed", exitOk ? "Completed successfully" : "Failed", { exit_code: res.exit_code });
              resolved.set(nodeId, exitOk ? "succeeded" : "failed");
              return;
            }

            activeJobsRef.current.set(nodeId, jobId);
            updateNode(nodeId, { jobId });
            emitEvent(nodeId, "job-accepted", `Job ${jobId} accepted`, { jobId });

            // Stream logs via WebSocket
            await new Promise<void>((resolve) => {
              const ws = connectJobWs(jobId, ["stdout", "stderr", "progress"]);
              wsRefs.current.push(ws);

              const removeWsRef = () => {
                const idx = wsRefs.current.indexOf(ws);
                if (idx !== -1) wsRefs.current.splice(idx, 1);
              };

              ws.onopen = () => {
                emitEvent(nodeId, "ws-connected", "WebSocket connected");
              };

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
                    const doneAt = Date.now();
                    updateNode(nodeId, {
                      status: msg.params.status,
                      exitCode: msg.params.exit_code,
                      completedAt: doneAt,
                    });
                    emitEvent(nodeId, "completed", `Run ${msg.params.status}`, { status: msg.params.status, exit_code: msg.params.exit_code });
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
                emitEvent(nodeId, "poll-fallback", "Fell back to HTTP polling");
                pollUntilDone(nodeId, jobId).then(resolve);
              };

              ws.onerror = () => {
                ws.close();
              };

              ws.onclose = () => {
                removeWsRef();
                if (!resolved.has(nodeId)) emitEvent(nodeId, "ws-disconnected", "WebSocket disconnected");
                startPollingFallback();
              };
            });
          } catch (err) {
            const doneAt = Date.now();
            updateNode(nodeId, {
              status: "failed",
              stderr: err instanceof Error ? err.message : String(err),
              completedAt: doneAt,
            });
            emitEvent(nodeId, "error", err instanceof Error ? err.message : String(err));
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
                const doneAt = Date.now();
                updateNode(nodeId, { status: status.status, completedAt: doneAt });
                emitEvent(nodeId, "completed", `Run ${status.status}`, { status: status.status, exit_code: status.exit_code });
                resolved.set(nodeId, status.status);
                return;
              }
            } catch {
              consecutiveFailures++;
              if (consecutiveFailures >= MAX_POLL_FAILURES) {
                const doneAt = Date.now();
                updateNode(nodeId, {
                  status: "failed",
                  stderr: `Lost connection to job ${jobId} after ${MAX_POLL_FAILURES} failed status checks`,
                  completedAt: doneAt,
                });
                emitEvent(nodeId, "error", `Lost connection after ${MAX_POLL_FAILURES} failures`);
                resolved.set(nodeId, "failed");
                return;
              }
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        // ── Extract nodes: participate as virtual steps ──────────
        // Identify extract nodes and their dependencies from the graph.
        const extractNodes = graph.nodes.filter(
          (n) => n.stageCommand === "control/extract",
        );
        for (const en of extractNodes) {
          // Find the upstream node connected to the extract node's "input" port
          const inputEdge = graph.edges.find(
            (e: GraphEdge) => e.targetNode === en.id && e.targetPort === "input",
          );
          deps.set(en.id, inputEdge ? [inputEdge.sourceNode] : []);
          init.set(en.id, { ...emptyRunState(), status: "queued" });
        }
        // Re-set state to include extract nodes in the initial map
        if (extractNodes.length > 0) setRunState(new Map(init));

        /** Run a client-side extract: read upstream stdout, apply expression. */
        async function runExtractNode(
          nodeId: string,
          graphRef: Graph,
        ): Promise<void> {
          const depsOk = await waitForDeps(nodeId);
          if (!depsOk || cancelledRef.current || runGenRef.current !== gen) {
            updateNode(nodeId, { status: "canceled" });
            resolved.set(nodeId, "canceled");
            return;
          }

          const gNode = graphRef.nodes.find((n) => n.id === nodeId);
          if (!gNode) {
            updateNode(nodeId, { status: "failed", stderr: "Extract node not found" });
            resolved.set(nodeId, "failed");
            return;
          }

          const inputEdge = graphRef.edges.find(
            (e: GraphEdge) => e.targetNode === nodeId && e.targetPort === "input",
          );
          if (!inputEdge) {
            updateNode(nodeId, {
              status: "failed",
              stderr: "No input connected to Extract node",
            });
            resolved.set(nodeId, "failed");
            return;
          }

          // Read upstream stdout from React state
          let upstreamStdout = "";
          setRunState((prev) => {
            const us = prev.get(inputEdge.sourceNode);
            if (us) upstreamStdout = us.stdout;
            return prev; // no mutation
          });

          const expression = String(gNode.argValues.expression ?? "");
          const fallback = gNode.argValues.fallback !== undefined
            ? String(gNode.argValues.fallback) : undefined;
          const result = extractByPath(upstreamStdout, expression, fallback);

          updateNode(nodeId, {
            status: "succeeded",
            stdout: result,
            stderr: "",
            exitCode: 0,
          });
          resolved.set(nodeId, "succeeded");
        }

        /** Inject extracted values into a step's request args. */
        function injectExtractValues(
          nodeId: string,
          req: RunStepRequest,
          graphRef: Graph,
        ): RunStepRequest {
          const patches: Record<string, unknown> = {};
          for (const edge of graphRef.edges) {
            if (edge.targetNode !== nodeId) continue;
            if (!edge.targetPort.startsWith("arg:")) continue;
            const srcNode = graphRef.nodes.find((n) => n.id === edge.sourceNode);
            if (srcNode?.stageCommand !== "control/extract") continue;
            // Read the extract node's stdout (the extracted value)
            let extractedValue = "";
            setRunState((prev) => {
              const es = prev.get(edge.sourceNode);
              if (es) extractedValue = es.stdout;
              return prev;
            });
            const argKey = edge.targetPort.slice(4); // strip "arg:"
            patches[argKey] = extractedValue;
          }
          if (Object.keys(patches).length === 0) return req;
          return { ...req, args: { ...req.args, ...patches } };
        }

        // Launch all steps — they each wait for their deps internally
        const promises = pipeline.steps.map((step: PipelineStep, i: number) =>
          runStep(step.name, requests[i], step.delay_seconds),
        );
        const extractPromises = extractNodes.map((en) =>
          runExtractNode(en.id, graph),
        );
        await Promise.all([...promises, ...extractPromises]);
        persistRun("pipeline");
        forceRerunRef.current.clear();
      } finally {
        if (runGenRef.current === gen) setRunning(false);
      }
    },
    [updateNode, emitEvent, persistRun],
  );

  // ── Cancel ─────────────────────────────────────────────────────

  const cancelAll = useCallback(() => {
    cancelledRef.current = true;
    runGenRef.current++;
    for (const ws of wsRefs.current) {
      try { ws.close(); } catch { /* ignore */ }
    }
    wsRefs.current = [];

    const doneAt = Date.now();
    for (const [nodeId, jobId] of activeJobsRef.current) {
      cancelJob(jobId).catch(() => {});
      updateNode(nodeId, { status: "canceled", completedAt: doneAt });
      emitEvent(nodeId, "canceled", "Canceled by user");
    }
    activeJobsRef.current = new Map();
    setRunning(false);
  }, [updateNode, emitEvent]);

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

  // ── Clear single node ────────────────────────────────────────────

  const clearNode = useCallback((nodeId: string) => {
    setRunState((prev) => {
      const next = new Map(prev);
      next.delete(nodeId);
      return next;
    });
  }, []);

  // ── Force re-run (bypass cache for a specific node) ──────────────

  const forceRerunNode = useCallback((nodeId: string) => {
    forceRerunRef.current.add(nodeId);
  }, []);

  return { runState, running, dryRun, runPipeline, runSingleNode, cancelAll, reset, clearNode, forceRerunNode };
}
