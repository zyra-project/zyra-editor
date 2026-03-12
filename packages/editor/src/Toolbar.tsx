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
  historyOpen: boolean;
  onToggleHistory: () => void;
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
  historyOpen,
  onToggleHistory,
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

      {/* Run History toggle */}
      <button
        onClick={onToggleHistory}
        title="Run History — browse past pipeline executions"
        aria-expanded={historyOpen}
        style={{
          background: historyOpen ? "var(--accent-blue)" : "none",
          border: "1px solid var(--border-default)",
          borderRadius: "var(--radius-md)",
          color: historyOpen ? "#fff" : "var(--text-secondary)",
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
        <span style={{ fontSize: 14 }}>{"\u{1f552}"}</span>
        History
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

      {/* AI Status indicator */}
      <div style={{ position: "relative" }} data-status-toggle>
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
    title: "AI Planner",
    items: [
      "Open the AI Planner with Ctrl+P or the robot icon in the toolbar. Describe what you want in plain English (e.g. \u201cDownload HRRR data from S3 and convert to NetCDF\u201d).",
      "The planner sends your intent to an LLM which proposes a pipeline of stages. Review the generated steps before applying.",
      "Click \u201cDefine Plan\u201d (or Ctrl+Enter) to generate a plan. The planner may ask clarifying questions first \u2014 answer them in the chat panel.",
      "Each step shows the stage name, a confidence score, and its arguments. You can edit arguments inline before applying.",
      "\u201cApply to Canvas\u201d adds the planned nodes and edges to your graph. You can undo a batch with the Undo button.",
      "Use \u201cNew Plan\u201d to start over, or revisit previous plans via the History dropdown.",
      "The SUGGESTIONS section at the bottom recommends additional stages (e.g. verification, export) \u2014 click Accept to add them.",
      "Requires a running backend with an LLM configured (OPENAI_API_KEY or OLLAMA_HOST). Check the status indicator if plans fail.",
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
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest("[data-status-popover]") ||
        target.closest("[data-status-toggle]")
      ) {
        return;
      }
      onClose();
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

const FEEDBACK_EMAIL = "Eric.J.Hackathorn@noaa.gov";

type HelpTab = "guide" | "feedback";

function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<HelpTab>("guide");
  const [fbName, setFbName] = useState("");
  const [fbEmail, setFbEmail] = useState("");
  const [fbType, setFbType] = useState<"question" | "bug" | "feature" | "other">("question");
  const [fbMessage, setFbMessage] = useState("");
  const [fbStatus, setFbStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

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

  const submitFeedback = useCallback(async () => {
    if (!fbMessage.trim()) return;

    const payload = {
      name: fbName.trim(),
      email: fbEmail.trim(),
      type: fbType,
      message: fbMessage.trim(),
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };

    setFbStatus("saving");
    try {
      const resp = await fetch("/v1/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        setFbStatus("saved");
      } else {
        setFbStatus("error");
      }
    } catch {
      // Save failed (server may be offline) — still open mailto
      setFbStatus("error");
    }

    // Open mailto link
    const subject = encodeURIComponent(`[Zyra Editor Feedback] ${fbType}: ${fbMessage.trim().slice(0, 60)}`);
    const body = encodeURIComponent(
      `Type: ${fbType}\nFrom: ${fbName.trim() || "Anonymous"}${fbEmail.trim() ? ` <${fbEmail.trim()}>` : ""}\n\n${fbMessage.trim()}`
    );
    window.open(`mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`, "_blank");
  }, [fbName, fbEmail, fbType, fbMessage]);

  const tabStyle = (t: HelpTab): React.CSSProperties => ({
    background: "none",
    border: "none",
    borderBottom: tab === t ? "2px solid var(--accent-blue)" : "2px solid transparent",
    color: tab === t ? "var(--text-bright)" : "var(--text-muted)",
    fontSize: 13,
    fontWeight: tab === t ? 700 : 500,
    cursor: "pointer",
    padding: "8px 16px",
    fontFamily: "var(--font-sans)",
  });

  const fieldLabel: React.CSSProperties = {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-secondary)",
    marginBottom: 4,
  };

  const fieldInput: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 10px",
    fontSize: 12,
    fontFamily: "var(--font-sans)",
    background: "var(--bg-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: 4,
    color: "var(--text-primary)",
    outline: "none",
  };

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
        {/* Header with tabs */}
        <div style={{
          padding: "16px 20px 0",
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-bright)" }}>
              Zyra Editor
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
          <div style={{ display: "flex", gap: 0 }}>
            <button style={tabStyle("guide")} onClick={() => setTab("guide")}>Help Guide</button>
            <button style={tabStyle("feedback")} onClick={() => setTab("feedback")}>Questions &amp; Feedback</button>
          </div>
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px 24px",
        }}>
          {tab === "guide" && (
            <>
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
            </>
          )}

          {tab === "feedback" && (
            <>
              <p style={{
                color: "var(--text-secondary)",
                fontSize: 13,
                lineHeight: 1.5,
                margin: "0 0 16px",
              }}>
                Have a question, found a bug, or want to request a feature?
                Fill out the form below. Your feedback will be saved and an email
                draft will open in your mail client.
              </p>

              {fbStatus === "saved" ? (
                <div style={{
                  textAlign: "center",
                  padding: "40px 20px",
                }}>
                  <div style={{ fontSize: 28, marginBottom: 12 }}>&#10003;</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-bright)", marginBottom: 8 }}>
                    Thank you for your feedback!
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 20 }}>
                    Your feedback has been recorded. If your email client opened,
                    please review and send the message.
                  </div>
                  <button
                    className="zyra-btn"
                    onClick={() => {
                      setFbName("");
                      setFbEmail("");
                      setFbType("question");
                      setFbMessage("");
                      setFbStatus("idle");
                    }}
                    style={{ fontSize: 12 }}
                  >
                    Submit another
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label style={fieldLabel}>Name (optional)</label>
                      <input
                        style={fieldInput}
                        value={fbName}
                        onChange={(e) => setFbName(e.target.value)}
                        placeholder="Your name"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={fieldLabel}>Email (optional)</label>
                      <input
                        type="email"
                        style={fieldInput}
                        value={fbEmail}
                        onChange={(e) => setFbEmail(e.target.value)}
                        placeholder="you@example.com"
                      />
                    </div>
                  </div>

                  <div>
                    <label style={fieldLabel}>Type</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["question", "bug", "feature", "other"] as const).map((t) => (
                        <button
                          key={t}
                          onClick={() => setFbType(t)}
                          style={{
                            padding: "4px 12px",
                            fontSize: 11,
                            fontWeight: fbType === t ? 700 : 500,
                            border: `1px solid ${fbType === t ? "var(--accent-blue)" : "var(--border-default)"}`,
                            borderRadius: 4,
                            background: fbType === t ? "rgba(88,166,255,0.12)" : "transparent",
                            color: fbType === t ? "var(--accent-blue)" : "var(--text-secondary)",
                            cursor: "pointer",
                            fontFamily: "var(--font-sans)",
                            textTransform: "capitalize",
                          }}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label style={fieldLabel}>Message *</label>
                    <textarea
                      style={{
                        ...fieldInput,
                        minHeight: 100,
                        resize: "vertical",
                        fontFamily: "var(--font-sans)",
                      }}
                      value={fbMessage}
                      onChange={(e) => setFbMessage(e.target.value)}
                      placeholder="Describe your question, issue, or idea..."
                    />
                  </div>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                    <button
                      className="zyra-btn zyra-btn--primary"
                      disabled={!fbMessage.trim() || fbStatus === "saving"}
                      onClick={submitFeedback}
                      style={{ fontSize: 12, opacity: fbMessage.trim() ? 1 : 0.5 }}
                    >
                      {fbStatus === "saving" ? "Sending..." : "Submit Feedback"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
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
            {tab === "guide" ? "Got it" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
