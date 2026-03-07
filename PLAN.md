# AI Workflow Assistant — Implementation Plan

## Overview

Add an AI assistant to the Zyra Editor that helps users in two ways:

1. **Workflow Planner** — Takes a natural-language intent (e.g., "Download NOAA SST data from FTP, regrid to 0.25°, convert to GeoTIFF, and upload to S3") and generates an initial node graph using **`zyra plan`** — Zyra's built-in planning command.
2. **Argument Advisor** — Provides contextual help for complex node arguments (e.g., FTP filename patterns, timestamp formats, spatial bounds syntax).

LLM backend: Delegated to `zyra plan --provider` (supports **Ollama**, **OpenAI**, **Gemini**, and compatible backends). No custom LLM abstraction needed.

---

## Key Insight: Leveraging `zyra plan`

The Zyra CLI already includes a `plan` command that:
- Accepts natural-language intent via `--intent`
- Supports multiple LLM providers via `--provider` (OpenAI, Ollama, Gemini)
- Returns structured JSON with an `agents` array and `suggestions` array
- Already knows Zyra's stage vocabulary (acquire, process, visualize, etc.)

**This eliminates the need for:**
- ~~Custom `ai_service.py` with provider abstraction~~
- ~~Custom prompt engineering with manifest summaries~~
- ~~Custom JSON response parsing~~
- ~~Adding `openai` as a pip dependency~~

The server simply shells out to `zyra plan` via the existing CLI execution infrastructure.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  @zyra/editor (React)                           │
│                                                 │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │ AiPlannerPanel│   │ AiArgAdvisor (popover) │  │
│  │  (sidebar)    │   │ per-arg "?" button     │  │
│  └──────┬───────┘   └──────────┬─────────────┘  │
│         │  POST /v1/ai/plan    │ POST /v1/ai/arg │
│         └──────────┬───────────┘                 │
└────────────────────┼─────────────────────────────┘
                     │
┌────────────────────┼─────────────────────────────┐
│  FastAPI server    │                              │
│                    ▼                              │
│  ┌──────────────────────────┐                     │
│  │  /v1/ai/plan             │──► zyra plan        │
│  │  /v1/ai/arg              │──► zyra plan (arg)  │
│  │  /v1/ai/health           │──► provider probe   │
│  └──────────────────────────┘                     │
│                                                   │
│  No custom ai_service.py needed — uses zyra CLI   │
└───────────────────────────────────────────────────┘
```

---

## `zyra plan` Output Format

```json
{
  "agents": [
    { "id": "fetch_frames", "stage": "acquire" },
    { "id": "regrid_data", "stage": "process" },
    { "id": "convert_format", "stage": "export" }
  ],
  "suggestions": [
    { "stage": "narrate", "confidence": 0.88 },
    { "stage": "verify", "confidence": 0.72 }
  ]
}
```

The `agents` array maps directly to editor nodes. The `suggestions` array provides optional stages the user can accept or dismiss, displayed as a secondary recommendation in the UI.

---

## Step-by-step Plan

### Step 1: Server Endpoints (`server/main.py`)

Add three thin endpoints that delegate to the zyra CLI:

#### `GET /v1/ai/health`

Probe whether `zyra plan` is available and which provider is configured.

```python
@app.get("/v1/ai/health")
def ai_health():
    provider = os.environ.get("ZYRA_AI_PROVIDER", "ollama")
    # Check if zyra plan is available by running a lightweight probe
    available = _check_zyra_plan_available()
    return {"provider": provider, "available": available}
```

Returns `{ "provider": "ollama" | "openai" | "gemini", "available": true/false }`.

#### `POST /v1/ai/plan`

Run `zyra plan --intent "..." --provider <provider>` via the existing job infrastructure or as a synchronous subprocess call.

**Request:**
```json
{
  "intent": "Download daily SST data from NOAA FTP, subset to North Atlantic, convert to GeoTIFF, upload to S3"
}
```

**Response:**
```json
{
  "agents": [
    { "id": "fetch_sst", "stage": "acquire" },
    { "id": "subset_atlantic", "stage": "process" },
    { "id": "convert_geotiff", "stage": "export" },
    { "id": "upload_s3", "stage": "export" }
  ],
  "suggestions": [
    { "stage": "verify", "confidence": 0.75 }
  ],
  "provider": "ollama"
}
```

**Implementation notes:**
- Run `zyra plan` as a subprocess (not through the async job system — planning should be synchronous and fast).
- Parse the JSON output directly; no custom prompt engineering needed.
- The `agents` array is converted into editor nodes via a new `planToGraph()` helper.
- The `suggestions` array is passed to the UI for optional stage recommendations.

#### `POST /v1/ai/arg`

For the argument advisor, use `zyra plan` with a targeted prompt asking for argument advice. This reuses the same LLM infrastructure.

**Request:**
```json
{
  "stage": "acquire",
  "command": "ftp",
  "arg_key": "pattern",
  "current_values": { "host": "ftp.noaa.gov", "path": "/pub/data/sst" },
  "question": "What filename pattern should I use for daily SST files?"
}
```

**Response:**
```json
{
  "advice": "NOAA daily SST files typically follow the pattern `oisst-avhrr-v02r01.YYYYMMDD.nc`. Use `oisst-avhrr-v02r01.*.nc` to match all dates.",
  "suggested_value": "oisst-avhrr-v02r01.*.nc",
  "provider": "ollama"
}
```

### Step 2: Plan-to-Graph Conversion (`packages/core/src/`)

Add a `planToGraph()` function in `@zyra/core` that converts `zyra plan` output into a `Graph` the editor can render:

```typescript
interface ZyraPlanAgent {
  id: string;
  stage: string;
}

interface ZyraPlanResult {
  agents: ZyraPlanAgent[];
  suggestions: { stage: string; confidence: number }[];
}

function planToGraph(plan: ZyraPlanResult, manifest: Manifest): Graph {
  // 1. For each agent, find the matching StageDef in the manifest
  // 2. Create GraphNode with auto-layout positions (vertical cascade)
  // 3. Wire sequential edges (agent[n] → agent[n+1]) based on stage order
  // 4. Return { nodes, edges }
}
```

This reuses the existing `pipelineToGraph()` pattern but accepts the simpler `zyra plan` output format.

### Step 3: Vite Proxy Configuration

Verify that `/v1/ai/*` is already covered by the existing `/v1` proxy rule in `packages/editor/vite.config.ts`. It should be — no changes expected.

### Step 4: Frontend API Layer (`packages/editor/src/api.ts`)

Add three functions:

```typescript
export interface AiHealthResponse {
  provider: string;
  available: boolean;
}

export interface AiPlanAgent {
  id: string;
  stage: string;
}

export interface AiPlanSuggestion {
  stage: string;
  confidence: number;
}

export interface AiPlanResponse {
  agents: AiPlanAgent[];
  suggestions: AiPlanSuggestion[];
  provider: string;
}

export interface AiArgResponse {
  advice: string;
  suggested_value?: string;
  provider: string;
}

export async function aiHealth(): Promise<AiHealthResponse> { ... }
export async function aiPlan(intent: string): Promise<AiPlanResponse> { ... }
export async function aiArgAdvice(req: {
  stage: string;
  command: string;
  arg_key: string;
  current_values: Record<string, string>;
  question: string;
}): Promise<AiArgResponse> { ... }
```

### Step 5: AI Planner Panel (`packages/editor/src/AiPlannerPanel.tsx`)

A new UI panel for the workflow planner:

**UI:**
- Text area for user intent (multi-line, placeholder: "Describe your data pipeline...")
- "Generate Workflow" button (shows spinner during request)
- Result area showing:
  - Generated agents as a step list with stage icons/colors
  - **Suggestions section** — recommended stages with confidence bars, each with an "Add" button
  - "Load to Canvas" button → calls `planToGraph()` then updates the editor state
  - "Refine" button → re-opens the text area with the intent pre-filled for iteration
- Provider badge (shows which LLM provider is active)
- Error state if AI is unavailable

**Integration:** Toolbar button (sparkle/wand icon) that opens a modal/drawer overlay.

### Step 6: Arg Advisor UI (`packages/editor/src/AiArgAdvisor.tsx`)

A small popover component for per-argument AI help:

**UI:**
- Small "?" icon button next to each arg field in NodeDetailPanel
- Clicking opens a popover with:
  - Auto-generated question based on arg context (editable)
  - "Ask AI" button
  - Response area with the advice text
  - "Apply suggestion" button (fills the arg value if `suggested_value` is returned)
- Only shown when AI is available (check `/v1/ai/health` on mount)

**Integration:** Modify `NodeDetailPanel.tsx` to render the advisor button next to each arg field.

### Step 7: Docker & Environment Configuration

- Add `ZYRA_AI_PROVIDER` env var to `docker-compose.yml` (default: `ollama`)
- Add `OLLAMA_URL` env var for non-default Ollama endpoints
- Optionally add an `ollama` service to docker-compose for local development
- No new pip dependencies needed — `zyra plan` handles LLM calls internally

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `server/main.py` | **Edit** | Add `/v1/ai/health`, `/v1/ai/plan`, `/v1/ai/arg` endpoints (thin wrappers around `zyra plan`) |
| `packages/core/src/serialise.ts` | **Edit** | Add `planToGraph()` conversion function |
| `packages/core/src/types.ts` | **Edit** | Add `ZyraPlanResult`, `ZyraPlanAgent`, `ZyraPlanSuggestion` interfaces |
| `packages/editor/src/api.ts` | **Edit** | Add `aiHealth`, `aiPlan`, `aiArgAdvice` functions + types |
| `packages/editor/src/AiPlannerPanel.tsx` | **New** | Workflow planner UI component |
| `packages/editor/src/AiArgAdvisor.tsx` | **New** | Per-argument AI help popover |
| `packages/editor/src/App.tsx` | **Edit** | Add planner panel trigger button + state |
| `packages/editor/src/NodeDetailPanel.tsx` | **Edit** | Add AI advisor button next to each arg field |
| `docker-compose.yml` | **Edit** | Add env vars for AI provider config |
| `packages/editor/vite.config.ts` | **Verify** | Confirm `/v1/ai/*` proxied (should be covered by `/v1` rule) |

**Removed from original plan:**
| ~~`server/ai_service.py`~~ | ~~New~~ | ~~No longer needed — `zyra plan` handles LLM calls~~ |
| ~~`server/requirements.txt`~~ | ~~Edit~~ | ~~No new deps needed~~ |

---

## Implementation Order

1. `server/main.py` — Add `/v1/ai/*` endpoints (thin `zyra plan` wrappers)
2. `packages/core/src/` — Add `planToGraph()` + plan types
3. `packages/editor/src/api.ts` — Frontend API functions
4. `packages/editor/src/AiPlannerPanel.tsx` + `App.tsx` integration — Planner UI
5. `packages/editor/src/AiArgAdvisor.tsx` + `NodeDetailPanel.tsx` integration — Arg advisor UI
6. `docker-compose.yml` — Environment config

---

## What Changed From the Original Plan

| Aspect | Original Plan | Revised Plan |
|--------|--------------|--------------|
| LLM backend | Custom `ai_service.py` with Ollama/OpenAI provider abstraction | Delegate to `zyra plan --provider` |
| Prompt engineering | Custom prompt builders with manifest summaries | Handled by `zyra plan` internally |
| JSON parsing | Custom extraction from markdown fences | `zyra plan` returns clean JSON |
| Dependencies | `openai`, `httpx` pip packages | None — `zyra[api]` already includes everything |
| Server complexity | ~200 LOC new module | ~50 LOC endpoint additions |
| Plan output | Custom pipeline steps format | `agents` + `suggestions` with confidence scores |
| New files | 4 new files | 2 new files (frontend only) |

---

## Open Questions / Decisions

1. **Suggestions UX**: How prominently should we show the `suggestions` array? Options: (a) inline below the agent list with "Add" buttons, (b) dismissible toast notifications, (c) ghost nodes on the canvas. Recommend (a).
2. **Streaming**: Should the planner stream `zyra plan` output or wait for completion? Since `zyra plan` runs as a subprocess, start with waiting for completion. Streaming can be added later by reading stdout line-by-line.
3. **Conversation memory**: For "Refine" iterations, pass the previous intent + result context back to `zyra plan`. Check if `zyra plan` supports a `--context` flag or similar.
4. **Arg advisor**: Determine the exact `zyra plan` invocation for argument-level advice. May need a separate `zyra` subcommand or a targeted prompt mode.
