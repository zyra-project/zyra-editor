# AI Workflow Assistant — Implementation Plan

## Overview

Add an AI assistant to the Zyra Editor that helps users in two ways:

1. **Workflow Planner** — Takes a natural-language intent (e.g., "Download NOAA SST data from FTP, regrid to 0.25°, convert to GeoTIFF, and upload to S3") and generates an initial node graph using Zyra's stage vocabulary.
2. **Argument Advisor** — Provides contextual help for complex node arguments (e.g., FTP filename patterns, timestamp formats, spatial bounds syntax).

LLM backend: **Ollama** (local, preferred) with **OpenAI API** fallback.

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
│  │  /v1/ai/plan             │                     │
│  │  /v1/ai/arg              │                     │
│  │  /v1/ai/health           │                     │
│  └────────────┬─────────────┘                     │
│               │                                   │
│  ┌────────────▼─────────────┐                     │
│  │  ai_service.py           │                     │
│  │  - try Ollama first      │                     │
│  │  - fallback to OpenAI    │                     │
│  │  - prompt construction   │                     │
│  │  - response parsing      │                     │
│  └──────────────────────────┘                     │
└───────────────────────────────────────────────────┘
         │                    │
    ┌────▼────┐        ┌──────▼──────┐
    │ Ollama  │        │ OpenAI API  │
    │ :11434  │        │ (fallback)  │
    └─────────┘        └─────────────┘
```

---

## Step-by-step Plan

### Step 1: AI Service Backend (`server/ai_service.py`)

Create a new Python module that handles LLM communication.

**Responsibilities:**
- **Provider abstraction**: `LLMProvider` with `chat(messages, json_mode) → str`
  - `OllamaProvider`: calls `http://<OLLAMA_HOST>:11434/api/chat` (configurable via `OLLAMA_URL` env var)
  - `OpenAIProvider`: uses `openai` Python SDK with `OPENAI_API_KEY` env var
- **Auto-detection**: On startup (and cached), probe Ollama `/api/tags`. If reachable, use Ollama; otherwise fall back to OpenAI. Re-probe periodically or on failure.
- **Model selection**: `OLLAMA_MODEL` env var (default: `llama3`) and `OPENAI_MODEL` env var (default: `gpt-4o`).
- **Prompt templates**: Two prompt builders:
  - `build_plan_prompt(intent, manifest_summary)` — system prompt with Zyra's stage vocabulary + user intent → returns pipeline JSON
  - `build_arg_prompt(stage_def, arg_def, user_question, current_values)` — system prompt with arg context → returns advice text

**Key design decisions:**
- The manifest summary sent to the LLM is a condensed version: for each stage, include `stage/command`, `label`, `description`, and arg names/types. This keeps the prompt under ~4K tokens.
- Plan responses are requested as JSON matching a simplified Pipeline schema (list of steps with `command`, `args`, `depends_on`).
- Robust JSON extraction: parse from markdown code fences if the LLM wraps output.

### Step 2: Server API Endpoints (`server/main.py`)

Add three new routes:

#### `GET /v1/ai/health`
Returns `{ "provider": "ollama" | "openai" | "none", "model": "...", "available": true/false }`.

#### `POST /v1/ai/plan`
**Request:**
```json
{
  "intent": "Download daily SST data from NOAA FTP, subset to North Atlantic, convert to GeoTIFF, upload to S3",
  "manifest_summary": [...]  // optional; server can generate from loaded manifest
}
```
**Response:**
```json
{
  "pipeline": {
    "version": "1",
    "steps": [
      {
        "name": "acquire-ftp-1",
        "command": "zyra acquire ftp",
        "args": { "host": "ftp.noaa.gov", "path": "/pub/data/sst/daily", "pattern": "*.nc" },
        "depends_on": []
      },
      ...
    ]
  },
  "explanation": "This pipeline acquires SST data via FTP, subsets to the North Atlantic bounding box, converts from NetCDF to GeoTIFF, then uploads to your S3 bucket.",
  "provider": "ollama"
}
```

The returned pipeline object is compatible with the existing `handlePipelineChange` / deserialization path, so the editor can load it directly onto the canvas.

#### `POST /v1/ai/arg`
**Request:**
```json
{
  "stage": "acquire",
  "command": "ftp",
  "arg_key": "pattern",
  "arg_def": { "key": "pattern", "type": "string", "description": "..." },
  "current_values": { "host": "ftp.noaa.gov", "path": "/pub/data/sst" },
  "question": "What filename pattern should I use for daily SST files?"
}
```
**Response:**
```json
{
  "advice": "NOAA daily SST files typically follow the pattern `oisst-avhrr-v02r01.YYYYMMDD.nc`. Use `oisst-avhrr-v02r01.*.nc` to match all dates, or use a timestamp template like `oisst-avhrr-v02r01.{%Y%m%d}.nc` if Zyra supports date expansion.",
  "suggested_value": "oisst-avhrr-v02r01.*.nc",
  "provider": "ollama"
}
```

### Step 3: Vite Proxy Configuration

Add `/v1/ai` to the Vite proxy config in `packages/editor/vite.config.ts` (it's already covered by the `/v1` prefix proxy rule — verify this).

### Step 4: Frontend API Layer (`packages/editor/src/api.ts`)

Add three functions:

- `aiHealth(): Promise<AiHealthResponse>`
- `aiPlan(intent: string): Promise<AiPlanResponse>`
- `aiArgAdvice(req: AiArgRequest): Promise<AiArgResponse>`

Add corresponding TypeScript interfaces.

### Step 5: AI Planner Panel (`packages/editor/src/AiPlannerPanel.tsx`)

A new UI panel (drawer/sidebar) for the workflow planner:

**UI:**
- Text area for user intent (multi-line, placeholder: "Describe your data pipeline...")
- "Generate Workflow" button (shows spinner during request)
- Result area showing:
  - The AI's explanation text
  - A preview of the generated steps (list with stage icons)
  - "Load to Canvas" button → calls `handlePipelineChange` to populate the graph
  - "Refine" button → re-opens the text area with the intent pre-filled for iteration
- Provider badge (shows "Ollama" or "OpenAI" or "AI Unavailable")
- Error state if both providers are down

**Integration point:** The panel sits alongside the existing NodePalette (left side) or as a floating dialog triggered by a toolbar button. I recommend a toolbar button (sparkle/wand icon) that opens a modal/drawer overlay, to avoid cluttering the existing sidebar.

### Step 6: Arg Advisor UI (`packages/editor/src/AiArgAdvisor.tsx`)

A small popover/tooltip component for per-argument AI help:

**UI:**
- Small "?" or sparkle icon button next to each arg field in NodeDetailPanel
- Clicking opens a popover with:
  - Auto-generated question based on arg context (editable)
  - "Ask AI" button
  - Response area with the advice text
  - "Apply suggestion" button (fills the arg value if `suggested_value` is returned)
- Only shown when AI is available (check `/v1/ai/health` on mount)

**Integration:** Modify `NodeDetailPanel.tsx` to render the advisor button next to each `ArgField`.

### Step 7: Docker & Environment Configuration

- Add `OLLAMA_URL`, `OLLAMA_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL` env vars to `docker-compose.yml` (with sensible defaults/comments)
- Add `openai` to `server/requirements.txt` (needed for fallback)
- Optionally add an `ollama` service to docker-compose for local development convenience (image: `ollama/ollama`)
- Document configuration in CLAUDE.md or a dedicated section

### Step 8: Prompt Engineering & Manifest Summary

This is critical for quality. The system prompts need:

**Plan prompt:**
- Zyra's 8 stage categories and their purpose (search, acquire, process, etc.)
- Available commands with their args (condensed from manifest)
- Output format specification (JSON Pipeline schema)
- Examples of good decompositions
- Instruction to only use stages that exist in the manifest
- Instruction to set reasonable default args and leave unknowns empty

**Arg prompt:**
- The specific stage/command context
- The argument definition (type, description, flag)
- Other currently-set argument values for context
- Domain knowledge hints (e.g., NOAA data naming conventions, common geospatial formats)
- Instruction to be concise and suggest a concrete value

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `server/ai_service.py` | **New** | LLM provider abstraction, prompt builders, response parsing |
| `server/main.py` | **Edit** | Add `/v1/ai/health`, `/v1/ai/plan`, `/v1/ai/arg` endpoints |
| `server/requirements.txt` | **Edit** | Add `openai`, `httpx` (for Ollama HTTP calls) |
| `packages/editor/src/api.ts` | **Edit** | Add `aiHealth`, `aiPlan`, `aiArgAdvice` functions + types |
| `packages/editor/src/AiPlannerPanel.tsx` | **New** | Workflow planner UI component |
| `packages/editor/src/AiArgAdvisor.tsx` | **New** | Per-argument AI help popover |
| `packages/editor/src/App.tsx` | **Edit** | Add planner panel trigger button + state, wire `handlePipelineChange` |
| `packages/editor/src/NodeDetailPanel.tsx` | **Edit** | Add AI advisor button next to each arg field |
| `docker-compose.yml` | **Edit** | Add env vars for LLM config, optional Ollama service |
| `packages/editor/vite.config.ts` | **Verify** | Confirm `/v1/ai/*` proxied (should be covered by `/v1` rule) |

---

## Implementation Order

1. `server/ai_service.py` — Core LLM logic (testable independently)
2. `server/main.py` — API endpoints
3. `packages/editor/src/api.ts` — Frontend API functions
4. `packages/editor/src/AiPlannerPanel.tsx` + `App.tsx` integration — Planner UI
5. `packages/editor/src/AiArgAdvisor.tsx` + `NodeDetailPanel.tsx` integration — Arg advisor UI
6. `docker-compose.yml` + `requirements.txt` — Environment config
7. Prompt tuning and testing with real Ollama/OpenAI backends

---

## Open Questions / Decisions

1. **Ollama model choice**: `llama3` (8B) is fast but may struggle with complex JSON output. `llama3:70b` or `mixtral` would be more capable but slower. Default to `llama3` and let users configure?
2. **Streaming**: Should the planner stream tokens as they arrive, or wait for the full response? Streaming gives better UX but adds complexity. Recommend: start with non-streaming, add streaming later.
3. **Conversation memory**: Should the planner remember context across multiple refinements in the same session? Recommend: yes, keep a message history in the panel's React state so users can iterate ("now add a verification step").
4. **Rate limiting**: Should the server rate-limit AI calls? Probably not needed for a local tool, but worth considering if OpenAI costs are a concern.
