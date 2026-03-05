import type { RunStateMap } from "./useExecution";
import type { NodeRunStatus } from "@zyra/core";

interface ToolbarProps {
  onDryRun: () => void;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
  running: boolean;
  nodeCount: number;
  runState: RunStateMap;
}

const statusColors: Record<NodeRunStatus, string> = {
  idle: "#555",
  "dry-run": "#58a6ff",
  queued: "#888",
  running: "#58a6ff",
  succeeded: "#3fb950",
  failed: "#f85149",
  canceled: "#d29922",
};

export function Toolbar({
  onDryRun,
  onRun,
  onCancel,
  onReset,
  running,
  nodeCount,
  runState,
}: ToolbarProps) {
  const counts = { succeeded: 0, failed: 0, running: 0, total: 0 };
  for (const [, state] of runState) {
    counts.total++;
    if (state.status === "succeeded") counts.succeeded++;
    else if (state.status === "failed") counts.failed++;
    else if (state.status === "running") counts.running++;
  }

  const hasRun = counts.total > 0;

  return (
    <div
      style={{
        height: 40,
        background: "#161b22",
        borderBottom: "1px solid #30363d",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 8,
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        color: "#c9d1d9",
      }}
    >
      <span style={{ fontWeight: 600, marginRight: 8 }}>Zyra Editor</span>

      <button
        onClick={onDryRun}
        disabled={running || nodeCount === 0}
        style={btnStyle("#1f6feb")}
        title="Validate pipeline without executing — shows resolved CLI commands"
      >
        Dry Run
      </button>

      <button
        onClick={onRun}
        disabled={running || nodeCount === 0}
        style={btnStyle("#238636")}
      >
        Run
      </button>

      {running && (
        <button onClick={onCancel} style={btnStyle("#da3633")}>
          Cancel
        </button>
      )}

      {hasRun && !running && (
        <button onClick={onReset} style={btnStyle("#30363d")}>
          Clear
        </button>
      )}

      {/* Status summary */}
      {hasRun && (
        <div style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: 12 }}>
          {counts.running > 0 && (
            <span style={{ color: statusColors.running }}>
              {counts.running} running
            </span>
          )}
          {counts.succeeded > 0 && (
            <span style={{ color: statusColors.succeeded }}>
              {counts.succeeded}/{counts.total} passed
            </span>
          )}
          {counts.failed > 0 && (
            <span style={{ color: statusColors.failed }}>
              {counts.failed} failed
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    opacity: 1,
  };
}
