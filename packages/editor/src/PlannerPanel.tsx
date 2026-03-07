import { useState, useCallback } from "react";
import type { Node, Edge } from "@xyflow/react";
import type { Manifest } from "@zyra/core";
import {
  planToGraph,
  type PlanAgent,
  type PlanSuggestion,
  type PlanResponse,
} from "./planToGraph";

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

interface PlannerPanelProps {
  manifest: Manifest;
  onApply: (nodes: Node[], edges: Edge[]) => void;
  onClose: () => void;
}

export function PlannerPanel({ manifest, onApply, onClose }: PlannerPanelProps) {
  const [intent, setIntent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);

  // Track accepted / dismissed suggestion indices
  const [acceptedIdxs, setAcceptedIdxs] = useState<Set<number>>(new Set());
  const [dismissedIdxs, setDismissedIdxs] = useState<Set<number>>(new Set());

  const handleGenerate = useCallback(async () => {
    if (!intent.trim()) return;
    setLoading(true);
    setError(null);
    setPlan(null);
    setAcceptedIdxs(new Set());
    setDismissedIdxs(new Set());
    try {
      const resp = await fetch("/v1/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: intent.trim() }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail || `HTTP ${resp.status}`);
      }
      const data: PlanResponse = await resp.json();
      setPlan(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [intent]);

  const handleAccept = useCallback((idx: number) => {
    setAcceptedIdxs((prev) => new Set(prev).add(idx));
    setDismissedIdxs((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  }, []);

  const handleDismiss = useCallback((idx: number) => {
    setDismissedIdxs((prev) => new Set(prev).add(idx));
    setAcceptedIdxs((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  }, []);

  const handleUndoAccept = useCallback((idx: number) => {
    setAcceptedIdxs((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    if (!plan) return;
    // Merge accepted suggestions into agents
    const agents = [...plan.agents];
    for (const idx of acceptedIdxs) {
      const suggestion = plan.suggestions[idx];
      if (suggestion?.agent_template) {
        agents.push(suggestion.agent_template);
      }
    }
    const { nodes, edges } = planToGraph(agents, manifest);
    onApply(nodes, edges);
    onClose();
  }, [plan, acceptedIdxs, manifest, onApply, onClose]);

  const suggestions = plan?.suggestions ?? [];
  const pendingSuggestions = suggestions
    .map((s, i) => ({ suggestion: s, idx: i }))
    .filter(({ idx }) => !acceptedIdxs.has(idx) && !dismissedIdxs.has(idx));
  const acceptedSuggestions = suggestions
    .map((s, i) => ({ suggestion: s, idx: i }))
    .filter(({ idx }) => acceptedIdxs.has(idx));

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

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {/* Intent input */}
        <textarea
          placeholder="Describe your pipeline... e.g. &quot;Download SST data and convert to GeoTIFF&quot;"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleGenerate();
            }
          }}
          rows={3}
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
          onClick={handleGenerate}
          disabled={loading || !intent.trim()}
          style={{ width: "100%", marginTop: 8 }}
        >
          {loading ? "Generating..." : "Generate Plan"}
        </button>

        {/* Error */}
        {error && (
          <div style={{
            marginTop: 10,
            padding: "8px 10px",
            background: "rgba(248,81,73,0.15)",
            border: "1px solid rgba(248,81,73,0.4)",
            borderRadius: "var(--radius-md)",
            color: "#f85149",
            fontSize: 12,
          }}>
            {error}
          </div>
        )}

        {/* Plan preview */}
        {plan && (
          <div style={{ marginTop: 14 }}>
            {/* Summary */}
            {plan.plan_summary && (
              <div style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginBottom: 10,
                lineHeight: 1.5,
              }}>
                {plan.plan_summary}
              </div>
            )}

            {/* Agents list */}
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Steps ({plan.agents.length})
            </div>
            {plan.agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}

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

                {/* Accepted suggestions */}
                {acceptedSuggestions.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, color: "var(--accent-green)", marginTop: 8, marginBottom: 4, fontWeight: 600 }}>
                      Accepted
                    </div>
                    {acceptedSuggestions.map(({ suggestion, idx }) => (
                      <div key={idx} style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "6px 10px",
                        marginBottom: 4,
                        background: "rgba(63,185,80,0.1)",
                        border: "1px solid rgba(63,185,80,0.3)",
                        borderRadius: "var(--radius-md)",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                      }}>
                        <span>
                          <StageBadge stage={suggestion.stage} />
                          {" "}{suggestion.description}
                        </span>
                        <button
                          onClick={() => handleUndoAccept(idx)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "var(--text-muted)",
                            fontSize: 10,
                            cursor: "pointer",
                            textDecoration: "underline",
                            padding: "2px 4px",
                            fontFamily: "var(--font-sans)",
                          }}
                        >
                          undo
                        </button>
                      </div>
                    ))}
                  </>
                )}

                {pendingSuggestions.length === 0 && acceptedSuggestions.length === 0 && (
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
      </div>

      {/* Footer: Apply button */}
      {plan && (
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
            Apply to Canvas ({plan.agents.length + acceptedIdxs.size} nodes)
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

function AgentCard({ agent }: { agent: PlanAgent }) {
  return (
    <div style={{
      padding: "6px 10px",
      marginBottom: 4,
      background: "var(--bg-tertiary)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-md)",
      fontSize: 11,
      color: "var(--text-secondary)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <StageBadge stage={agent.stage} />
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          {agent.command}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: "auto" }}>
          {agent.id}
        </span>
      </div>
      {agent.depends_on.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
          depends on: {agent.depends_on.join(", ")}
        </div>
      )}
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
          disabled={!suggestion.agent_template}
          title={suggestion.agent_template ? "Add this step to the plan" : "No agent template available"}
          style={{
            flex: 1,
            padding: "4px 0",
            background: "rgba(63,185,80,0.15)",
            border: "1px solid rgba(63,185,80,0.4)",
            borderRadius: "var(--radius-sm)",
            color: "#3fb950",
            fontSize: 11,
            fontWeight: 600,
            cursor: suggestion.agent_template ? "pointer" : "default",
            opacity: suggestion.agent_template ? 1 : 0.4,
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
