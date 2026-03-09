# Interactive AI Planner via WebSocket

## Overview

Replace the synchronous `POST /v1/plan` flow (which uses `--no-clarify`) with a bidirectional WebSocket session that runs `zyra plan` **without** `--no-clarify`, relaying clarification questions to the user in a chat UI and feeding answers back to the CLI's stdin. The existing sync endpoint is kept as a fallback.

---

## How It Works Today

```
Frontend                    Server                      CLI
   │ POST /v1/plan            │                           │
   │─────────────────────────>│ subprocess.run(            │
   │                          │   zyra plan --no-clarify)  │
   │                          │──────────────────────────>│
   │                          │        (blocks 0-120s)     │
   │                          │<─────── JSON on stdout ───│
   │<──── JSON response ──────│                           │
```

## How It Will Work

```
Frontend                    Server                      CLI
   │ ws://host/ws/plan        │                           │
   │─────────────────────────>│ Popen(zyra plan)          │
   │                          │──────────────────────────>│
   │                          │                           │
   │<── {type:"clarification"}│<─── question on stdout ──│
   │── {type:"answer"} ──────>│──── answer on stdin ────>│
   │                          │                           │
   │<── {type:"plan"} ────────│<─── JSON on stdout ──────│
   │          ws.close()      │     process exits         │
```

---

## Message Protocol

### Client → Server

```jsonc
// Start planning session
{ "type": "start", "intent": "download SST data", "guardrails": "" }

// Answer a clarification question
{ "type": "answer", "text": "I want daily data from NOAA FTP" }

// Cancel the session
{ "type": "cancel" }
```

### Server → Client

```jsonc
// Clarification question from zyra (enriched with manifest metadata)
{ "type": "clarification", "index": 0, "total": 1, "agent_id": "fetch_ftp",
  "arg_key": "path", "kind": "missing", "label": "Path",
  "description": "Which data source would you like to use?",
  "arg_type": "string", "options": null, "default": null,
  "importance": "required" }

// Status update (zyra is thinking)
{ "type": "status", "text": "Generating plan..." }

// Intermediate stderr output (progress info)
{ "type": "log", "text": "Querying LLM..." }

// Final plan JSON
{ "type": "plan", "data": { "intent": "...", "agents": [...], "suggestions": [...] } }

// Error
{ "type": "error", "text": "zyra plan timed out" }
```

> **Note:** All questions (whether detected from structured stderr `"clarification needed:"` lines or from stdout/stderr heuristics) are enriched with manifest metadata and sent as `"clarification"` messages. The `"question"` type is intentionally unused — see `docs/PLANNER_DATA_FLOW.md` for full details.

---

## Implementation Steps

### Step 1: Server — `/ws/plan` WebSocket endpoint (`server/main.py`)

Add a new WebSocket endpoint that manages an interactive subprocess:

1. Accept WebSocket connection, wait for `{"type": "start", ...}` message
2. Spawn `zyra plan --intent <intent>` (no `--no-clarify`) via `asyncio.create_subprocess_exec` with `stdin=PIPE, stdout=PIPE, stderr=PIPE`
3. Read stdout line-by-line in an async task:
   - Lines starting with `{` that parse as JSON containing `"agents"` → send `{"type": "plan", "data": ...}`
   - Lines ending with `?` or containing prompt markers (`>`, `[y/n]`) → enrich with manifest metadata, send `{"type": "clarification", ...}`
   - Other lines → send `{"type": "log", "text": ...}`
4. Read stderr in a parallel async task → send `{"type": "log", ...}`
5. Listen for client messages:
   - `{"type": "answer", "text": "..."}` → write to subprocess stdin + newline
   - `{"type": "cancel"}` → kill subprocess
6. On subprocess exit → send final status, close WebSocket
7. 120-second overall timeout; keepalive pings every 15s

**Key detail:** The question-detection heuristic (ends with `?`, prompt markers) may need tuning after testing with the actual CLI. This is a pragmatic starting point.

### Step 2: Keep existing sync endpoint as fallback

`POST /v1/plan` with `--no-clarify` stays unchanged. The frontend prefers WebSocket but falls back to sync if the connection fails.

### Step 3: Frontend — `usePlanSession` hook (`packages/editor/src/usePlanSession.ts`)

New file. Manages the WebSocket planning session and chat state:

```ts
interface ChatEntry {
  role: "assistant" | "user" | "status";
  text: string;
  timestamp: number;
}

function usePlanSession() {
  // State
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "asking" | "thinking" | "done" | "error">("idle");
  const wsRef = useRef<WebSocket | null>(null);

  // Actions
  const start = (intent: string, guardrails?: string) => { /* open ws, send start */ };
  const answer = (text: string) => { /* send answer, add to chat */ };
  const cancel = () => { /* close ws, kill subprocess */ };

  return { chat, plan, phase, start, answer, cancel };
}
```

### Step 4: Frontend — Chat UI in `PlannerPanel.tsx`

Modify the existing PlannerPanel to add a conversational interface **between** the intent input and the plan preview:

**UX flow:**
1. User types intent, clicks "Plan" (same as today)
2. A **chat thread** appears instead of just a spinner
3. Clarification questions appear as assistant messages
4. User types answers in an input field
5. Once zyra produces the final plan, step cards appear below (same as today)
6. If WebSocket fails, automatically falls back to sync `POST /v1/plan` with `--no-clarify`

**Layout:**
```
┌─────────────────────────────┐
│  Intent: [download SST data]│
├─────────────────────────────┤
│  Q: Which data source?      │
│  A: NOAA FTP, daily files   │
│  Q: What spatial region?    │  ← chat thread (scrollable)
│  A: North Atlantic only     │
│  ...Generating plan...      │
├─────────────────────────────┤
│  [Type your answer...] [Send]│  ← visible during Q&A phase
├─────────────────────────────┤
│  STEPS (4)                  │
│  ├ ACQUIRE ftp              │
│  ├ PROCESS subset           │  ← same step cards as today
│  ├ PROCESS convert          │
│  └ EXPORT upload            │
├─────────────────────────────┤
│  [Apply to Canvas (4 nodes)]│
└─────────────────────────────┘
```

### Step 5: Vite proxy — verify `/ws/plan` routing

Check that the existing Vite proxy config covers `/ws/plan`. The current `/ws` proxy rule likely already handles it — just verify.

---

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `server/main.py` | **Edit** | Add `/ws/plan` WebSocket endpoint (~60 lines) |
| `packages/editor/src/usePlanSession.ts` | **New** | Hook for WebSocket planning session + chat state |
| `packages/editor/src/PlannerPanel.tsx` | **Edit** | Add chat thread UI, wire up `usePlanSession`, keep sync fallback |
| `packages/editor/vite.config.ts` | **Verify** | Ensure `/ws/plan` proxied (likely already covered) |

---

## Risks & Mitigations

1. **Unknown zyra clarify output format** — We don't know exactly how zyra outputs questions without `--no-clarify`. The heuristic approach works for most cases. Mitigation: debug logging, refine heuristics after testing.

2. **zyra might not support interactive stdin** — If it reads answers via a different mechanism, stdin won't work. Mitigation: sync fallback remains functional.

3. **WebSocket proxy issues** — Some reverse proxies may not support WebSocket. Mitigation: automatic fallback to sync `POST /v1/plan`.

4. **Long-running sessions** — 120s timeout with keepalive pings; user can cancel anytime.

---

## What This Does NOT Change

- No changes to `@zyra/core`
- No changes to `planToGraph.ts`
- No new npm dependencies
- Existing sync `POST /v1/plan` and `POST /v1/plan/refine` endpoints unchanged
- All existing PlannerPanel features (editable agents, suggestions, history, batch undo) preserved
- Existing job execution WebSocket (`/ws/jobs/{jobId}`) unchanged
