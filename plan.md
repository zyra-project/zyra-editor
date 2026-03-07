# Plan: AI Planner UX Improvements

## Overview

Seven improvements to the AI Planner feature addressing loading feedback, error recovery, agent editing, history, keyboard accessibility, canvas clutter management, and backend status monitoring.

---

## 1. Loading Feedback with Progress Indicator & Cancel

**Problem:** Users see only "Generating..." on a disabled button during 30-120s LLM calls. No spinner, no progress, no cancel.

**Files:** `PlannerPanel.tsx`

**Changes:**
- Add an `AbortController` ref to enable cancellation of the fetch request
- Replace the "Generating..." button text with a multi-element loading state:
  - CSS-animated spinner (rotating ring, defined in `theme.css`)
  - Elapsed time counter (updates every second via `setInterval`)
  - "Cancel" link/button that aborts the fetch and resets state
- Add `@keyframes zyra-spin` to `theme.css` for the spinner animation
- The loading UI replaces the Generate button area during generation:
  ```
  ┌─────────────────────────────────┐
  │  ◌ Generating...  12s  Cancel   │
  └─────────────────────────────────┘
  ```

---

## 2. Error Recovery with Actionable Guidance

**Problem:** Errors show a red box with the raw message but no guidance on how to fix it.

**Files:** `PlannerPanel.tsx`

**Changes:**
- Create an `ERROR_GUIDANCE` map keyed by HTTP status code or error pattern:
  - `503` → "The zyra CLI is not installed in the server container. Check that `zyra[api]` is in requirements.txt and the container has been rebuilt."
  - `504` → "The planner timed out (120s limit). Try a simpler intent or check that the LLM backend (OPENAI_API_KEY / OLLAMA_HOST) is configured and responsive."
  - `400` → "The planner returned an error. Review your intent description and try rephrasing."
  - `502` → "The planner produced invalid output. This may be a transient LLM issue — try again."
  - Network/fetch errors → "Could not reach the server. Check that the backend is running at localhost:8765."
- Update the error display to show:
  - The raw error message (as today)
  - A guidance paragraph below in muted text
  - A "Retry" button that re-runs `handleGenerate()` with the same intent

**Implementation detail:** Parse the HTTP status from the fetch response before constructing the Error object. Store it alongside the error message in a `{ message: string; status?: number }` state shape instead of just `string | null`.

---

## 3. Editable Agent List (Remove/Reorder Core Agents)

**Problem:** Users can accept/dismiss suggestions but cannot remove or reorder the planner's core agents before applying.

**Files:** `PlannerPanel.tsx`, `planToGraph.ts`

**Changes to PlannerPanel.tsx:**
- Change `plan.agents` from being used directly to being copied into a mutable `editableAgents` state (`useState<PlanAgent[]>`) that is initialized from `plan.agents` whenever a new plan arrives
- Add a "Remove" button (small `×`) to each `AgentCard`
  - Clicking removes that agent from `editableAgents`
  - Also removes it from any other agent's `depends_on` to prevent dangling references
- Add drag-to-reorder: **not implementing full DnD** (too complex, no new deps). Instead:
  - Add small up/down arrow buttons on each AgentCard to shift position in the list
  - This changes visual order and the order passed to `planToGraph()` but does not alter `depends_on` (topological layout handles positioning regardless of array order)
- Update the "Apply to Canvas" button count to reflect `editableAgents.length + acceptedIdxs.size`
- Update `handleApply` to use `editableAgents` instead of `plan.agents`

**No changes to planToGraph.ts** — it already handles any agents array.

---

## 4. Plan History (Persist Intent & Results Across Panel Opens)

**Problem:** Closing the panel loses the current plan and intent text. Re-opening starts fresh.

**Files:** `PlannerPanel.tsx`, `App.tsx`

**Changes to App.tsx:**
- Lift the planner state up: add a `plannerHistory` state that holds an array of `{ intent: string; plan: PlanResponse | null; timestamp: number }` entries (max 10)
- Pass `plannerHistory` and an `onHistoryAdd` callback down to `PlannerPanel`
- The `intent` text field value is also lifted to App.tsx so it persists across open/close cycles

**Changes to PlannerPanel.tsx:**
- Accept `history`, `onHistoryAdd`, `intent`/`setIntent` props
- After a successful generate, call `onHistoryAdd({ intent, plan, timestamp: Date.now() })`
- Add a small "History" section at the top of the panel (collapsible):
  - Shows past intents as clickable items (truncated to ~60 chars)
  - Clicking an item restores that intent text in the textarea and loads its plan result for preview
  - A small "×" on each history item removes it
- The current intent persists when closing/reopening the panel (no state reset on close)
- History is stored in component state only (not localStorage) — it's session-scoped

---

## 5. Keyboard Shortcut for Planner Panel

**Problem:** No keyboard shortcut to open/close the AI planner panel.

**Files:** `App.tsx`, `Toolbar.tsx` (help text update)

**Changes to App.tsx:**
- Add `Ctrl+P` (or `Cmd+P` on macOS) to the keyboard shortcut handler:
  ```ts
  if ((e.metaKey || e.ctrlKey) && e.key === "p") {
    e.preventDefault();
    setPlannerOpen((v) => !v);
    return;
  }
  ```
- Also close planner panel on `Escape` (add to the existing Escape chain: yaml → planner → detail → deselect)

**Changes to Toolbar.tsx:**
- Update the Plan button `title` to include the shortcut: `"AI Planner (Ctrl+P)"`
- Add "Ctrl+P — Toggle AI Planner" to the `HELP_SECTIONS` keyboard shortcuts list

---

## 6. Batch Undo for AI-Generated Nodes

**Problem:** Repeated Generate → Apply cycles stack nodes rightward with no way to clear a specific AI batch.

**Files:** `App.tsx`, `PlannerPanel.tsx`

**Changes to App.tsx:**
- Maintain a `planBatches` state: `useState<{ nodeIds: string[]; edgeIds: string[]; intent: string; timestamp: number }[]>([])`
- In `handlePlanApply`, after adding nodes/edges, record the batch:
  ```ts
  const batchNodeIds = offsetNodes.map(n => n.id);
  const batchEdgeIds = newEdges.map(e => e.id);
  setPlanBatches(prev => [...prev, {
    nodeIds: batchNodeIds,
    edgeIds: batchEdgeIds,
    intent: currentIntent,
    timestamp: Date.now(),
  }]);
  ```
- Add an `onUndoLastBatch` callback that removes the most recent batch's nodes and edges from the canvas:
  ```ts
  const handleUndoLastBatch = useCallback(() => {
    const last = planBatches[planBatches.length - 1];
    if (!last) return;
    const nodeSet = new Set(last.nodeIds);
    const edgeSet = new Set(last.edgeIds);
    setNodes(prev => prev.filter(n => !nodeSet.has(n.id)));
    setEdges(prev => prev.filter(e => !edgeSet.has(e.id)));
    setPlanBatches(prev => prev.slice(0, -1));
  }, [planBatches, setNodes, setEdges]);
  ```

**Changes to PlannerPanel.tsx:**
- Accept `batches` and `onUndoBatch` props
- After the plan preview / apply area, show a small "Recent AI Batches" section if batches exist:
  - Each batch shows: truncated intent, node count, timestamp
  - "Undo" button on the most recent batch removes those nodes/edges
  - Only the most recent batch can be undone (to keep it simple and avoid orphaned edge issues)

---

## 7. AI Status Indicator (Backend Readiness Check)

**Problem:** No visibility into whether the backend is reachable and the planner CLI is available.

**Files:** `Toolbar.tsx`, new hook `packages/editor/src/useBackendStatus.ts`, `server/main.py`

### Server Changes (`server/main.py`):
- Add a `GET /v1/ready` endpoint (if `/ready` or `/health` doesn't already cover this):
  ```python
  @app.get("/v1/ready")
  async def readiness_check():
      """Check backend readiness: server up, zyra CLI available, LLM configured."""
      checks = {
          "server": True,
          "zyra_cli": False,
          "llm_configured": False,
      }
      # Check zyra CLI
      try:
          result = subprocess.run(["zyra", "--version"], capture_output=True, text=True, timeout=5)
          checks["zyra_cli"] = result.returncode == 0
          checks["zyra_version"] = result.stdout.strip() if result.returncode == 0 else None
      except (FileNotFoundError, subprocess.TimeoutExpired):
          pass
      # Check LLM configuration
      checks["llm_configured"] = bool(
          os.environ.get("OPENAI_API_KEY") or os.environ.get("OLLAMA_HOST")
      )
      checks["ready"] = all([checks["server"], checks["zyra_cli"], checks["llm_configured"]])
      return checks
  ```
  The endpoint proxies through Vite automatically (the existing `/v1` proxy rule covers it).

### New Hook (`useBackendStatus.ts`):
```ts
interface BackendStatus {
  status: "checking" | "ready" | "degraded" | "offline";
  server: boolean;
  zyra_cli: boolean;
  llm_configured: boolean;
  zyra_version?: string;
  lastChecked: number;
}
```
- On mount, fetch `GET /v1/ready`
- Poll every 30 seconds
- On fetch failure, set status to `"offline"`
- If server responds but `zyra_cli` or `llm_configured` is false, set `"degraded"`
- If all checks pass, set `"ready"`
- Expose a `refresh()` function for manual re-check

### Toolbar Changes (`Toolbar.tsx`):
- Import and use `useBackendStatus()` (or receive status as prop from App.tsx — prop approach preferred to keep hook usage centralized)
- Add an AI Status indicator button next to the Plan button:
  - **Ready** (all green): small green dot + "AI Ready" text
  - **Degraded** (partial): yellow dot + "AI Degraded" — click opens a tooltip/popover showing which checks failed
  - **Offline**: red dot + "Offline" — click shows connection details
- The indicator button is clickable and opens a small dropdown/popover showing:
  ```
  ┌──────────────────────────────────┐
  │  Backend Status                  │
  │  ──────────────────────────────  │
  │  ● Server        Connected      │
  │  ● Zyra CLI      v0.1.47        │
  │  ● LLM Backend   Configured     │
  │                                  │
  │  Last checked: 12s ago  Refresh  │
  └──────────────────────────────────┘
  ```
- Style: consistent with existing toolbar buttons, uses the existing `--accent-green`, `--accent-yellow`, `--accent-red` CSS variables

### App.tsx Changes:
- Call `useBackendStatus()` in the Editor component
- Pass the status object down to `Toolbar` as a prop
- Also pass it to `PlannerPanel` so the Generate button can be disabled with a helpful message when status is not "ready"

---

## Implementation Order

1. **Spinner animation** — Add `@keyframes zyra-spin` to `theme.css`
2. **`useBackendStatus` hook** — Create the new hook file
3. **Server `/v1/ready` endpoint** — Add to `server/main.py`
4. **PlannerPanel overhaul** — Loading feedback, error recovery, editable agents, history, batch display (items 1-4, 6 partial)
5. **App.tsx integration** — Lifted state for history/batches, keyboard shortcut (Ctrl+P), planner Escape handling, backend status hook, pass props down
6. **Toolbar updates** — AI status indicator, updated help text, shortcut label
7. **Type-check & verify** — Run `pnpm typecheck` across the monorepo

---

## What This Does NOT Change

- No changes to `@zyra/core`
- No changes to `planToGraph.ts` (the converter already handles any agents array)
- No new npm dependencies
- Existing node creation, execution, and export workflows unchanged
- The server `/v1/plan` endpoint logic unchanged (only adding `/v1/ready`)
