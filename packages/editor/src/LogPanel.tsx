import { useEffect, useRef, useState } from "react";
import type { RunStateMap } from "./useExecution";
import { STATUS_COLORS } from "@zyra/core";

interface LogPanelProps {
  runState: RunStateMap;
  selectedNodeId: string | null;
}

export function LogPanel({ runState, selectedNodeId }: LogPanelProps) {
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
              <button
                key={nodeId}
                onClick={() => setActiveTab(nodeId)}
                style={{
                  background: activeTab === nodeId ? "#0d1117" : "transparent",
                  border: "none",
                  borderBottom:
                    activeTab === nodeId ? "2px solid #58a6ff" : "2px solid transparent",
                  color: activeTab === nodeId ? "#c9d1d9" : "#8b949e",
                  padding: "4px 12px",
                  fontSize: 11,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {nodeId}
                <StatusDot status={state.status} />
              </button>
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
                    {JSON.stringify(activeState.submittedRequest.args, null, 2)}
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
                <div style={{ marginTop: 8, color: "#58a6ff", fontSize: 11 }}>
                  Waiting for response…
                </div>
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
