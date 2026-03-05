import { useEffect, useRef, useState } from "react";
import type { RunStateMap } from "./useExecution";
import { STATUS_COLORS } from "@zyra/core";

const SENSITIVE_KEY = /password|secret|token|credential|auth|api.?key/i;

/** Redact sensitive values from an args dict for display. */
function maskArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SENSITIVE_KEY.test(k) ? "••••••••" : v;
  }
  return out;
}

/** Formats seconds into a human-readable elapsed string. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

interface LogPanelProps {
  runState: RunStateMap;
  selectedNodeId: string | null;
  onClearNode?: (nodeId: string) => void;
}

export function LogPanel({ runState, selectedNodeId, onClearNode }: LogPanelProps) {
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Auto-select running node or follow selectedNodeId
  useEffect(() => {
    if (selectedNodeId && runState.has(selectedNodeId)) {
      setActiveTab(selectedNodeId);
      return;
    }
    for (const [nodeId, state] of runState) {
      if (state.status === "running") {
        setActiveTab(nodeId);
        return;
      }
    }
  }, [selectedNodeId, runState]);

  // Auto-scroll
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [runState, activeTab]);

  if (runState.size === 0) return null;

  const activeState = activeTab ? runState.get(activeTab) : undefined;

  return (
    <div
      style={{
        background: "#0d1117",
        borderTop: "1px solid #30363d",
        display: "flex",
        flexDirection: "column",
        height: collapsed ? 32 : 200,
        minHeight: 32,
        fontFamily: "monospace",
        fontSize: 12,
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "#161b22",
          borderBottom: "1px solid #30363d",
          height: 32,
          minHeight: 32,
          overflow: "hidden",
        }}
      >
        <button
          onClick={() => setCollapsed(!collapsed)}
          style={{
            background: "none",
            border: "none",
            color: "#8b949e",
            cursor: "pointer",
            padding: "0 8px",
            fontSize: 10,
          }}
        >
          {collapsed ? "\u25b2 Logs" : "\u25bc Logs"}
        </button>

        {!collapsed && (
          <div style={{ display: "flex", overflow: "auto", flex: 1 }}>
            {Array.from(runState.entries()).map(([nodeId, state]) => (
              <span
                key={nodeId}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  background: activeTab === nodeId ? "#0d1117" : "transparent",
                  borderBottom:
                    activeTab === nodeId ? "2px solid #58a6ff" : "2px solid transparent",
                }}
              >
                <button
                  onClick={() => setActiveTab(nodeId)}
                  style={{
                    background: "none",
                    border: "none",
                    color: activeTab === nodeId ? "#c9d1d9" : "#8b949e",
                    padding: "4px 8px 4px 12px",
                    fontSize: 11,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {nodeId}
                  <StatusDot status={state.status} />
                </button>
                {onClearNode && state.status !== "running" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onClearNode(nodeId);
                      if (activeTab === nodeId) setActiveTab(null);
                    }}
                    title="Clear log"
                    aria-label={`Clear log for ${nodeId}`}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#484f58",
                      cursor: "pointer",
                      fontSize: 10,
                      padding: "0 6px 0 0",
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Log content */}
      {!collapsed && (
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "8px 12px",
            color: "#c9d1d9",
            lineHeight: 1.5,
          }}
        >
          {activeState ? (
            <>
              {activeState.submittedRequest && (
                <div style={{ color: "#8b949e", marginBottom: 8 }}>
                  <span style={{ color: "#58a6ff" }}>
                    $ zyra {activeState.submittedRequest.stage} {activeState.submittedRequest.command}
                  </span>
                  <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", color: "#6e7681", fontSize: 11 }}>
                    {JSON.stringify(maskArgs(activeState.submittedRequest.args as Record<string, unknown>), null, 2)}
                  </pre>
                </div>
              )}
              {activeState.dryRunArgv && (
                <div style={{ color: "#58a6ff", marginBottom: 8 }}>
                  $ {activeState.dryRunArgv}
                </div>
              )}
              {activeState.stdout && (
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                  {activeState.stdout}
                </pre>
              )}
              {activeState.stderr && (
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", color: "#f85149" }}>
                  {activeState.stderr}
                </pre>
              )}
              {activeState.exitCode !== undefined && activeState.exitCode !== null && (
                <div
                  style={{
                    marginTop: 8,
                    color: activeState.exitCode === 0 ? "#3fb950" : "#f85149",
                    fontWeight: 600,
                  }}
                >
                  {activeState.exitCode === 0 ? "Completed successfully" : `Exit code: ${activeState.exitCode}`}
                  {activeState.exitCode === 0 && !activeState.stdout && !activeState.stderr && (
                    <span style={{ fontWeight: 400, color: "#8b949e", marginLeft: 8 }}>
                      (no output captured — command ran silently)
                    </span>
                  )}
                </div>
              )}
              {activeState.status === "running" && (
                <RunningIndicator />
              )}
              <div ref={logEndRef} />
            </>
          ) : (
            <div style={{ color: "#484f58" }}>Select a node to view logs</div>
          )}
        </div>
      )}
    </div>
  );
}

function RunningIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ marginTop: 8, color: "#58a6ff", fontSize: 11 }}>
      Running… {formatElapsed(elapsed)}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = (STATUS_COLORS as Record<string, string>)[status];
  if (!color) return null;
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        marginLeft: 6,
        verticalAlign: "middle",
      }}
    />
  );
}
