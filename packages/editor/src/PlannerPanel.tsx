import { useState, useCallback, useRef, useEffect } from "react";
import type { Node, Edge } from "@xyflow/react";
import type { Manifest } from "@zyra/core";
import {
  planToGraph,
  type PlanAgent,
  type PlanSuggestion,
  type PlanResponse,
} from "./planToGraph";
import type { BackendStatus } from "./useBackendStatus";
import { usePlanSession, type ChatEntry, type ClarificationItem } from "./usePlanSession";

/** Stage header colours — mirrors server/main.py STAGE_COLORS. */
const STAGE_COLORS: Record<string, string> = {
  control: "#888888",
  search: "#1E90FF",
  acquire: "#00529E",
  process: "#2C670C",
  visualize: "#7B2D8E",
  narrate: "#7B2D8E",
  verify: "#555555",
  export: "#B8860B",
  decide: "#C04000",
  simulate: "#C04000",
};

/** Error guidance keyed by HTTP status code. */
const ERROR_GUIDANCE: Record<number | string, string> = {
  503: "The zyra CLI is not installed in the server container. Rebuild with zyra[api] in requirements.txt.",
  504: "The planner timed out (120s limit). Try a simpler intent or check that the LLM backend (OPENAI_API_KEY / OLLAMA_HOST) is configured.",
  400: "The planner returned an error. Try rephrasing your intent description.",
  502: "The planner produced invalid output. This may be a transient LLM issue — try again.",
  network: "Could not reach the server. Check that the backend is running at localhost:8765.",
};

export interface PlanHistoryEntry {
  intent: string;
  plan: PlanResponse;
  timestamp: number;
}

export interface PlanBatch {
  nodeIds: string[];
  edgeIds: string[];
  intent: string;
  timestamp: number;
}

interface PlannerPanelProps {
  manifest: Manifest;
  onApply: (nodes: Node[], edges: Edge[]) => void;
  onClose: () => void;
  // Lifted state from App.tsx
  intent: string;
  onIntentChange: (v: string) => void;
  history: PlanHistoryEntry[];
  onHistoryAdd: (entry: PlanHistoryEntry) => void;
  onHistoryRemove: (idx: number) => void;
  batches: PlanBatch[];
  onUndoBatch: () => void;
  backendStatus: BackendStatus;
}

export function PlannerPanel({
  manifest,
  onApply,
  onClose,
  intent,
  onIntentChange,
  history,
  onHistoryAdd,
  onHistoryRemove,
  batches,
  onUndoBatch,
  backendStatus,
}: PlannerPanelProps) {
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [editableAgents, setEditableAgents] = useState<PlanAgent[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [lastFeedback, setLastFeedback] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [wsMode, setWsMode] = useState(true); // true = try WebSocket, false = sync fallback
  const [logOpen, setLogOpen] = useState(false);

  // Track accepted / dismissed suggestion indices
  const [acceptedIdxs, setAcceptedIdxs] = useState<Set<number>>(new Set());
  const [dismissedIdxs, setDismissedIdxs] = useState<Set<number>>(new Set());

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Interactive WebSocket planning session
  const session = usePlanSession();

  // When WebSocket session produces a plan, sync it into local state
  useEffect(() => {
    if (session.plan) {
      setPlan(session.plan);
      setLoading(false);
      onHistoryAdd({ intent: intent.trim(), plan: session.plan, timestamp: Date.now() });
    }
  }, [session.plan]); // eslint-disable-line react-hooks/exhaustive-deps

  // When WebSocket errors, fall back to sync mode
  useEffect(() => {
    if (session.phase === "error" && session.error) {
      // If WS failed on connection (not during Q&A), fall back to sync
      if (session.chat.length <= 1) {
        setWsMode(false);
        // Automatically retry with sync
        handleSyncGenerate();
      } else {
        // Map known WS error messages to status codes for correct guidance
        const status = session.error.toLowerCase().includes("timed out") ? 504 : undefined;
        setError({ message: session.error, status });
        setLoading(false);
      }
    }
  }, [session.phase, session.error]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.chat]);

  // Elapsed timer during loading
  useEffect(() => {
    if (loading) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [loading]);

  // Sync editableAgents when plan changes
  useEffect(() => {
    if (plan) {
      setEditableAgents([...plan.agents]);
    }
  }, [plan]);

  /** Sync fallback: POST /v1/plan with --no-clarify (original behavior). */
  const handleSyncGenerate = useCallback(async () => {
    if (!intent.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setPlan(null);
    setEditableAgents([]);
    setAcceptedIdxs(new Set());
    setDismissedIdxs(new Set());
    setFeedback("");
    try {
      const resp = await fetch("/v1/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: intent.trim() }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        const err = { message: body.detail || `HTTP ${resp.status}`, status: resp.status };
        setError(err);
        return;
      }
      const data: PlanResponse & { _warning?: string } = await resp.json();
      if (data._warning) {
        setError({ message: data._warning, status: undefined });
      }
      setPlan(data);
      setLastFeedback("");
      onHistoryAdd({ intent: intent.trim(), plan: data, timestamp: Date.now() });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError({
        message: err instanceof Error ? err.message : "Unknown error",
        status: undefined,
      });
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [intent, onHistoryAdd]);

  /** Primary generate: try WebSocket (interactive) first, sync fallback. */
  const handleGenerate = useCallback(() => {
    if (!intent.trim()) return;
    setError(null);
    setPlan(null);
    setEditableAgents([]);
    setAcceptedIdxs(new Set());
    setDismissedIdxs(new Set());
    setFeedback("");
    setAnswerText("");
    setLoading(true);

    if (wsMode) {
      session.reset();
      session.start(intent.trim());
    } else {
      handleSyncGenerate();
    }
  }, [intent, wsMode, session, handleSyncGenerate]);

  const handleRefine = useCallback(async () => {
    if (!feedback.trim() || !plan) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/v1/plan/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: intent.trim(),
          feedback: feedback.trim(),
          current_plan: plan,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        setError({ message: body.detail || `HTTP ${resp.status}`, status: resp.status });
        return;
      }
      const data: PlanResponse = await resp.json();

      // Detect if the plan is unchanged (canned/template response)
      const oldIds = plan.agents.map((a) => `${a.stage}/${a.command}`).join(",");
      const newIds = data.agents.map((a) => `${a.stage}/${a.command}`).join(",");
      if (oldIds === newIds) {
        setError({
          message: "Refinement returned the same plan. The LLM backend may not be configured — check that OPENAI_API_KEY or OLLAMA_HOST is set in your .env file.",
          status: undefined,
        });
        return;
      }

      setPlan(data);
      setLastFeedback(feedback.trim());
      setFeedback("");
      setAcceptedIdxs(new Set());
      setDismissedIdxs(new Set());
      onHistoryAdd({ intent: intent.trim(), plan: data, timestamp: Date.now() });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError({
        message: err instanceof Error ? err.message : "Unknown error",
        status: undefined,
      });
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [feedback, plan, intent, onHistoryAdd]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    session.cancel();
    setLoading(false);
  }, [session]);

  const handleStartOver = useCallback(() => {
    abortRef.current?.abort();
    session.reset();
    setPlan(null);
    setEditableAgents([]);
    setAcceptedIdxs(new Set());
    setDismissedIdxs(new Set());
    setFeedback("");
    setLastFeedback("");
    setError(null);
    setAnswerText("");
    setLogOpen(false);
    onIntentChange("");
  }, [onIntentChange, session]);

  const handleAccept = useCallback((idx: number) => {
    if (!plan) return;
    const suggestion = plan.suggestions[idx];
    if (!suggestion) return;

    // Build an agent from the template if available, otherwise synthesize one
    // by matching the suggestion's stage to the first manifest command for that stage.
    let agent: PlanAgent;
    if (suggestion.agent_template) {
      agent = { ...suggestion.agent_template };
    } else {
      const matchingStage = manifest.stages.find(
        (s) => s.stage === suggestion.stage,
      );
      const stage = matchingStage?.stage ?? suggestion.stage;
      const command = matchingStage?.command ?? suggestion.stage;
      agent = {
        id: `${stage}_${command}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, "_"),
        stage,
        command,
        depends_on: [],
        args: {},
      };
    }

    // Add to editable agents and mark as accepted
    setEditableAgents((prev) => [...prev, agent]);
    setAcceptedIdxs((prev) => new Set(prev).add(idx));
    setDismissedIdxs((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  }, [plan, manifest]);

  const handleDismiss = useCallback((idx: number) => {
    // If this was previously accepted, remove the agent that was added
    setAcceptedIdxs((prev) => {
      if (prev.has(idx) && plan) {
        const suggestion = plan.suggestions[idx];
        if (suggestion) {
          const stage = suggestion.agent_template?.stage ?? suggestion.stage;
          const command = suggestion.agent_template?.command ?? suggestion.stage;
          setEditableAgents((agents) => {
            let lastMatchIdx = -1;
            for (let i = agents.length - 1; i >= 0; i--) {
              if (agents[i].stage === stage && agents[i].command === command) {
                lastMatchIdx = i;
                break;
              }
            }
            if (lastMatchIdx >= 0) {
              const next = [...agents];
              next.splice(lastMatchIdx, 1);
              return next;
            }
            return agents;
          });
        }
      }
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
    setDismissedIdxs((prev) => new Set(prev).add(idx));
  }, [plan]);


  // Editable agents: remove
  const handleRemoveAgent = useCallback((agentId: string) => {
    setEditableAgents((prev) => {
      const filtered = prev.filter((a) => a.id !== agentId);
      // Clean up dangling depends_on references
      return filtered.map((a) => ({
        ...a,
        depends_on: a.depends_on.filter((dep) => dep !== agentId),
      }));
    });
  }, []);

  // Editable agents: move up/down
  const handleMoveAgent = useCallback((idx: number, dir: -1 | 1) => {
    setEditableAgents((prev) => {
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    if (editableAgents.length === 0) return;
    // Accepted suggestions are already in editableAgents (added by handleAccept)
    const agents = [...editableAgents];
    const { nodes, edges } = planToGraph(agents, manifest);
    onApply(nodes, edges);
    onClose();
  }, [editableAgents, manifest, onApply, onClose]);

  // Restore a history entry
  const handleRestoreHistory = useCallback((entry: PlanHistoryEntry) => {
    onIntentChange(entry.intent);
    setPlan(entry.plan);
    setEditableAgents([...entry.plan.agents]);
    setAcceptedIdxs(new Set());
    setDismissedIdxs(new Set());
    setError(null);
    setHistoryOpen(false);
  }, [onIntentChange]);

  const suggestions = plan?.suggestions ?? [];
  const pendingSuggestions = suggestions
    .map((s, i) => ({ suggestion: s, idx: i }))
    .filter(({ idx }) => !acceptedIdxs.has(idx) && !dismissedIdxs.has(idx));

  const canGenerate = !loading && intent.trim().length > 0 && backendStatus.status === "ready";
  const statusNotReady = backendStatus.status !== "ready" && backendStatus.status !== "checking";

  return (
    <div style={{
      position: "absolute",
      top: 56,
      right: 8,
      width: 380,
      maxHeight: "calc(100vh - 120px)",
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-lg)",
      boxShadow: "0 8px 32px var(--node-shadow)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      zIndex: 100,
      fontFamily: "var(--font-sans)",
      fontSize: 13,
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-default)",
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text-bright)" }}>
          AI Planner
        </span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {history.length > 0 && (
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              title="Plan history"
              style={{
                background: historyOpen ? "var(--bg-tertiary)" : "none",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-muted)",
                fontSize: 11,
                cursor: "pointer",
                padding: "2px 6px",
                fontFamily: "var(--font-sans)",
              }}
            >
              History ({history.length})
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close planner"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 18,
              cursor: "pointer",
              padding: "2px 6px",
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>

        {/* History dropdown */}
        {historyOpen && history.length > 0 && (
          <div style={{
            marginBottom: 10,
            padding: "8px 10px",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            maxHeight: 180,
            overflowY: "auto",
          }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Previous Plans
            </div>
            {history.map((entry, i) => (
              <div key={i} style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 6px",
                marginBottom: 2,
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontSize: 11,
                color: "var(--text-secondary)",
              }}
                onClick={() => handleRestoreHistory(entry)}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--bg-secondary)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "none"; }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.intent.length > 60 ? entry.intent.slice(0, 57) + "..." : entry.intent}
                </span>
                <span style={{ fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onHistoryRemove(i); }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    padding: "0 2px",
                    lineHeight: 1,
                  }}
                  title="Remove from history"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Intent input — shown when no plan yet */}
        {!plan && (
          <>
            <textarea
              placeholder="Describe your pipeline... e.g. &quot;Download SST data and convert to GeoTIFF&quot;"
              value={intent}
              onChange={(e) => onIntentChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (canGenerate) handleGenerate();
                }
              }}
              rows={3}
              disabled={loading}
              style={{
                width: "100%",
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                padding: "8px 10px",
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
                opacity: loading ? 0.6 : 1,
              }}
            />
          </>
        )}

        {/* Frozen intent label — shown when plan exists */}
        {plan && (
          <div style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 6,
            marginBottom: 6,
          }}>
            <div style={{
              flex: 1,
              padding: "6px 10px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              fontSize: 12,
              color: "var(--text-secondary)",
              lineHeight: 1.5,
            }}>
              {intent}
            </div>
            <button
              onClick={handleStartOver}
              title="Clear plan and start over"
              style={{
                background: "none",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-muted)",
                fontSize: 10,
                cursor: "pointer",
                padding: "4px 8px",
                fontFamily: "var(--font-sans)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              New Plan
            </button>
          </div>
        )}

        {/* Follow-up refinement — placed near top for visibility */}
        {plan && !loading && (
          <div style={{ marginBottom: 12 }}>
            <textarea
              placeholder="Refine this plan... e.g. &quot;Add a verification step&quot; or &quot;Use GeoTIFF instead of NetCDF&quot;"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && feedback.trim()) {
                  e.preventDefault();
                  handleRefine();
                }
              }}
              rows={2}
              style={{
                width: "100%",
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                padding: "8px 10px",
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <button
              className="zyra-btn zyra-btn--primary"
              onClick={handleRefine}
              disabled={!feedback.trim() || !canGenerate}
              style={{
                width: "100%",
                marginTop: 6,
                opacity: feedback.trim() ? 1 : 0.5,
              }}
              title={
                statusNotReady
                  ? "Backend not ready — check AI status"
                  : !feedback.trim()
                    ? "Enter refinement feedback"
                    : "Refine Plan (Ctrl+Enter)"
              }
            >
              Refine Plan (Ctrl+Enter)
            </button>
            {statusNotReady && (
              <div style={{ fontSize: 10, color: "var(--accent-yellow)", marginTop: 4 }}>
                Backend not ready — check the AI status indicator in the toolbar.
              </div>
            )}
          </div>
        )}

        {/* Loading indicator */}
        {loading && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: plan ? 0 : 8,
            padding: "8px 12px",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            fontSize: 12,
          }}>
            <span style={{
              display: "inline-block",
              width: 14,
              height: 14,
              border: "2px solid var(--border-strong)",
              borderTopColor: "var(--accent-blue)",
              borderRadius: "50%",
              animation: "zyra-spin 0.8s linear infinite",
              flexShrink: 0,
            }} />
            <span style={{ color: "var(--text-secondary)", flex: 1 }}>
              {plan ? "Refining..." : "Generating..."} {elapsed}s
            </span>
            <button
              onClick={handleCancel}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent-red)",
                fontSize: 11,
                cursor: "pointer",
                fontWeight: 600,
                fontFamily: "var(--font-sans)",
                padding: "2px 4px",
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Chat thread (WebSocket interactive session) */}
        {session.chat.length > 0 && !plan && (
          <div style={{
            marginTop: 8,
            maxHeight: 200,
            overflowY: "auto",
            padding: "8px 10px",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
          }}>
            {session.chat.map((entry, i) => (
              <ChatBubble key={i} entry={entry} />
            ))}
            <div ref={chatEndRef} />
          </div>
        )}

        {/* Session log — collapsible, persists after plan completes */}
        {session.chat.length > 0 && plan && (
          <div style={{ marginBottom: 8 }}>
            <button
              onClick={() => setLogOpen((v) => !v)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                fontSize: 11,
                cursor: "pointer",
                padding: "4px 0",
                fontFamily: "var(--font-sans)",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span style={{
                display: "inline-block",
                fontSize: 8,
                transition: "transform 0.15s",
                transform: logOpen ? "rotate(90deg)" : "rotate(0deg)",
              }}>
                {"\u25B6"}
              </span>
              Session Log ({session.chat.length} entries)
            </button>
            {logOpen && (
              <div style={{
                marginTop: 4,
                maxHeight: 200,
                overflowY: "auto",
                padding: "8px 10px",
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
              }}>
                {session.chat.map((entry, i) => (
                  <ChatBubble key={i} entry={entry} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Answer input — visible during Q&A phase */}
        {session.phase === "asking" && (
          <div style={{
            display: "flex",
            gap: 6,
            marginTop: 8,
          }}>
            <input
              type="text"
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && answerText.trim()) {
                  e.preventDefault();
                  session.answer(answerText.trim());
                  setAnswerText("");
                }
              }}
              placeholder="Type your answer..."
              autoFocus
              style={{
                flex: 1,
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                padding: "6px 10px",
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <button
              className="zyra-btn zyra-btn--primary"
              onClick={() => {
                if (answerText.trim()) {
                  session.answer(answerText.trim());
                  setAnswerText("");
                }
              }}
              disabled={!answerText.trim()}
              style={{ padding: "6px 12px", fontSize: 12 }}
            >
              Send
            </button>
          </div>
        )}

        {/* Structured clarification Q&A — one question at a time */}
        {session.phase === "clarifying" && session.clarification && (
          <ClarificationCard
            item={session.clarification}
            value={answerText}
            onChange={setAnswerText}
            onSubmit={(val) => {
              session.answer(val);
              setAnswerText("");
            }}
            onCancel={() => {
              session.cancel();
              setAnswerText("");
            }}
          />
        )}

        {/* Sync fallback indicator */}
        {!wsMode && !plan && !loading && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, fontStyle: "italic" }}>
            Quick mode (no clarification)
          </div>
        )}

        {/* Generate button — only when no plan */}
        {!loading && !plan && session.phase !== "asking" && session.phase !== "clarifying" && (
          <>
            <button
              className="zyra-btn zyra-btn--primary"
              onClick={handleGenerate}
              disabled={!canGenerate}
              style={{ width: "100%", marginTop: 8 }}
              title={
                statusNotReady
                  ? "Backend not ready — check AI status"
                  : !intent.trim()
                    ? "Enter a pipeline description"
                    : "Generate Plan (Ctrl+Enter)"
              }
            >
              Generate Plan
            </button>
            {statusNotReady && (
              <div style={{ fontSize: 10, color: "var(--accent-yellow)", marginTop: 4 }}>
                Backend not ready — check the AI status indicator in the toolbar.
              </div>
            )}
          </>
        )}

        {/* Error with guidance */}
        {error && (
          <div style={{
            marginTop: 10,
            padding: "8px 10px",
            background: "rgba(248,81,73,0.15)",
            border: "1px solid rgba(248,81,73,0.4)",
            borderRadius: "var(--radius-md)",
            fontSize: 12,
          }}>
            <div style={{ color: "#f85149", marginBottom: 4 }}>{error.message}</div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
              {error.status
                ? ERROR_GUIDANCE[error.status] ?? "An unexpected error occurred."
                : ERROR_GUIDANCE.network}
            </div>
            <button
              onClick={handleGenerate}
              disabled={!intent.trim()}
              style={{
                marginTop: 6,
                background: "none",
                border: "1px solid rgba(248,81,73,0.4)",
                borderRadius: "var(--radius-sm)",
                color: "#f85149",
                fontSize: 11,
                cursor: "pointer",
                padding: "3px 10px",
                fontFamily: "var(--font-sans)",
                fontWeight: 600,
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Plan preview */}
        {plan && (
          <div style={{ marginTop: 14 }}>
            {/* Intent & refinement context */}
            <div style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              marginBottom: 10,
              lineHeight: 1.5,
            }}>
              <div style={{ marginBottom: lastFeedback ? 6 : 0 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Intent: </span>
                {intent.trim() || plan.intent}
              </div>
              {lastFeedback && (
                <div style={{
                  borderLeft: "2px solid var(--accent-blue, #58a6ff)",
                  paddingLeft: 8,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontStyle: "italic",
                }}>
                  Refined: {lastFeedback}
                </div>
              )}
            </div>

            {/* Editable agents list */}
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Steps ({editableAgents.length})
            </div>
            {editableAgents.map((agent, idx) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                index={idx}
                total={editableAgents.length}
                onRemove={() => handleRemoveAgent(agent.id)}
                onMoveUp={() => handleMoveAgent(idx, -1)}
                onMoveDown={() => handleMoveAgent(idx, 1)}
              />
            ))}
            {editableAgents.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic", padding: "4px 0" }}>
                All steps removed
              </div>
            )}

            {/* Suggestions */}
            {suggestions.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Suggestions ({suggestions.length})
                </div>

                {/* Pending suggestions */}
                {pendingSuggestions.map(({ suggestion, idx }) => (
                  <SuggestionCard
                    key={idx}
                    suggestion={suggestion}
                    onAccept={() => handleAccept(idx)}
                    onDismiss={() => handleDismiss(idx)}
                  />
                ))}

                {pendingSuggestions.length === 0 && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                    All suggestions dismissed
                  </div>
                )}
              </div>
            )}
            {suggestions.length === 0 && (
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
                No additional suggestions
              </div>
            )}

          </div>
        )}

        {/* Recent AI Batches */}
        {batches.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Recent AI Batches
            </div>
            {batches.map((batch, i) => (
              <div key={i} style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                marginBottom: 4,
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                fontSize: 11,
                color: "var(--text-secondary)",
              }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {batch.intent.length > 40 ? batch.intent.slice(0, 37) + "..." : batch.intent}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
                  {batch.nodeIds.length} nodes
                </span>
                {i === batches.length - 1 && (
                  <button
                    onClick={onUndoBatch}
                    style={{
                      background: "none",
                      border: "1px solid rgba(248,81,73,0.4)",
                      borderRadius: "var(--radius-sm)",
                      color: "#f85149",
                      fontSize: 10,
                      cursor: "pointer",
                      padding: "1px 6px",
                      fontFamily: "var(--font-sans)",
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                    title="Remove this batch from the canvas"
                  >
                    Undo
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer: Apply button */}
      {plan && editableAgents.length > 0 && (
        <div style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--border-default)",
          flexShrink: 0,
        }}>
          <button
            className="zyra-btn zyra-btn--primary"
            onClick={handleApply}
            style={{ width: "100%" }}
          >
            Apply to Canvas ({editableAgents.length} nodes)
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────── */

function StageBadge({ stage }: { stage: string }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 6px",
      borderRadius: 3,
      background: STAGE_COLORS[stage] ?? "#666666",
      color: "#fff",
      fontSize: 9,
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      verticalAlign: "middle",
    }}>
      {stage}
    </span>
  );
}

function AgentCard({
  agent,
  index,
  total,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  agent: PlanAgent;
  index: number;
  total: number;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        padding: "6px 10px",
        marginBottom: 4,
        background: "var(--bg-tertiary)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        fontSize: 11,
        color: "var(--text-secondary)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <StageBadge stage={agent.stage} />
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          {agent.command}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: "auto" }}>
          {agent.id}
        </span>
        {hovered && (
          <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <button
              onClick={onMoveUp}
              disabled={index === 0}
              title="Move up"
              style={{
                background: "none",
                border: "none",
                color: index === 0 ? "var(--border-default)" : "var(--text-muted)",
                fontSize: 12,
                cursor: index === 0 ? "default" : "pointer",
                padding: "0 2px",
                lineHeight: 1,
              }}
            >
              {"\u25B2"}
            </button>
            <button
              onClick={onMoveDown}
              disabled={index === total - 1}
              title="Move down"
              style={{
                background: "none",
                border: "none",
                color: index === total - 1 ? "var(--border-default)" : "var(--text-muted)",
                fontSize: 12,
                cursor: index === total - 1 ? "default" : "pointer",
                padding: "0 2px",
                lineHeight: 1,
              }}
            >
              {"\u25BC"}
            </button>
            <button
              onClick={onRemove}
              title="Remove this step"
              style={{
                background: "none",
                border: "none",
                color: "var(--accent-red)",
                fontSize: 13,
                cursor: "pointer",
                padding: "0 2px",
                lineHeight: 1,
              }}
            >
              &times;
            </button>
          </div>
        )}
      </div>
      {agent.depends_on.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
          depends on: {agent.depends_on.join(", ")}
        </div>
      )}
    </div>
  );
}

function ChatBubble({ entry }: { entry: ChatEntry }) {
  if (entry.role === "status") {
    return (
      <div style={{
        fontSize: 10,
        color: "var(--text-muted)",
        padding: "2px 0",
        fontStyle: "italic",
      }}>
        {entry.text}
      </div>
    );
  }
  const isUser = entry.role === "user";
  return (
    <div style={{
      display: "flex",
      justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 6,
    }}>
      <div style={{
        maxWidth: "85%",
        padding: "6px 10px",
        borderRadius: "var(--radius-md)",
        fontSize: 12,
        lineHeight: 1.5,
        background: isUser ? "var(--accent-blue)" : "var(--bg-secondary)",
        color: isUser ? "#fff" : "var(--text-primary)",
        border: isUser ? "none" : "1px solid var(--border-default)",
      }}>
        {entry.text}
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  onAccept,
  onDismiss,
}: {
  suggestion: PlanSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const pct = Math.round(suggestion.confidence * 100);
  return (
    <div style={{
      padding: "8px 10px",
      marginBottom: 6,
      background: "var(--bg-tertiary)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-md)",
      fontSize: 11,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <StageBadge stage={suggestion.stage} />
        <span style={{
          fontSize: 9,
          color: "var(--text-muted)",
          padding: "1px 5px",
          border: "1px solid var(--border-default)",
          borderRadius: 3,
        }}>
          {suggestion.origin}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)" }}>
          {pct}%
        </span>
      </div>
      {/* Confidence bar */}
      <div style={{
        width: "100%",
        height: 3,
        background: "var(--border-default)",
        borderRadius: 2,
        marginBottom: 6,
        overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: pct >= 70 ? "var(--accent-green, #3fb950)" : pct >= 40 ? "#d29922" : "#f85149",
          borderRadius: 2,
        }} />
      </div>
      <div style={{ color: "var(--text-secondary)", lineHeight: 1.4, marginBottom: 6 }}>
        {suggestion.description}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={onAccept}
          title="Add this step to the plan"
          style={{
            flex: 1,
            padding: "4px 0",
            background: "rgba(63,185,80,0.15)",
            border: "1px solid rgba(63,185,80,0.4)",
            borderRadius: "var(--radius-sm)",
            color: "#3fb950",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
          }}
        >
          Accept
        </button>
        <button
          onClick={onDismiss}
          style={{
            flex: 1,
            padding: "4px 0",
            background: "none",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ClarificationCard({
  item,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  item: ClarificationItem;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const isEnum = item.arg_type === "enum" && item.options && item.options.length > 0;
  const hasDefault = item.default != null && item.default !== "";
  const isConfirm = item.kind === "confirm";
  const displayValue = isConfirm ? item.current_value ?? "" : "";

  const handleSubmit = () => {
    const val = value.trim() || (isConfirm ? displayValue : "");
    if (val) onSubmit(val);
  };

  return (
    <div style={{
      marginTop: 8,
      padding: "12px",
      background: "var(--bg-tertiary)",
      border: "1px solid var(--accent-blue, #58a6ff)",
      borderRadius: "var(--radius-md)",
      fontSize: 12,
    }}>
      {/* Progress indicator */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 8,
      }}>
        <span style={{
          fontSize: 10,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}>
          Question {item.index + 1} of {item.total}
        </span>
        {item.importance && (
          <span style={{
            fontSize: 9,
            padding: "1px 6px",
            borderRadius: 3,
            background: item.importance === "required"
              ? "rgba(248,81,73,0.15)"
              : "rgba(210,153,34,0.15)",
            color: item.importance === "required" ? "#f85149" : "#d29922",
            fontWeight: 600,
            textTransform: "uppercase",
          }}>
            {item.importance}
          </span>
        )}
      </div>

      {/* Agent context */}
      {item.agent_id && (
        <div style={{
          fontSize: 10,
          color: "var(--text-muted)",
          marginBottom: 4,
        }}>
          for <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{item.agent_id}</span>
        </div>
      )}

      {/* Question label */}
      <div style={{
        fontWeight: 600,
        color: "var(--text-bright)",
        marginBottom: 4,
        fontSize: 13,
      }}>
        {item.label || item.arg_key}
      </div>

      {/* Description / help text */}
      {item.description && (
        <div style={{
          color: "var(--text-secondary)",
          fontSize: 11,
          lineHeight: 1.5,
          marginBottom: 8,
        }}>
          {item.description}
        </div>
      )}

      {/* Current value for confirm-type */}
      {isConfirm && displayValue && (
        <div style={{
          fontSize: 11,
          color: "var(--text-muted)",
          marginBottom: 6,
          fontStyle: "italic",
        }}>
          Current value: <span style={{ color: "var(--text-secondary)" }}>{displayValue}</span>
          {" "}— press Enter to keep, or type a new value
        </div>
      )}

      {/* Default hint */}
      {!isConfirm && hasDefault && (
        <div style={{
          fontSize: 11,
          color: "var(--text-muted)",
          marginBottom: 6,
        }}>
          Default: <span style={{ color: "var(--text-secondary)" }}>{String(item.default)}</span>
        </div>
      )}

      {/* Input: enum select or text field */}
      {isEnum ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
          style={{
            width: "100%",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            padding: "6px 10px",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 8,
          }}
        >
          <option value="">Select...</option>
          {item.options!.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : (
        <input
          type={item.arg_type === "number" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={item.placeholder || (isConfirm ? displayValue : `Enter ${item.label || item.arg_key}...`)}
          autoFocus
          style={{
            width: "100%",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            padding: "6px 10px",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 8,
          }}
        />
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="zyra-btn zyra-btn--primary"
          onClick={handleSubmit}
          disabled={!isConfirm && !value.trim()}
          style={{
            flex: 1,
            fontSize: 12,
            opacity: (!isConfirm && !value.trim()) ? 0.5 : 1,
          }}
        >
          {isConfirm && !value.trim() ? "Keep Current" : "Next"}
        </button>
        <button
          onClick={onCancel}
          style={{
            background: "none",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: "pointer",
            padding: "4px 12px",
            fontFamily: "var(--font-sans)",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
