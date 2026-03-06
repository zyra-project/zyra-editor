import { useState } from "react";
import type { RunStateMap } from "./useExecution";
import { STATUS_COLORS } from "@zyra/core";

interface LogPanelProps {
  runState: RunStateMap;
  selectedNodeId: string | null;
  onClearNode?: (nodeId: string) => void;
  onSelectNode?: (nodeId: string) => void;
}

export function LogPanel({ runState, selectedNodeId, onClearNode, onSelectNode }: LogPanelProps) {
  const [collapsed, setCollapsed] = useState(true);

  if (runState.size === 0) return null;

  // Compute summary
  const counts = { succeeded: 0, failed: 0, running: 0, queued: 0, total: 0 };
  for (const [, state] of runState) {
    counts.total++;
    if (state.status === "succeeded") counts.succeeded++;
    else if (state.status === "failed") counts.failed++;
    else if (state.status === "running") counts.running++;
    else if (state.status === "queued") counts.queued++;
  }

  return (
    <div className="zyra-logs" style={{
      background: "var(--bg-primary)",
      borderTop: "1px solid var(--border-default)",
      fontFamily: "var(--font-sans)",
      fontSize: 12,
    }}>
      {/* Summary bar — always visible */}
      <div style={{
        display: "flex",
        alignItems: "center",
        height: 32,
        minHeight: 32,
        padding: "0 12px",
        gap: 12,
        background: "var(--bg-secondary)",
        borderBottom: collapsed ? "none" : "1px solid var(--border-default)",
      }}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: "0 4px",
            fontSize: 10,
            fontFamily: "var(--font-sans)",
          }}
        >
          {collapsed ? "\u25b6" : "\u25bc"} Pipeline
        </button>

        {/* Status pills */}
        <div style={{ display: "flex", gap: 10, flex: 1 }}>
          {counts.running > 0 && (
            <StatusPill color={STATUS_COLORS.running} label={`${counts.running} running`} pulse />
          )}
          {counts.queued > 0 && (
            <StatusPill color={STATUS_COLORS.queued} label={`${counts.queued} queued`} />
          )}
          {counts.succeeded > 0 && (
            <StatusPill color={STATUS_COLORS.succeeded} label={`${counts.succeeded} passed`} />
          )}
          {counts.failed > 0 && (
            <StatusPill color={STATUS_COLORS.failed} label={`${counts.failed} failed`} />
          )}
        </div>
      </div>

      {/* Expanded: node list */}
      {!collapsed && (
        <div style={{
          maxHeight: 160,
          overflowY: "auto",
          padding: "4px 8px",
        }}>
          {Array.from(runState.entries()).map(([nodeId, state]) => {
            const color = (STATUS_COLORS as Record<string, string>)[state.status];
            const isSelected = nodeId === selectedNodeId;
            return (
              <div
                key={nodeId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "4px 8px",
                  borderRadius: "var(--radius-sm)",
                  background: isSelected ? "var(--bg-tertiary)" : "transparent",
                  cursor: "pointer",
                  gap: 8,
                  marginBottom: 2,
                }}
                onClick={() => onSelectNode?.(nodeId)}
              >
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color ?? "var(--text-muted)",
                  flexShrink: 0,
                  animation: state.status === "running" ? "zyra-pulse 1.2s infinite" : undefined,
                }} />
                <span style={{
                  color: "var(--text-primary)",
                  fontSize: 11,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {nodeId}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                  {state.status}
                </span>
                {onClearNode && state.status !== "running" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onClearNode(nodeId);
                    }}
                    title="Clear"
                    aria-label={`Clear ${nodeId}`}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 10,
                      padding: "0 2px",
                      lineHeight: 1,
                    }}
                  >
                    &times;
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusPill({
  color,
  label,
  pulse,
}: {
  color: string;
  label: string;
  pulse?: boolean;
}) {
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      fontSize: 11,
      color: "var(--text-secondary)",
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        animation: pulse ? "zyra-pulse 1.2s infinite" : undefined,
      }} />
      {label}
    </span>
  );
}
