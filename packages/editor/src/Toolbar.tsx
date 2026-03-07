import { useState, useEffect, useCallback } from "react";
import type { RunStateMap } from "./useExecution";
import { STATUS_COLORS } from "@zyra/core";
import type { Theme } from "./useTheme";
import type { BackendStatus } from "./useBackendStatus";

interface ToolbarProps {
  onOpen: () => void;
  onDryRun: () => void;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
  running: boolean;
  nodeCount: number;
  runState: RunStateMap;
  yamlOpen: boolean;
  onToggleYaml: () => void;
  plannerOpen: boolean;
  onTogglePlanner: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  backendStatus: BackendStatus & { refresh: () => void };
}

export function Toolbar({
  onOpen,
  onDryRun,
  onRun,
  onCancel,
  onReset,
  running,
  nodeCount,
  runState,
  yamlOpen,
  onToggleYaml,
  plannerOpen,
  onTogglePlanner,
  theme,
  onToggleTheme,
  backendStatus,
}: ToolbarProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
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
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontWeight: 700,
        fontSize: 15,
        marginRight: 16,
        letterSpacing: "-0.02em",
      }}>
        <img
          src="/zyra-logo.png"
          alt="Zyra"
          className="zyra-logo"
          style={{ width: 24, height: 24 }}
        />
        Zyra
      </span>

      {/* Pipeline actions */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          className="zyra-btn zyra-btn--neutral"
          onClick={onOpen}
          title="Open a pipeline file (Ctrl+O)"
        >
          Open
        </button>

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

      {/* AI Planner toggle */}
      <button
        onClick={onTogglePlanner}
        title="AI Planner — generate a pipeline from a natural language description (Ctrl+P)"
        aria-expanded={plannerOpen}
        style={{
          background: plannerOpen ? "var(--accent-blue)" : "none",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          color: plannerOpen ? "#fff" : "var(--text-secondary)",
          cursor: "pointer",
          padding: "4px 10px",
          fontSize: 12,
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontFamily: "var(--font-sans)",
          fontWeight: 500,
        }}
      >
        <span style={{ fontSize: 14 }}>{"\u2728"}</span>
        Plan
      </button>

      {/* AI Status indicator */}
      <div style={{ position: "relative" }}>
        <button
          onClick={() => setStatusPopoverOpen((v) => !v)}
          title={`AI Status: ${backendStatus.status}`}
          style={{
            background: "none",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            padding: "4px 8px",
            fontSize: 11,
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
          }}
        >
          <span style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background:
              backendStatus.status === "ready" ? "var(--accent-green)"
              : backendStatus.status === "degraded" ? "var(--accent-yellow)"
              : backendStatus.status === "checking" ? "var(--text-muted)"
              : "var(--accent-red)",
          }} />
          {backendStatus.status === "ready" ? "AI Ready"
            : backendStatus.status === "degraded" ? "Degraded"
            : backendStatus.status === "checking" ? "Checking..."
            : "Offline"}
        </button>
        {statusPopoverOpen && (
          <StatusPopover
            status={backendStatus}
            onClose={() => setStatusPopoverOpen(false)}
          />
        )}
      </div>

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

      {/* Export pipeline config */}
      <button
        onClick={onToggleYaml}
        title="View & export pipeline config (Ctrl+S)"
        aria-expanded={yamlOpen}
        style={{
          background: yamlOpen ? "var(--accent-blue)" : "none",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          color: yamlOpen ? "#fff" : "var(--text-secondary)",
          cursor: "pointer",
          padding: "4px 10px",
          fontSize: 12,
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontFamily: "var(--font-sans)",
          fontWeight: 500,
        }}
      >
        <span style={{ fontSize: 14 }}>{"\u21A7"}</span>
        Export
      </button>

      {/* Help */}
      <button
        onClick={() => setHelpOpen(true)}
        title="Help — learn how to use Zyra Editor"
        aria-label="Help"
        style={{
          background: "none",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          color: "var(--text-secondary)",
          cursor: "pointer",
          padding: "4px 8px",
          fontSize: 15,
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          fontWeight: 700,
        }}
      >
        ?
      </button>
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

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
        aria-pressed={theme === "dark"}
      >
        {theme === "dark" ? "\u2600\ufe0f" : "\u{1f319}"}
      </button>
    </div>
  );
}

/* ── Help Modal ───────────────────────────────────────────── */

const HELP_SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "Getting Started",
    items: [
      "Zyra Editor lets you visually build data processing pipelines by connecting nodes on a canvas.",
      "Each node represents a CLI command (stage) that processes data \u2014 drag them from the palette on the left.",
      "Connect nodes by dragging from an output port (right side) to an input port (left side) to define data flow.",
    ],
  },
  {
    title: "Adding Nodes",
    items: [
      "The left sidebar (Node Palette) lists available stages grouped by category.",
      "Click a stage to add it to the canvas. You can collapse the palette with the toggle arrow.",
      "Control nodes (string, number, boolean) let you wire constant values into other nodes\u2019 arguments.",
    ],
  },
  {
    title: "Configuring Nodes",
    items: [
      "Click a node to select it \u2014 the detail panel appears on the right with tabs for Args, Inputs, and Outputs.",
      "Fill in required arguments (marked with *) in the Args tab. Arguments can also be linked from control nodes.",
      "Double-click a node\u2019s header to rename it for clarity.",
    ],
  },
  {
    title: "Connections & Ports",
    items: [
      "Solid ports are explicit data inputs/outputs. Dashed ports are argument ports that accept wired values.",
      "Click \u201c+ N more ports\u201d on a node to reveal hidden optional argument ports.",
      "Connections are validated \u2014 only type-compatible ports can be linked.",
    ],
  },
  {
    title: "Groups",
    items: [
      "Use the \u201cAdd Group\u201d button in the palette to create a visual group box.",
      "Drag nodes into a group to organize them. Lock a group to prevent accidental edits.",
      "Groups are saved in the pipeline file and restored when you reopen it.",
    ],
  },
  {
    title: "Running Pipelines",
    items: [
      "\u201cDry Run\u201d validates the pipeline and shows the resolved CLI commands without executing.",
      "\u201cRun\u201d executes the full pipeline \u2014 progress and logs appear in the bottom log panel.",
      "\u201cCancel\u201d stops running jobs. \u201cClear\u201d resets execution status indicators.",
    ],
  },
  {
    title: "Import & Export",
    items: [
      "\u201cOpen\u201d loads a pipeline YAML file. \u201cExport\u201d (or Ctrl+S) opens the YAML panel to view, edit, copy, or download the pipeline.",
      "You can also paste YAML directly into the export panel to import a pipeline.",
    ],
  },
  {
    title: "Keyboard Shortcuts",
    items: [
      "Ctrl+P \u2014 Toggle AI Planner",
      "Ctrl+S \u2014 Toggle YAML export panel",
      "Ctrl+O \u2014 Open pipeline file",
      "Escape \u2014 Close panels / deselect nodes",
      "Delete / Backspace \u2014 Remove selected nodes or edges",
    ],
  },
];

function StatusPopover({
  status,
  onClose,
}: {
  status: BackendStatus & { refresh: () => void };
  onClose: () => void;
}) {
  const checkIcon = (ok: boolean) => (
    <span style={{
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: ok ? "var(--accent-green)" : "var(--accent-red)",
      marginRight: 6,
      flexShrink: 0,
    }} />
  );

  const ago = status.lastChecked
    ? `${Math.round((Date.now() - status.lastChecked) / 1000)}s ago`
    : "never";

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-status-popover]")) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      data-status-popover
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        width: 260,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        boxShadow: "0 4px 16px var(--node-shadow)",
        padding: "12px 14px",
        zIndex: 200,
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        animation: "zyra-fade-in 0.15s ease-out",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text-bright)", marginBottom: 10 }}>
        Backend Status
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", color: "var(--text-secondary)" }}>
          {checkIcon(status.server)}
          <span style={{ flex: 1 }}>Server</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {status.server ? "Connected" : "Unreachable"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", color: "var(--text-secondary)" }}>
          {checkIcon(status.zyra_cli)}
          <span style={{ flex: 1 }}>Zyra CLI</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {status.zyra_cli
              ? status.zyra_version || "Installed"
              : "Not found"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", color: "var(--text-secondary)" }}>
          {checkIcon(status.llm_configured)}
          <span style={{ flex: 1 }}>LLM Backend</span>
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {status.llm_configured
              ? [status.llm_provider, status.llm_model].filter(Boolean).join(" / ") || "Configured"
              : "Not configured"}
          </span>
        </div>
      </div>
      <div style={{
        marginTop: 10,
        paddingTop: 8,
        borderTop: "1px solid var(--border-default)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          Last checked: {ago}
        </span>
        <button
          onClick={status.refresh}
          style={{
            background: "none",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-secondary)",
            fontSize: 10,
            cursor: "pointer",
            padding: "2px 8px",
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
          }}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  // Close on Escape — stop propagation so App-level Escape handler doesn't also fire
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Zyra Editor Help"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 8px 32px var(--node-shadow)",
          width: "min(640px, 90vw)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-bright)" }}>
            Zyra Editor Help
          </h2>
          <button
            onClick={onClose}
            aria-label="Close help"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 20,
              cursor: "pointer",
              padding: "2px 6px",
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px 24px",
        }}>
          <p style={{
            color: "var(--text-secondary)",
            fontSize: 13,
            lineHeight: 1.5,
            margin: "0 0 20px",
          }}>
            Zyra Editor is a visual node editor for orchestrating data processing pipelines.
            Connect nodes representing CLI commands into a graph, configure their arguments,
            then run or export your pipeline.
          </p>

          {HELP_SECTIONS.map((section) => (
            <div key={section.title} style={{ marginBottom: 18 }}>
              <h3 style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--text-primary)",
                margin: "0 0 8px",
              }}>
                {section.title}
              </h3>
              <ul style={{
                margin: 0,
                paddingLeft: 18,
                listStyle: "disc",
              }}>
                {section.items.map((item, i) => (
                  <li key={i} style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    lineHeight: 1.6,
                    marginBottom: 2,
                  }}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 20px",
          borderTop: "1px solid var(--border-default)",
          display: "flex",
          justifyContent: "flex-end",
          flexShrink: 0,
        }}>
          <button
            className="zyra-btn zyra-btn--primary"
            onClick={onClose}
            autoFocus
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
