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

### Path 2: Stdout/stderr question detection (with byte-level reader)

When `"clarification needed:"` is absent but the CLI prompts via `input()`. The question text appears on stdout or stderr and is detected by heuristics.

**Stdout byte-level reader:** Python's `input()` writes prompts to stdout **without a trailing newline**. A line-based reader (`async for line in proc.stdout:`) would never see these prompts until the pipe closed. The server uses a custom byte-level reader (`_read_stdout`) that reads raw chunks and flushes partial lines after a **0.5-second timeout**. This detects `input()` prompts while the process is still alive and blocked waiting for stdin.

**Detection heuristics** (`_classify_stdout_line()`):
- Ends with `?`, `> `, `[y/n]`, `]: `, `): ` (suffix check)
- Matches patterns: `please (provide|specify|confirm|...)`, `could you ...`, `what is/should/would ...`, `provide value for 'X':`
- Matches `input()` prompts: `_INPUT_PROMPT_RE` matches `[agent — command] Provide value for 'arg':`
- Contains `?` anywhere (excluding log prefixes like `DEBUG`, `INFO`, `http`)

**Extraction from `input()` prompts:**
- `_QUESTION_ARG_RE` extracts arg key from `the 'path'` or `for 'path'` patterns
- `_INPUT_BRACKET_RE` extracts agent_id from the bracketed prefix `[fetch_sst_data — acquire ftp]`
- Both are used by `_enrich_question()` to produce structured clarification items

**Server flow:**
1. `_read_stderr()` or `_read_stdout()` classifies line as `"question"`
2. Buffers in `pending_questions`, sets `question_event`
3. Also detects `"hint:"` lines and buffers them in `recent_hints`
4. Main loop wakes, sleeps 0.3s for hints to arrive
5. **Auto-replay check:** Before presenting a card, checks `collected_answers` for a matching `(agent_id, arg_key)` pair (exact match, then fallback by `arg_key` alone). If found, silently replays the previous answer to stdin and continues without showing a card. This handles the common case where the planner asks for the same arg twice (once in the clarification round, once via `input()` after FTP listing).
6. `_enrich_question()` parses question text + hints, looks up manifest
7. Sends enriched `{"type": "clarification", ...}` to frontend
8. Waits for answer, writes to stdin

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
- `PYTHONUNBUFFERED=1` ensures prompt text is flushed immediately to stdout
- The byte-level stdout reader flushes partial lines (no trailing `\n`) after 0.5s, so `input()` prompts are detected promptly
- Answers are written as `value + "\n"` to stdin, then drained
- `answer_ready_event` is cleared after each write to prevent spurious "Continuing with your answer..." messages in the next loop iteration

## Event Priority in the Main Loop

When multiple events fire simultaneously in `asyncio.wait()`, they are checked in this order:

1. **`question_wait`** (if `clarification_wait` not also fired) — present enriched question
2. **`clarification_wait`** — parse structured clarifications from stderr
3. **`proc_done`** — process exited, break out of loop
4. **`answer_wait`** (if no question/clarification) — write answer directly to stdin

This priority order ensures that when the process emits a question on stderr and then exits almost immediately (both `proc_done` and `question_wait` fire in the same `asyncio.wait` call), the question is presented to the user first. The answer can be merged into the final plan.

## Scope Instruction

The zyra CLI's LLM planner tends to generate overly ambitious pipelines — e.g. adding visualization, narration, and video composition steps when the user only asked to download data. The editor server appends a **scope instruction** to the intent before passing it to `zyra plan`. The instruction uses a stage-based approach: it tells the LLM to first identify which zyra stages are needed, then only generate agents from those stages:

```
IMPORTANT: Before generating agents, first identify which zyra stages
(e.g. acquire, process, visualize, narrate, verify, compose) are actually
required to fulfill this request. Then generate agents ONLY from those
stages. Do NOT include agents from stages the user did not ask for.
For example, if the user asks to download data, only use 'acquire' stage
agents — do not add 'visualize', 'narrate', or 'compose' stages unless
explicitly requested.
```

This is configurable via the `ZYRA_PLAN_SCOPE` environment variable:
- Default: the stage-based instruction above
- Set to empty string (`ZYRA_PLAN_SCOPE=""`) to disable and get the planner's full output
- Set to custom text to override the default instruction

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
              │  1. question_wait   │  (priority order)        │
              │  2. clarification   │                          │
              │  3. proc_done       │                          │
              │  4. answer_wait     │                          │
              │  5. cancel_task     │                          │
              └──────┬──────────────┘                          │
                     │                                         │
         ┌───────────┼───────────┬──────────┬─────────┐        │
         ▼           ▼           ▼          ▼         ▼        │
      timeout    question_ev  clarif_ev  proc_done answer_ev   │
         │           │           │          │         │        │
     kill proc   auto-replay  parse &    break out  write to   │
     send error  or enrich &  enrich     drain I/O  stdin      │
     return      send card    send card  check plan directly   │
                 wait answer  wait ans   fallback?             │
                 write stdin  write stdin                       │
                 clear events clear events          │          │
                     │           │                  │          │
                     └───────────┴──────────────────┘──────────┘
                                  continue loop
```

## Auto-Replay of Duplicate Questions

The zyra planner often asks for the same argument twice: once in the initial `"clarification needed:"` round on stderr, and again via `input()` on stdout after doing FTP listing or other work. The server tracks all answered questions in `collected_answers` and checks for duplicates before presenting a new card.

**Matching strategy** (in order):
1. **Exact match:** `(agent_id, arg_key)` pair matches a previous answer
2. **Arg-key fallback:** `arg_key` alone matches (handles the common case where the planner uses different agent_ids across rounds, e.g. `"acquire_ftp"` from stderr vs `"fetch_sst_data"` from the `input()` prompt's bracket prefix)

When a match is found, the previous answer is silently replayed to stdin with a `"Using your previous answer..."` status message. No UI card is shown.

## Non-Interactive Fallback

When the interactive planner exits without producing plan JSON but the user provided answers during the session, the server automatically retries using `zyra plan --no-clarify` with answers baked into the intent string:

```python
augmented = f"{intent} (use these values: acquire_ftp.path=ftp://..., ...)"
cmd = ["zyra", "plan", "--intent", augmented, "--no-clarify"]
```

This uses the simpler synchronous code path and avoids the complexity of the interactive `input()` flow. The `_merge_answers_into_plan()` function patches any missing args into the resulting plan.

## Post-Mortem Diagnostics

When the planner exits without producing a plan, the server:

1. **Logs detailed diagnostics** at INFO/WARNING level:
   - Exit code, `plan_sent` status, number of collected answers
   - Last 10 stdout lines and last 10 stderr lines
   - Non-sensitive stdin metadata (which argument was answered); sensitive values such as passwords, tokens, and API keys should be redacted before logging

2. **Shows diagnostics to the user** in the error message:
   - Last few non-DEBUG stderr/stdout lines
   - Any pending unanswered questions
   - If the planner was asking for something specific

3. **Checks stderr for plan JSON**: In case the CLI outputs the plan to stderr instead of stdout, `_read_stderr()` also parses JSON lines with an `"agents"` key.

4. **Collects rolling tails**: `_stderr_tail` (last 30 lines) and `_stdout_lines` (last 50 lines) are maintained for post-mortem analysis.

## Plan Merging

`_merge_answers_into_plan(plan_data)` patches collected user answers into the plan JSON. This handles cases where the CLI's plan output doesn't include values the user provided during clarification.

**Matching strategy:**
- Tries matching answers to agents by: agent `id`, `command` name, `stage_command` combo, and lowercase variants
- Only fills in args that are missing or empty in the plan
- Also tries bare key matching (strips leading dashes from flag-style keys)

## Manifest Enrichment

When enriching a question/clarification with manifest metadata:

1. **`_parse_clarification(detail)`** — Regex extracts `agent_id` and `arg_key` from structured `"clarification needed:"` text
2. **`_enrich_question(text, hints, manifest)`** — Extracts:
   - `arg_key` from `the 'path'` or `for 'path'` patterns (`_QUESTION_ARG_RE`)
   - `agent_id` from bracketed prefix `[fetch_sst_data — acquire ftp]` (`_INPUT_BRACKET_RE`) or from `"for the X command"` (`_QUESTION_AGENT_RE`)
   - Default value from `"hint: ... (default: value)"` lines
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
| `done` | Plan preview with expandable, editable agent cards |
| `error` | Error message with diagnostics and retry button |

The `"asking"` phase (plain text input) still exists in the frontend for backward compatibility but is no longer triggered — all questions now go through the `"clarifying"` path.

## Plan Preview: Editable Agent Cards

When the plan is generated (`done` phase), each step is shown as an expandable `AgentCard`:

**Collapsed view:**
- Expand/collapse triangle, stage badge (colored), command name, agent ID
- Dependency list (`depends on: ...`)

**Expanded view (click to toggle):**
- **Editable arg values:** Click any value to edit inline (Enter to save, Escape to cancel). Changes update `editableAgents` state immediately.
- **Remove args:** Small x button on each row
- **Add args:** `"+ add argument"` link opens a form with:
  - **Manifest-aware dropdown** for the key: populated from the `StageDef.args` for this stage+command, filtered to exclude already-set args. Required args marked with `*`. Selecting an arg pre-fills the default value and shows the arg's description.
  - **"custom..." option** falls back to a free-text key input for arbitrary args not in the manifest
  - Value input with placeholder from manifest default

All edits are applied when the user clicks **"Apply to Canvas"**, which calls `planToGraph()` to convert the (potentially modified) agent list into graph nodes and edges.

## Sync Fallback

If the WebSocket connection fails on initial connect (chat has <= 1 entry), the frontend falls back to `POST /v1/plan` which runs `zyra plan --no-clarify` (no interactive questions, uses defaults for all args). This produces a plan without clarification but may have suboptimal argument values.

## Key Files

| File | Relevant Code |
|------|---------------|
| `server/main.py` | `ws_plan()` — WebSocket endpoint, subprocess management, clarification loop |
| `server/main.py` | `_read_stdout()` — Byte-level stdout reader with 0.5s partial-line timeout |
| `server/main.py` | `_read_stderr()` — Stderr reader, clarification interception, plan detection on stderr |
| `server/main.py` | `_classify_stdout_line()` — Question detection heuristics |
| `server/main.py` | `_enrich_question()` — Manifest enrichment for stdout questions |
| `server/main.py` | `_parse_clarification()` — Regex parsing for stderr clarifications |
| `server/main.py` | `_lookup_arg_meta()` — Three-pass manifest ArgDef lookup |
| `server/main.py` | `_merge_answers_into_plan()` — Patches collected answers into plan JSON |
| `server/main.py` | `_fallback_non_interactive()` — Retry with `--no-clarify` and baked-in answers |
| `packages/editor/src/usePlanSession.ts` | WebSocket hook, phase state machine |
| `packages/editor/src/PlannerPanel.tsx` | `ClarificationCard` — Rich question UI (enum dropdown, defaults) |
| `packages/editor/src/PlannerPanel.tsx` | `AgentCard` — Expandable step card with inline arg editing |
| `packages/editor/src/PlannerPanel.tsx` | `ArgRow` — Inline editable arg key-value row |
| `packages/editor/src/PlannerPanel.tsx` | `AddArgRow` — Manifest-aware dropdown for adding new args |
| `packages/editor/src/planToGraph.ts` | `PlanAgent`, `PlanResponse` types; `planToGraph()` conversion |
