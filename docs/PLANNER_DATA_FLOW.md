# AI Planner Data Flow

How clarification questions flow between the zyra CLI, the editor server, and the editor UI during interactive plan generation.

## Architecture Overview

```
┌─────────────────┐    WebSocket     ┌──────────────────┐    subprocess    ┌──────────────┐
│  Editor UI      │◄──────────────►  │  Editor Server   │◄──────────────► │  zyra plan   │
│  (React)        │   /ws/plan       │  (FastAPI)       │   stdin/stdout  │  (CLI)       │
│                 │                  │                  │   /stderr       │              │
│  PlannerPanel   │                  │  main.py         │                 │  swarm       │
│  usePlanSession │                  │  ws_plan()       │                 │  planner     │
└─────────────────┘                  └──────────────────┘                 └──────────────┘
```

## WebSocket Message Protocol

### Client -> Server

| Message | When | Purpose |
|---------|------|---------|
| `{"type": "start", "intent": "...", "guardrails": "..."}` | User clicks Generate Plan | Starts a new planning session |
| `{"type": "answer", "text": "..."}` | User answers a question | Provides clarification answer |
| `{"type": "cancel"}` | User clicks Cancel | Kills subprocess and closes session |

### Server -> Client

| Message | When | Frontend Phase |
|---------|------|----------------|
| `{"type": "status", "text": "..."}` | Progress updates | (unchanged) |
| `{"type": "log", "text": "..."}` | CLI output lines | (unchanged) |
| `{"type": "clarification", ...}` | Subprocess needs input | `"clarifying"` |
| `{"type": "plan", "data": {...}}` | Plan generated | `"done"` |
| `{"type": "error", "text": "..."}` | Timeout or failure | `"error"` |

The `"question"` message type is intentionally unused. All questions are enriched with manifest metadata and sent as `"clarification"` messages to ensure the rich ClarificationCard UI is shown (dropdowns for enums, defaults, confirm/override).

## Clarification Item Schema

```typescript
{
  type: "clarification",
  index: 0,              // Question number (0-indexed)
  total: 3,              // Total questions in this round
  agent_id: "fetch_ftp", // Which plan agent needs the arg
  arg_key: "path",       // Argument name
  kind: "missing" | "confirm" | "unknown",
  label: "Path",         // Human-friendly label (from manifest)
  description: "...",    // Help text or original question text
  arg_type: "string" | "number" | "boolean" | "filepath" | "enum",
  placeholder: "",
  default: null,         // Pre-filled default value
  options: ["a", "b"],   // Choices for enum dropdown (null if not enum)
  current_value: null,   // For "confirm" kind: the value to keep or override
  importance: "required" | "recommended" | ""
}
```

## Question Detection: Three Paths

The zyra CLI can signal questions through three different mechanisms. The server handles all of them:

### Path 1: Structured stderr (`"clarification needed:"`)

Best case. The zyra swarm planner's `_detect_clarifications()` outputs structured lines to stderr:

```
stderr: "clarification needed: Agent 'fetch_ftp' is missing required argument 'path'"
```

**Server flow:**
1. `_read_stderr()` intercepts lines starting with `"clarification needed:"`
2. Appends detail text to `clarifications` list, sets `clarification_event`
3. Main loop wakes, sleeps 0.5s to batch, then parses with `_parse_clarification()` regex
4. Enriches with manifest metadata via `_lookup_arg_meta()` (label, type, choices, default)
5. Sends `{"type": "clarification", ...}` to frontend
6. Waits for answer from `answer_queue`, writes to subprocess stdin

### Path 2: Stdout/stderr question detection

When `"clarification needed:"` is absent but the CLI prompts via `input()`. The question text appears on stdout or stderr and is detected by heuristics.

**Detection heuristics** (`_classify_stdout_line()`):
- Ends with `?`, `> `, `[y/n]`, `]: `, `): ` (suffix check)
- Matches patterns: `please (provide|specify|confirm|...)`, `could you ...`, `what is/should/would ...`
- Contains `?` anywhere (excluding log prefixes like `DEBUG`, `INFO`, `http`)

**Server flow:**
1. `_read_stderr()` or `_read_stdout()` classifies line as `"question"`
2. Buffers in `pending_questions`, sets `question_event`
3. Also detects `"hint:"` lines and buffers them in `recent_hints`
4. Main loop wakes, sleeps 0.3s for hints to arrive
5. `_enrich_question()` parses question text + hints, looks up manifest
6. Sends enriched `{"type": "clarification", ...}` to frontend
7. Waits for answer, writes to stdin

### Path 3: Direct answer passthrough

Fallback when an answer arrives but neither clarification nor question events fired (e.g., the question was too unusual to detect). The `answer_ready_event` triggers and the answer is written directly to stdin.

## Subprocess Environment

The server launches `zyra plan` with:

```python
env = {
    "ZYRA_FORCE_PLAN_PROMPT": "1",  # Forces input() even when stdin is a pipe
    "PYTHONUNBUFFERED": "1",         # Flushes prompt text immediately
}
proc = create_subprocess_exec(
    "zyra", "plan", "--intent", intent,
    stdin=PIPE, stdout=PIPE, stderr=PIPE,
    env=env,
)
```

Key behaviors:
- `ZYRA_FORCE_PLAN_PROMPT=1` bypasses the TTY check so `input()` works over a pipe
- `PYTHONUNBUFFERED=1` ensures prompt text is flushed immediately (though `input()` prompts have no trailing newline, so `async for line in proc.stdout:` may not yield them until the next newline arrives)
- Answers are written as `value + "\n"` to stdin, then drained

## Main Loop State Machine

```
                    ┌──────────┐
                    │  START   │
                    └────┬─────┘
                         │ launch subprocess
                         ▼
              ┌─────────────────────┐
              │   asyncio.wait()    │◄─────────────────────────┐
              │                     │                          │
              │  proc_done          │                          │
              │  clarification_wait │                          │
              │  question_wait      │                          │
              │  answer_wait        │                          │
              │  cancel_task        │                          │
              └──────┬──────────────┘                          │
                     │                                         │
         ┌───────────┼───────────┬──────────┬─────────┐        │
         ▼           ▼           ▼          ▼         ▼        │
      timeout    proc_done   clarif_ev  question_ev answer_ev  │
         │           │           │          │         │        │
     kill proc   break out   parse &     enrich &   write to  │
     send error  drain I/O   enrich      send as    stdin     │
     return      send plan   send card   card       directly  │
                             wait ans    wait ans              │
                             write stdin write stdin            │
                                │          │         │        │
                                └──────────┴─────────┘────────┘
                                       continue loop
```

## Manifest Enrichment

When enriching a question/clarification with manifest metadata:

1. **`_parse_clarification(detail)`** — Regex extracts `agent_id` and `arg_key` from structured `"clarification needed:"` text
2. **`_enrich_question(text, hints, manifest)`** — Extracts arg key from `'single quotes'` in question text, agent from "for the X command" pattern, default from `"hint: ... (default: value)"` lines
3. **`_lookup_arg_meta(manifest, agent_id, arg_key)`** — Three-pass manifest search:
   - Pass 1: Exact command name match
   - Pass 2: agent_id contains command name (e.g. `"fetch_ftp_data"` contains `"ftp"`)
   - Pass 3: Search all stages for the arg key

Returns the manifest ArgDef with: `label`, `description`, `type`, `choices` (for enum), `default`, `placeholder`.

## Frontend Phase Transitions

```
idle ──► thinking ──► clarifying ──► thinking ──► clarifying ──► thinking ──► done
                  │                                                       │
                  └──► error                                              └──► error
```

| Phase | UI State |
|-------|----------|
| `idle` | Initial state, Generate Plan button visible |
| `thinking` | Loading spinner with elapsed timer |
| `clarifying` | ClarificationCard shown (dropdown/text input/confirm) |
| `done` | Plan preview with editable agent cards |
| `error` | Error message with retry button |

The `"asking"` phase (plain text input) still exists in the frontend for backward compatibility but is no longer triggered — all questions now go through the `"clarifying"` path.

## Sync Fallback

If the WebSocket connection fails on initial connect (chat has <= 1 entry), the frontend falls back to `POST /v1/plan` which runs `zyra plan --no-clarify` (no interactive questions, uses defaults for all args). This produces a plan without clarification but may have suboptimal argument values.

## Key Files

| File | Relevant Code |
|------|---------------|
| `server/main.py` | `ws_plan()` — WebSocket endpoint, subprocess management, clarification loop |
| `server/main.py` | `_classify_stdout_line()` — Question detection heuristics |
| `server/main.py` | `_enrich_question()` — Manifest enrichment for stdout questions |
| `server/main.py` | `_parse_clarification()` — Regex parsing for stderr clarifications |
| `server/main.py` | `_lookup_arg_meta()` — Three-pass manifest ArgDef lookup |
| `packages/editor/src/usePlanSession.ts` | WebSocket hook, phase state machine |
| `packages/editor/src/PlannerPanel.tsx` | `ClarificationCard` — Rich question UI (enum dropdown, defaults) |
| `packages/editor/src/PlannerPanel.tsx` | Main panel: chat thread, loading state, error guidance |
