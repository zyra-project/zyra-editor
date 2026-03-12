// ── Zyra API request / response types ────────────────────────────

/** Mirrors the Zyra CLIRunRequest model. */
export interface RunStepRequest {
  stage: string;
  command: string;
  args: Record<string, unknown>;
  mode: "sync" | "async";
}

/** Mirrors the Zyra CLIRunResponse model. */
export interface RunStepResponse {
  status: "success" | "accepted" | "error";
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  job_id?: string;
}

/** Mirrors the Zyra JobStatusResponse model. */
export interface JobStatus {
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  output_file?: string;
}

// ── Editor-side execution state ──────────────────────────────────

export type NodeRunStatus =
  | "idle"
  | "dry-run"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "cached";

// ── Structured run events ────────────────────────────────────────

export type RunEventType =
  | "submitted"
  | "job-accepted"
  | "ws-connected"
  | "ws-disconnected"
  | "poll-fallback"
  | "completed"
  | "canceled"
  | "error"
  | "cache-hit";

/** A single structured event in a node's execution timeline. */
export interface RunEvent {
  type: RunEventType;
  /** Epoch milliseconds (Date.now()). */
  timestamp: number;
  /** Human-readable description. */
  message?: string;
  /** Optional structured payload. */
  detail?: Record<string, unknown>;
}

/** Per-node execution state tracked by the editor. */
export interface NodeRunState {
  status: NodeRunStatus;
  jobId?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  /** Resolved CLI command returned by a dry-run. */
  dryRunArgv?: string;
  /** The request that was submitted to the server (for debugging). */
  submittedRequest?: RunStepRequest;
  /** Structured event timeline for this run. */
  events: RunEvent[];
  /** Epoch ms when the run started (status → running). */
  startedAt?: number;
  /** Epoch ms when the run reached a terminal state. */
  completedAt?: number;
}

export function emptyRunState(): NodeRunState {
  return { status: "idle", stdout: "", stderr: "", events: [] };
}

/** Canonical status → hex color mapping shared across all UI components. */
export const STATUS_COLORS: Record<NodeRunStatus, string> = {
  idle: "#555",
  "dry-run": "#58a6ff",
  queued: "#888",
  running: "#58a6ff",
  succeeded: "#3fb950",
  failed: "#f85149",
  canceled: "#d29922",
  cached: "#8b949e",
};
