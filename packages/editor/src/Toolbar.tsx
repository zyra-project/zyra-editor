import type { RunStateMap } from "./useExecution";
import { STATUS_COLORS } from "@zyra/core";
import type { Theme } from "./useTheme";

interface ToolbarProps {
  onDryRun: () => void;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
  running: boolean;
  nodeCount: number;
  runState: RunStateMap;
  yamlOpen: boolean;
  onToggleYaml: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export function Toolbar({
  onDryRun,
  onRun,
  onCancel,
  onReset,
  running,
  nodeCount,
  runState,
  yamlOpen,
  onToggleYaml,
  theme,
  onToggleTheme,
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
    <div className="zyra-toolbar" style={{
      height: 48,
      background: "var(--bg-secondary)",
      borderBottom: "1px solid var(--border-default)",
      display: "flex",
      alignItems: "center",
      padding: "0 16px",
      gap: 8,
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      color: "var(--text-primary)",
    }}>
      {/* Logo / Title */}
      <span style={{
        fontWeight: 700,
        fontSize: 15,
        marginRight: 16,
        letterSpacing: "-0.02em",
      }}>
        Zyra
      </span>

      {/* Pipeline actions */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          className="zyra-btn zyra-btn--info"
          onClick={onDryRun}
          disabled={running || nodeCount === 0}
          title="Validate pipeline without executing — shows resolved CLI commands"
        >
          Dry Run
        </button>

        <button
          className="zyra-btn zyra-btn--primary"
          onClick={onRun}
          disabled={running || nodeCount === 0}
          title="Execute the full pipeline"
        >
          Run
        </button>

        {running && (
          <button className="zyra-btn zyra-btn--danger" onClick={onCancel} title="Cancel all running jobs">
            Cancel
          </button>
        )}

        {hasRun && !running && (
          <button className="zyra-btn zyra-btn--neutral" onClick={onReset} title="Clear all execution results">
            Clear
          </button>
        )}
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 24, background: "var(--border-default)", margin: "0 8px" }} />

      {/* Tools */}
      <button
        className={`zyra-btn ${yamlOpen ? "zyra-btn--info" : "zyra-btn--neutral"}`}
        onClick={onToggleYaml}
        title="Toggle YAML editor (Ctrl+S)"
      >
        YAML
      </button>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Status summary */}
      {hasRun && (
        <div style={{ display: "flex", gap: 12, fontSize: 12, marginRight: 12 }}>
          {counts.running > 0 && (
            <span style={{ color: STATUS_COLORS.running }}>
              {counts.running} running
            </span>
          )}
          {counts.succeeded > 0 && (
            <span style={{ color: STATUS_COLORS.succeeded }}>
              {counts.succeeded}/{counts.total} passed
            </span>
          )}
          {counts.failed > 0 && (
            <span style={{ color: STATUS_COLORS.failed }}>
              {counts.failed} failed
            </span>
          )}
        </div>
      )}

      {/* Theme toggle */}
      <button
        onClick={onToggleTheme}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        style={{
          background: "none",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          color: "var(--text-secondary)",
          cursor: "pointer",
          padding: "4px 8px",
          fontSize: 16,
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
        }}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      >
        {theme === "dark" ? "\u2600\ufe0f" : "\u{1f319}"}
      </button>
    </div>
  );
}
