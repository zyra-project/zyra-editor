import { useState, useEffect, useCallback } from "react";
import type { RunSummary, RunHistoryRecord, GraphSnapshot, RunEvent } from "@zyra/core";
import { STATUS_COLORS } from "@zyra/core";
import { listRunHistory, getRunHistory, deleteRunHistory } from "./api";
import { GanttChart, stepsToGanttBars } from "./GanttChart";

interface Props {
  onClose: () => void;
  onRestoreGraph?: (snapshot: GraphSnapshot) => void;
  refreshKey?: number;
}

export function RunHistoryPanel({ onClose, onRestoreGraph, refreshKey }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunHistoryRecord | null>(null);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 25;

  const fetchRuns = useCallback(async (off = 0) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRunHistory(PAGE_SIZE, off);
      setRuns(off === 0 ? result.runs : (prev) => [...prev, ...result.runs]);
      setTotal(result.total);
      setOffset(off);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRuns(0); }, [fetchRuns, refreshKey]);

  const handleSelect = async (runId: string) => {
    setLoading(true);
    try {
      const detail = await getRunHistory(runId);
      setSelectedRun(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    try {
      await deleteRunHistory(runId);
      setRuns((prev) => prev.filter((r) => r.id !== runId));
      setTotal((t) => t - 1);
      if (selectedRun?.id === runId) setSelectedRun(null);
    } catch {
      // best-effort
    }
  };

  const handleRestore = () => {
    if (!selectedRun?.graphSnapshot || !onRestoreGraph) return;
    if (!window.confirm("This will replace the current graph with the one from this run. Continue?")) return;
    onRestoreGraph(selectedRun.graphSnapshot);
  };

  return (
    <div style={{
      position: "fixed",
      top: 48, /* below toolbar */
      right: 0,
      bottom: 0,
      width: 380,
      zIndex: 40,
      background: "var(--bg-tertiary)",
      borderLeft: "1px solid var(--border-default)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      color: "var(--text-bright)",
      boxShadow: "-4px 0 16px var(--node-shadow)",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "10px 16px",
        gap: 8,
        borderBottom: "1px solid var(--border-default)",
        background: "var(--bg-secondary)",
      }}>
        {selectedRun && (
          <button
            onClick={() => setSelectedRun(null)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary)",
              fontSize: 16,
              cursor: "pointer",
              padding: "0 4px",
            }}
            title="Back to list"
          >
            &larr;
          </button>
        )}
        <div style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>
          {selectedRun ? "Run Detail" : "Run History"}
        </div>
        {!selectedRun && (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {total} run{total !== 1 ? "s" : ""}
          </span>
        )}
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            fontSize: 18,
            cursor: "pointer",
            padding: "0 4px",
            lineHeight: 1,
          }}
          aria-label="Close panel"
        >
          &times;
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: selectedRun ? 0 : undefined }}>
        {error && (
          <div style={{
            padding: "8px 16px",
            fontSize: 12,
            color: "var(--accent-red)",
            background: "var(--bg-error)",
          }}>
            {error}
          </div>
        )}

        {!selectedRun ? (
          /* ── Run List ── */
          <>
            {runs.length === 0 && !loading && (
              <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>
                No runs recorded yet. Execute a pipeline or node to see history here.
              </div>
            )}
            {runs.map((run) => (
              <RunListItem
                key={run.id}
                run={run}
                onSelect={() => handleSelect(run.id)}
                onDelete={(e) => handleDelete(e, run.id)}
              />
            ))}
            {runs.length < total && (
              <button
                onClick={() => fetchRuns(offset + PAGE_SIZE)}
                disabled={loading}
                style={{
                  display: "block",
                  width: "calc(100% - 32px)",
                  margin: "8px 16px",
                  padding: "6px 0",
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {loading ? "Loading..." : "Load more"}
              </button>
            )}
          </>
        ) : (
          /* ── Run Detail ── */
          <RunDetail
            run={selectedRun}
            onRestore={selectedRun.graphSnapshot && onRestoreGraph ? handleRestore : undefined}
          />
        )}

        {loading && runs.length === 0 && !selectedRun && (
          <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>
            Loading...
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Run List Item ────────────────────────────────────────────────── */

function RunListItem({
  run,
  onSelect,
  onDelete,
}: {
  run: RunSummary;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const statusColor = (STATUS_COLORS as Record<string, string>)[run.status] ?? "#555";
  const ago = formatRelativeTime(run.startedAt);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--border-default)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-secondary)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      {/* Status dot */}
      <span style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: statusColor,
        flexShrink: 0,
      }} />

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            fontSize: 11,
            padding: "1px 5px",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-primary)",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
          }}>
            {run.mode === "pipeline" ? "pipeline" : "single"}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500 }}>
            {run.nodeCount} step{run.nodeCount !== 1 ? "s" : ""}
          </span>
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>
            {run.status}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {ago}
          {run.durationMs != null && (
            <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)" }}>
              {formatDuration(run.durationMs)}
            </span>
          )}
        </div>
      </div>

      {/* Delete button */}
      <button
        onClick={onDelete}
        title="Delete this run"
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: 14,
          cursor: "pointer",
          padding: "2px 4px",
          opacity: 0.6,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "var(--accent-red)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.color = "var(--text-muted)"; }}
      >
        &times;
      </button>
    </div>
  );
}

/* ── Run Detail View ──────────────────────────────────────────────── */

function RunDetail({
  run,
  onRestore,
}: {
  run: RunHistoryRecord;
  onRestore?: () => void;
}) {
  const [showTimeline, setShowTimeline] = useState(false);
  const statusColor = (STATUS_COLORS as Record<string, string>)[run.status] ?? "#555";
  const ganttBars = stepsToGanttBars(run.steps);
  const hasTimingData = ganttBars.length > 0;

  return (
    <div style={{ padding: 16 }}>
      {/* Summary header */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: statusColor,
            flexShrink: 0,
          }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: statusColor }}>
            {run.status}
          </span>
          <span style={{
            fontSize: 11,
            padding: "1px 5px",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-primary)",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
          }}>
            {run.mode}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {new Date(run.startedAt).toLocaleString()}
          {run.durationMs != null && ` \u2022 ${formatDuration(run.durationMs)}`}
          {` \u2022 ${run.nodeCount} step${run.nodeCount !== 1 ? "s" : ""}`}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {onRestore && (
          <button
            onClick={onRestore}
            style={{
              flex: 1,
              padding: "6px 0",
              background: "var(--bg-secondary)",
              border: "1px solid var(--accent-blue)",
              borderRadius: "var(--radius-sm)",
              color: "var(--accent-blue)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Restore graph
          </button>
        )}
        {hasTimingData && (
          <button
            onClick={() => setShowTimeline((v) => !v)}
            style={{
              flex: 1,
              padding: "6px 0",
              background: showTimeline ? "var(--accent-blue)" : "var(--bg-secondary)",
              border: `1px solid ${showTimeline ? "var(--accent-blue)" : "var(--border-default)"}`,
              borderRadius: "var(--radius-sm)",
              color: showTimeline ? "#fff" : "var(--text-secondary)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Timeline
          </button>
        )}
      </div>

      {/* Gantt chart */}
      {showTimeline && (
        <div style={{
          marginBottom: 12,
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          background: "var(--bg-primary)",
        }}>
          <GanttChart bars={ganttBars} width={348} />
        </div>
      )}

      {/* Steps */}
      {run.steps.map((step, i) => (
        <StepDetail key={i} step={step} />
      ))}
    </div>
  );
}

/* ── Step Detail ──────────────────────────────────────────────────── */

function StepDetail({ step }: { step: RunHistoryRecord["steps"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = (STATUS_COLORS as Record<string, string>)[step.status] ?? "#555";

  return (
    <div style={{
      marginBottom: 8,
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-sm)",
      overflow: "hidden",
    }}>
      {/* Step header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          background: "var(--bg-secondary)",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
          {expanded ? "\u25bc" : "\u25b6"}
        </span>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: statusColor,
          flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {step.nodeId}
        </span>
        {step.durationMs != null && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {formatDuration(step.durationMs)}
          </span>
        )}
        <span style={{ fontSize: 10, color: statusColor, fontWeight: 600 }}>
          {step.status}
        </span>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: "8px 10px", fontSize: 12 }}>
          {/* Command preview */}
          {step.request && (
            <div style={{
              marginBottom: 6,
              padding: 6,
              background: "var(--bg-primary)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--accent-blue)",
            }}>
              $ zyra {step.request.stage} {step.request.command}
            </div>
          )}

          {/* stdout */}
          {step.stdout && (
            <details style={{ marginBottom: 6 }}>
              <summary style={{ fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
                stdout ({step.stdout.length} chars)
              </summary>
              <pre style={{
                margin: "4px 0 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-primary)",
                background: "var(--bg-primary)",
                padding: 6,
                borderRadius: "var(--radius-sm)",
                maxHeight: 200,
                overflow: "auto",
              }}>
                {step.stdout}
              </pre>
            </details>
          )}

          {/* stderr */}
          {step.stderr && (
            <details style={{ marginBottom: 6 }}>
              <summary style={{ fontSize: 11, color: "var(--text-error, var(--accent-red))", cursor: "pointer" }}>
                stderr ({step.stderr.length} chars)
              </summary>
              <pre style={{
                margin: "4px 0 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: "var(--text-error, var(--accent-red))",
                background: "var(--bg-error, rgba(248,81,73,0.1))",
                padding: 6,
                borderRadius: "var(--radius-sm)",
                maxHeight: 200,
                overflow: "auto",
              }}>
                {step.stderr}
              </pre>
            </details>
          )}

          {/* Exit code */}
          {step.exitCode != null && (
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: step.exitCode === 0 ? "var(--accent-green)" : "var(--accent-red)",
              marginBottom: 6,
            }}>
              Exit code: {step.exitCode}
            </div>
          )}

          {/* Events */}
          {step.events.length > 0 && (
            <EventList events={step.events} startedAt={step.startedAt} />
          )}
        </div>
      )}
    </div>
  );
}

/* ── Event List ───────────────────────────────────────────────────── */

const EVENT_ICONS: Record<string, string> = {
  submitted: "\u25b6",
  "job-accepted": "\u2611",
  "ws-connected": "\u21c4",
  "ws-disconnected": "\u2716",
  "poll-fallback": "\u21bb",
  completed: "\u2714",
  canceled: "\u2014",
  error: "\u26a0",
};

function EventList({ events, startedAt }: { events: RunEvent[]; startedAt?: string }) {
  const base = startedAt ? new Date(startedAt).getTime() : events[0]?.timestamp ?? 0;

  return (
    <details>
      <summary style={{ fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
        Events ({events.length})
      </summary>
      <div style={{ marginTop: 4 }}>
        {events.map((ev, i) => {
          const offset = ((ev.timestamp - base) / 1000).toFixed(1);
          return (
            <div key={i} style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              color: ev.type === "error" ? "var(--accent-red)" : "var(--text-secondary)",
              padding: "1px 0",
              display: "flex",
              gap: 6,
            }}>
              <span style={{ color: "var(--text-muted)", minWidth: 40, textAlign: "right", flexShrink: 0 }}>
                +{offset}s
              </span>
              <span>{EVENT_ICONS[ev.type] ?? "\u2022"}</span>
              <span>{ev.message ?? ev.type}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m ${rem}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
