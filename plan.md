# Workflow Execution & Logs — Implementation Plan

## Architecture Overview

Replace the thin custom FastAPI server with Zyra's built-in API server (`zyra.api.server.create_app()`), which already provides execution, job tracking, WebSocket log streaming, and the manifest endpoint. The editor gains a Run button, per-node status badges, a dry-run preview, and a log panel.

```
Editor UI
  ├─ "Dry Run" button  → POST /v1/cli/run {stage, command, args + dry_run:true, mode:"sync"}
  ├─ "Run" button       → POST /v1/cli/run {stage, command, args, mode:"async"} per step
  ├─ Status polling      → GET /v1/jobs/{job_id}  (or WS /ws/jobs/{job_id})
  └─ Log streaming       → WS /ws/jobs/{job_id}?stream=stdout,stderr,progress
                             ↓
                    Zyra API Server (zyra.api.server)
                      /v1/cli/run, /v1/jobs/*, /ws/jobs/*
                      /v1/manifest (replaces our proxy)
```

---

## Phase 1 — Server: Mount Zyra's API

**File: `server/main.py`**

- Replace the hand-rolled FastAPI app with `zyra.api.server.create_app()`
- Add a thin wrapper that:
  - Keeps the existing static-file serving for the built editor (`packages/editor/dist`)
  - Adds CORS for dev (localhost:5173)
- Remove the subprocess-based `/api/manifest` endpoint (Zyra serves `/v1/manifest` natively)
- Update `server/requirements.txt` to add `zyra` as a dependency

**File: `packages/editor/vite.config.ts`**

- Update the dev proxy: `/api` → `http://localhost:8765/v1` (or proxy `/v1` directly)

---

## Phase 2 — Core: Execution Types

**File: `packages/core/src/execution.ts`** (new)

Add TypeScript types mirroring Zyra's API models:

```ts
// Matches CLIRunRequest
interface RunStepRequest {
  stage: string;
  command: string;
  args: Record<string, unknown>;
  mode: "sync" | "async";
}

// Matches CLIRunResponse
interface RunStepResponse {
  status: "success" | "accepted" | "error";
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  job_id?: string;
}

// Matches JobStatusResponse
interface JobStatus {
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  output_file?: string;
}

// Per-node execution state tracked in the editor
type NodeRunStatus = "idle" | "dry-run" | "queued" | "running" | "succeeded" | "failed" | "canceled";

interface NodeRunState {
  status: NodeRunStatus;
  jobId?: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  dryRunArgv?: string;   // resolved command from dry-run
}
```

**File: `packages/core/src/pipeline.ts`** (new)

Add a helper that takes the `Pipeline` from `graphToPipeline()` and converts each step into a `RunStepRequest`:

```ts
function pipelineToRunRequests(pipeline: Pipeline, dryRun?: boolean): RunStepRequest[]
```

Export both new modules from `packages/core/src/index.ts`.

---

## Phase 3 — Editor: Execution State & API Client

**File: `packages/editor/src/useExecution.ts`** (new hook)

A React hook managing per-node execution state:

- `runState: Map<nodeId, NodeRunState>` — tracks each node's status, logs, jobId
- `dryRun(pipeline)` — calls `POST /v1/cli/run` with `dry_run: true, mode: "sync"` for each step sequentially; populates `dryRunArgv` per node
- `runPipeline(pipeline)` — iterates topologically sorted steps:
  - Submits each step via `POST /v1/cli/run` with `mode: "async"`
  - Opens `WS /ws/jobs/{job_id}` per step to stream logs
  - Updates `NodeRunState` as messages arrive
  - Respects `depends_on` — only starts a step after its dependencies reach `succeeded`
  - On failure: marks node as `failed`, stops downstream nodes (unless continue-on-error)
- `cancel(nodeId)` — calls `DELETE /v1/jobs/{job_id}`
- `reset()` — clears all run state

**File: `packages/editor/src/api.ts`** (new)

Thin fetch/WebSocket wrappers:

```ts
postRun(req: RunStepRequest): Promise<RunStepResponse>
getJobStatus(jobId: string): Promise<JobStatus>
cancelJob(jobId: string): Promise<void>
connectJobWs(jobId: string, streams?: string[]): WebSocket
```

---

## Phase 4 — Editor UI: Toolbar, Node Status, Log Panel

### 4a. Toolbar with Run / Dry Run buttons

**File: `packages/editor/src/Toolbar.tsx`** (new)

- Top bar with:
  - **"Dry Run"** button — serializes graph via `graphToPipeline()`, calls `dryRun()`, shows resolved argv per node
  - **"Run"** button — serializes and calls `runPipeline()`
  - **"Cancel"** button (visible during execution)
  - Pipeline status summary ("3/5 stages complete")
- Both buttons disabled when graph is empty or has a cycle

### 4b. Per-node status badge

**File: `packages/editor/src/ZyraNode.tsx`** (modify)

- Accept optional `runStatus: NodeRunStatus` via node data
- Render a small colored status indicator in the node header:
  - `idle` → no indicator
  - `dry-run` → blue outline dot
  - `queued` → gray dot
  - `running` → animated blue pulse
  - `succeeded` → green check
  - `failed` → red X
  - `canceled` → yellow dash
- On `dry-run` with resolved argv: show a small "preview" tooltip or expandable line under the node

### 4c. Log panel (bottom drawer)

**File: `packages/editor/src/LogPanel.tsx`** (new)

- Collapsible bottom panel (similar to a terminal/console drawer)
- Tab per node that has run state (auto-selects the currently running node)
- Streams stdout/stderr in real time via the WebSocket connection
- Color-codes stderr lines
- Shows exit code and final status on completion
- "Clear" button to reset logs
- Clicking a node on the canvas switches to its log tab

### 4d. Wire it together in App.tsx

**File: `packages/editor/src/App.tsx`** (modify)

- Add `useExecution()` hook
- Pass `runStatus` into each node's data for the status badge
- Render `<Toolbar>` above the canvas
- Render `<LogPanel>` below the canvas
- Adjust layout: toolbar (40px top) → canvas (flex) → log panel (resizable bottom, default ~200px)

---

## Phase 5 — Dry-Run Details

The dry-run feature deserves special attention for complex stages:

- When user clicks "Dry Run", each step is sent with `{ ...args, dry_run: true }` in sync mode
- The response `stdout` contains the resolved argv (the exact CLI command that *would* run)
- This is displayed:
  - In a **toast/banner** summarizing the full pipeline
  - Per-node as a small code block (expandable) showing the resolved command
  - In the **ArgPanel** when a node is selected during dry-run state
- Useful for: verifying file paths, checking env var resolution, validating arg combinations before a long-running pipeline

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `server/main.py` | Rewrite | Mount `zyra.api.server`, keep static serving |
| `server/requirements.txt` | Edit | Add `zyra` dependency |
| `packages/editor/vite.config.ts` | Edit | Update proxy to `/v1` |
| `packages/core/src/execution.ts` | New | Execution types (RunStepRequest, JobStatus, NodeRunState) |
| `packages/core/src/pipeline.ts` | New | `pipelineToRunRequests()` helper |
| `packages/core/src/index.ts` | Edit | Export new modules |
| `packages/editor/src/api.ts` | New | Fetch/WebSocket client for Zyra API |
| `packages/editor/src/useExecution.ts` | New | Execution state management hook |
| `packages/editor/src/Toolbar.tsx` | New | Run/DryRun/Cancel buttons + status summary |
| `packages/editor/src/ZyraNode.tsx` | Edit | Add status badge to node header |
| `packages/editor/src/LogPanel.tsx` | New | Bottom log panel with per-node tabs |
| `packages/editor/src/App.tsx` | Edit | Wire together toolbar, execution hook, log panel |
