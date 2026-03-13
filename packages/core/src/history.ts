// ── Run history types ────────────────────────────────────────────────

import type { RunStepRequest, RunEvent, NodeRunState } from "./execution.js";

/** Summary of a past run (returned by the list endpoint — no stdout/stderr). */
export interface RunSummary {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: "succeeded" | "failed" | "canceled" | "partial";
  durationMs?: number;
  mode: "pipeline" | "single-node";
  nodeCount: number;
  summary?: string;
}

/** Detail of a single step within a completed run. */
export interface RunStepRecord {
  nodeId: string;
  status: string;
  jobId?: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  request?: RunStepRequest;
  events: RunEvent[];
  dryRunArgv?: string;
}

/** Snapshot of the React Flow canvas at execution time. */
export interface GraphSnapshot {
  nodes: unknown[];
  edges: unknown[];
}

/** Full run record including all step details and graph snapshot. */
export interface RunHistoryRecord extends RunSummary {
  steps: RunStepRecord[];
  graphSnapshot?: GraphSnapshot;
}

// ── Pure helper: build a run record from a run-state map ─────────────

/**
 * Redact known secret values from a string, replacing each occurrence
 * with "***REDACTED***".
 */
function redactString(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && result.includes(secret)) {
      result = result.split(secret).join("***REDACTED***");
    }
  }
  return result;
}

/**
 * Redact secret values from a RunStepRequest's args.
 * Returns a new request with sensitive arg values replaced.
 */
function redactRequest(
  req: RunStepRequest | undefined,
  secrets: string[],
): RunStepRequest | undefined {
  if (!req || secrets.length === 0) return req;
  const redactedArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.args)) {
    redactedArgs[k] = typeof v === "string" ? redactString(v, secrets) : v;
  }
  return { ...req, args: redactedArgs };
}

/**
 * Convert a Map<nodeId, NodeRunState> into a RunHistoryRecord.
 * Returns `undefined` if there are no actionable steps (all idle/queued/dry-run).
 *
 * When `secretValues` is provided, all occurrences of those values are
 * redacted from stdout, stderr, and request args before persisting.
 *
 * This is extracted as a pure function so it can be unit-tested without React.
 */
export function buildRunRecord(
  runState: Map<string, NodeRunState>,
  mode: "pipeline" | "single-node",
  graphSnapshot?: GraphSnapshot,
  secretValues?: string[],
): RunHistoryRecord | undefined {
  const secrets = secretValues?.filter((v) => v.length > 0) ?? [];
  const steps: RunStepRecord[] = [];
  let earliest = Infinity;
  let latest = 0;
  let hasFailure = false;
  let hasCanceled = false;

  for (const [nodeId, ns] of runState) {
    if (ns.status === "idle" || ns.status === "dry-run" || ns.status === "queued") continue;
    steps.push({
      nodeId,
      status: ns.status,
      jobId: ns.jobId,
      exitCode: ns.exitCode,
      stdout: secrets.length > 0 ? redactString(ns.stdout, secrets) : ns.stdout,
      stderr: secrets.length > 0 ? redactString(ns.stderr, secrets) : ns.stderr,
      startedAt: ns.startedAt ? new Date(ns.startedAt).toISOString() : undefined,
      completedAt: ns.completedAt ? new Date(ns.completedAt).toISOString() : undefined,
      durationMs: ns.startedAt && ns.completedAt ? ns.completedAt - ns.startedAt : undefined,
      request: redactRequest(ns.submittedRequest, secrets),
      events: ns.events,
      dryRunArgv: ns.dryRunArgv,
    });
    if (ns.startedAt && ns.startedAt < earliest) earliest = ns.startedAt;
    if (ns.completedAt && ns.completedAt > latest) latest = ns.completedAt;
    if (ns.status === "failed") hasFailure = true;
    if (ns.status === "canceled") hasCanceled = true;
  }

  if (steps.length === 0) return undefined;

  const overallStatus: RunSummary["status"] = hasFailure
    ? "failed"
    : hasCanceled
      ? "canceled"
      : steps.every((s) => s.status === "succeeded" || s.status === "cached")
        ? "succeeded"
        : "partial";

  return {
    id: crypto.randomUUID(),
    startedAt:
      earliest < Infinity
        ? new Date(earliest).toISOString()
        : new Date().toISOString(),
    completedAt: latest > 0 ? new Date(latest).toISOString() : undefined,
    status: overallStatus,
    durationMs:
      earliest < Infinity && latest > 0 ? latest - earliest : undefined,
    mode,
    nodeCount: steps.length,
    graphSnapshot,
    steps,
  };
}
