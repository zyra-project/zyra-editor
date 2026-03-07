# Plan: AI Workflow Assistant for Zyra Editor

## Summary

Add an AI-powered workflow assistant to the Zyra Editor that lets users describe a data pipeline in natural language, then generates and places the corresponding node graph on the canvas. This leverages `zyra plan` — a planner already built into the Zyra CLI.

---

## API Availability: Can We Use `zyra plan` from the Editor?

### Current State

**`zyra plan` exists** in the CLI (`src/zyra/swarm/planner.py`) but is **NOT exposed** through the existing API. The `/v1/cli/run` endpoint uses a hard-coded stage matrix (`_compute_cli_matrix()`) that imports specific modules:

- acquire, process, visualize, decimate, simulate, decide, narrate, verify, swarm, run

`plan` is **not in this list**. The endpoint validates stage/command pairs against this matrix and returns HTTP 400 for unrecognized stages.

### Solution: Add a Proxy Endpoint on the Editor Server

Since we control the editor's FastAPI server (`server/main.py`), we add a thin endpoint that shells out to `zyra plan` directly (the `zyra` CLI is installed in the server container via `zyra[api]`). This avoids needing changes to upstream zyra's API router.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Editor (React)                                      │
│                                                      │
│  ┌────────────────────┐                              │
│  │ PlannerPanel.tsx    │──POST /v1/plan──┐            │
│  │ (text input + btn) │                 │            │
│  └────────────────────┘                 │            │
│           │                             │            │
│           ▼                             ▼            │
│  ┌────────────────────┐    ┌─────────────────────┐   │
│  │ Canvas: App.tsx    │    │  Editor Server       │   │
│  │ (places nodes +    │    │  server/main.py      │   │
│  │  edges from plan)  │    │                      │   │
│  └────────────────────┘    │  POST /v1/plan       │   │
│                            │  → subprocess:       │   │
│                            │    zyra plan          │   │
│                            │    --intent "..."     │   │
│                            │    --no-clarify       │   │
│                            │  → returns JSON       │   │
│                            └─────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

---

## Design Details

### A. Server: `POST /v1/plan` Endpoint (`server/main.py`)

A new endpoint that runs `zyra plan` as a subprocess:

```python
@app.post("/v1/plan")
async def generate_plan(request: PlanRequest):
    """Run zyra plan and return the structured manifest."""
    cmd = ["zyra", "plan", "--intent", request.intent, "--no-clarify"]
    if request.guardrails:
        cmd += ["--guardrails", request.guardrails]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise HTTPException(400, detail=result.stderr)
    return json.loads(result.stdout)
```

**Request model:**
```python
class PlanRequest(BaseModel):
    intent: str           # e.g. "Download SST data and convert to GeoTIFF"
    guardrails: str = ""  # optional validation schema path
```

**Response shape** (from `zyra plan` output):
```json
{
  "intent": "Download SST data and convert to GeoTIFF",
  "agents": [
    {
      "id": "acquire_1",
      "stage": "acquire",
      "command": "http",
      "depends_on": [],
      "args": { "url": "...", "output": "/data/raw/sst.nc" }
    },
    {
      "id": "process_1",
      "stage": "process",
      "command": "convert",
      "depends_on": ["acquire_1"],
      "args": { "input": "/data/raw/sst.nc", "format": "geotiff" }
    }
  ],
  "plan_summary": "...",
  "suggestions": []
}
```

**Vite proxy:** Add `/v1/plan` to the existing proxy config in `vite.config.ts` (already covered by the `/v1` prefix proxy rule).

### B. Editor: Planner Panel (`packages/editor/src/PlannerPanel.tsx`)

A collapsible panel in the toolbar area with:

1. **Text input** — multi-line textarea for describing the desired pipeline
2. **"Generate" button** — calls `POST /v1/plan` with the intent text
3. **Loading state** — spinner while waiting for the planner
4. **Error display** — shows planner errors inline
5. **Preview** — shows the plan summary and agent list before placing on canvas
6. **"Apply to Canvas" button** — converts the plan into nodes + edges

### C. Plan-to-Graph Conversion (`packages/editor/src/planToGraph.ts`)

Converts the planner's `agents` array into React Flow nodes and edges:

```ts
interface PlanAgent {
  id: string;
  stage: string;
  command: string;
  depends_on: string[];
  args: Record<string, string>;
}

function planToGraph(
  agents: PlanAgent[],
  manifest: Manifest
): { nodes: Node[]; edges: Edge[] }
```

**Logic:**
1. For each agent, find the matching `StageDef` in the manifest by `stage` + `command`
2. Create a React Flow node with:
   - `type: "zyra"` (our custom node type)
   - `data.stageId` matching the manifest stage
   - `data.argValues` populated from the agent's `args`
   - `position` auto-laid out (simple grid or topological layout)
3. For each `depends_on` entry, create an edge from the dependency's output port to this node's input port
4. Return the nodes and edges arrays

**Auto-layout:** Simple left-to-right topological layout:
- Assign each node a column based on its topological depth (max depth of dependencies + 1)
- Space nodes vertically within each column
- Column width: ~300px, row height: ~150px

### D. Integration in `App.tsx`

Add a callback that receives the plan output and merges it onto the canvas:

```ts
const handlePlanApply = (agents: PlanAgent[]) => {
  const { nodes: newNodes, edges: newEdges } = planToGraph(agents, manifest);
  // Offset positions so new nodes don't overlap existing ones
  const offsetX = /* rightmost existing node X + 400 */ ;
  const offsetNodes = newNodes.map(n => ({
    ...n,
    position: { x: n.position.x + offsetX, y: n.position.y }
  }));
  setNodes(prev => [...prev, ...offsetNodes]);
  setEdges(prev => [...prev, ...newEdges]);
};
```

### E. Toolbar Button

Add a toolbar button (e.g. sparkle/wand icon) that toggles the PlannerPanel visibility. Place it near the existing run/export buttons.

---

## Implementation Order

1. **Server endpoint** — Add `POST /v1/plan` to `server/main.py` that shells out to `zyra plan --intent "..." --no-clarify` and returns the JSON result.

2. **Plan-to-graph converter** — Create `packages/editor/src/planToGraph.ts` with the conversion logic and auto-layout.

3. **PlannerPanel component** — Create `packages/editor/src/PlannerPanel.tsx` with the text input, generate button, preview, and apply button.

4. **App.tsx integration** — Add the toolbar button, PlannerPanel rendering, and `handlePlanApply` callback.

5. **Styling** — Dark theme consistent with the existing editor UI.

---

## What This Does NOT Change

- No changes to `@zyra/core` — plan-to-graph conversion is editor-only
- No changes to the upstream zyra API (`_compute_cli_matrix`) — we bypass it with a direct subprocess call
- Existing manual node creation workflow is unchanged
- Execution flow unchanged — planned nodes execute the same as manually-created ones
- No new npm dependencies required (uses existing React Flow APIs)

## Dependencies

- `zyra` CLI must be installed in the server container (already is via `zyra[api]>=0.1.45`)
- `zyra plan` requires LLM access — the server container needs appropriate env vars (e.g. `OPENAI_API_KEY` or `OLLAMA_HOST`) for the planner's LLM backend
