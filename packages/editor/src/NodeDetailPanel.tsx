import { useState, useEffect, useRef } from "react";
import type { ArgDef, NodeRunStatus } from "@zyra/core";
import { STATUS_COLORS } from "@zyra/core";
import type { ZyraNodeData } from "./ZyraNode";
import { isSensitive, SENSITIVE_PATTERNS } from "./ZyraNode";
import type { NodeRunState } from "@zyra/core";

type Tab = "settings" | "input" | "output";

interface Props {
  nodeId: string;
  data: ZyraNodeData;
  runState?: NodeRunState;
  connectedInputs: { portId: string; peerLabel: string; peerStatus?: NodeRunStatus }[];
  connectedOutputs: { portId: string; peerLabel: string; peerStatus?: NodeRunStatus }[];
  onArgChange: (nodeId: string, key: string, value: string | number | boolean) => void;
  onClose: () => void;
}

export function NodeDetailPanel({
  nodeId,
  data,
  runState,
  connectedInputs,
  connectedOutputs,
  onArgChange,
  onClose,
}: Props) {
  const { stageDef, argValues } = data;
  const [activeTab, setActiveTab] = useState<Tab>("settings");
  const logEndRef = useRef<HTMLDivElement>(null!);


  // Auto-switch to output tab when node starts running
  useEffect(() => {
    if (runState?.status === "running") {
      setActiveTab("output");
    }
  }, [runState?.status]);

  // Auto-scroll logs
  useEffect(() => {
    if (activeTab === "output") {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [runState?.stdout, runState?.stderr, activeTab]);

  const statusColor = runState?.status
    ? (STATUS_COLORS as Record<string, string>)[runState.status]
    : undefined;

  return (
    <div className="zyra-detail" style={{
      width: 340,
      background: "var(--bg-tertiary)",
      borderLeft: "1px solid var(--border-default)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      color: "var(--text-bright)",
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
        <div style={{
          width: 4,
          height: 20,
          borderRadius: 2,
          background: stageDef.color,
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data.nodeLabel || stageDef.label}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
            {stageDef.cli}
          </div>
        </div>
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

      {/* Tabs */}
      <div className="zyra-tabs">
        <button
          className={`zyra-tab ${activeTab === "settings" ? "zyra-tab--active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </button>
        <button
          className={`zyra-tab ${activeTab === "input" ? "zyra-tab--active" : ""}`}
          onClick={() => setActiveTab("input")}
        >
          Input
          {connectedInputs.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>({connectedInputs.length})</span>
          )}
        </button>
        <button
          className={`zyra-tab ${activeTab === "output" ? "zyra-tab--active" : ""}`}
          onClick={() => setActiveTab("output")}
        >
          Output
          {statusColor && (
            <span className="zyra-tab__badge" style={{ background: statusColor }} />
          )}
        </button>
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {activeTab === "settings" && (
          <SettingsTab
            nodeId={nodeId}
            stageDef={stageDef}
            argValues={argValues}
            onArgChange={onArgChange}
          />
        )}
        {activeTab === "input" && (
          <InputTab
            stageDef={stageDef}
            connectedInputs={connectedInputs}
          />
        )}
        {activeTab === "output" && (
          <OutputTab
            stageDef={stageDef}
            connectedOutputs={connectedOutputs}
            runState={runState}
            logEndRef={logEndRef}
          />
        )}
      </div>
    </div>
  );
}

/* ── Settings Tab ──────────────────────────────────────────── */

function SettingsTab({
  nodeId,
  stageDef,
  argValues,
  onArgChange,
}: {
  nodeId: string;
  stageDef: ZyraNodeData["stageDef"];
  argValues: ZyraNodeData["argValues"];
  onArgChange: Props["onArgChange"];
}) {
  const definedKeys = new Set(stageDef.args.map((a) => a.key));
  const extraKeys = Object.keys(argValues).filter((k) => !definedKeys.has(k));

  return (
    <>
      {stageDef.args.length === 0 && extraKeys.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
          No configurable arguments for this node.
        </div>
      )}
      {stageDef.args.map((arg) => (
        <ArgField
          key={arg.key}
          arg={arg}
          value={argValues[arg.key]}
          onChange={(v) => onArgChange(nodeId, arg.key, v)}
        />
      ))}
      {extraKeys.length > 0 && (
        <>
          <div style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            marginTop: 16,
            marginBottom: 8,
          }}>
            Extra Arguments
          </div>
          {extraKeys.map((key) => (
            <ArgField
              key={key}
              arg={{
                key,
                label: key,
                type: typeof argValues[key] === "number" ? "number"
                  : typeof argValues[key] === "boolean" ? "boolean"
                  : "string",
                required: false,
              }}
              value={argValues[key]}
              onChange={(v) => onArgChange(nodeId, key, v)}
            />
          ))}
        </>
      )}
    </>
  );
}

/* ── Input Tab ──────────────────────────────────────────── */

function InputTab({
  stageDef,
  connectedInputs,
}: {
  stageDef: ZyraNodeData["stageDef"];
  connectedInputs: Props["connectedInputs"];
}) {
  return (
    <>
      {stageDef.inputs.map((port) => {
        const connections = connectedInputs.filter((c) => c.portId === port.id);
        return (
          <div key={port.id} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "var(--handle-input)",
                flexShrink: 0,
              }} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>{port.label}</span>
              <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                [{port.types.join(", ")}]
              </span>
            </div>
            {connections.length > 0 ? (
              connections.map((conn, i) => (
                <div key={i} style={{
                  marginLeft: 18,
                  padding: "4px 8px",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  background: "var(--bg-primary)",
                  borderRadius: "var(--radius-sm)",
                  marginBottom: 4,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                  <span style={{ color: "var(--text-primary)" }}>{conn.peerLabel}</span>
                  {conn.peerStatus && (
                    <StatusBadge status={conn.peerStatus} />
                  )}
                </div>
              ))
            ) : (
              <div style={{ marginLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
                Not connected
              </div>
            )}
          </div>
        );
      })}
      {stageDef.inputs.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
          This node has no input ports.
        </div>
      )}
    </>
  );
}

/* ── Output Tab ──────────────────────────────────────────── */

function OutputTab({
  stageDef,
  connectedOutputs,
  runState,
  logEndRef,
}: {
  stageDef: ZyraNodeData["stageDef"];
  connectedOutputs: Props["connectedOutputs"];
  runState?: NodeRunState;
  logEndRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <>
      {/* Port info */}
      {stageDef.outputs.map((port) => {
        const connections = connectedOutputs.filter((c) => c.portId === port.id);
        return (
          <div key={port.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "var(--handle-output)",
                flexShrink: 0,
              }} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>{port.label}</span>
              <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                [{port.types.join(", ")}]
              </span>
            </div>
            {connections.length > 0 && connections.map((conn, i) => (
              <div key={i} style={{
                marginLeft: 18,
                padding: "4px 8px",
                fontSize: 12,
                color: "var(--text-secondary)",
                background: "var(--bg-primary)",
                borderRadius: "var(--radius-sm)",
                marginBottom: 4,
              }}>
                &#8594; {conn.peerLabel}
              </div>
            ))}
          </div>
        );
      })}

      {/* Execution Results */}
      {runState ? (
        <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: 12, marginTop: 4 }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            fontSize: 12,
            fontWeight: 600,
          }}>
            <StatusBadge status={runState.status} />
            <span>Execution {runState.status === "running" ? "in progress" : runState.status}</span>
          </div>

          {/* Submitted request preview */}
          {runState.submittedRequest && (
            <div style={{
              marginBottom: 8,
              padding: 8,
              background: "var(--bg-primary)",
              borderRadius: "var(--radius-sm)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}>
              <div style={{ color: "var(--accent-blue)", marginBottom: 4 }}>
                $ zyra {runState.submittedRequest.stage} {runState.submittedRequest.command}
              </div>
              <pre style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                color: "var(--text-muted)",
                fontSize: 10,
              }}>
                {JSON.stringify(
                  maskArgs(runState.submittedRequest.args as Record<string, unknown>),
                  null,
                  2,
                )}
              </pre>
            </div>
          )}

          {/* Dry-run argv */}
          {runState.dryRunArgv && (
            <div style={{
              padding: 8,
              background: "var(--bg-primary)",
              borderRadius: "var(--radius-sm)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--accent-blue)",
              marginBottom: 8,
              wordBreak: "break-all",
            }}>
              $ {runState.dryRunArgv}
            </div>
          )}

          {/* stdout */}
          {runState.stdout && (
            <pre style={{
              margin: "0 0 8px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              background: "var(--bg-primary)",
              padding: 8,
              borderRadius: "var(--radius-sm)",
              maxHeight: 300,
              overflow: "auto",
            }}>
              {runState.stdout}
            </pre>
          )}

          {/* stderr */}
          {runState.stderr && (
            <pre style={{
              margin: "0 0 8px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-error)",
              background: "var(--bg-error)",
              padding: 8,
              borderRadius: "var(--radius-sm)",
              maxHeight: 200,
              overflow: "auto",
            }}>
              {runState.stderr}
            </pre>
          )}

          {/* Exit code */}
          {runState.exitCode !== undefined && runState.exitCode !== null && (
            <div style={{
              fontSize: 12,
              fontWeight: 600,
              color: runState.exitCode === 0 ? "var(--accent-green)" : "var(--accent-red)",
              marginBottom: 8,
            }}>
              {runState.exitCode === 0 ? "Completed successfully" : `Exit code: ${runState.exitCode}`}
              {runState.exitCode === 0 && !runState.stdout && !runState.stderr && (
                <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
                  (no output captured)
                </span>
              )}
            </div>
          )}

          {/* Running indicator */}
          {runState.status === "running" && <RunningIndicator />}

          <div ref={logEndRef} />
        </div>
      ) : (
        <div style={{
          borderTop: "1px solid var(--border-default)",
          paddingTop: 12,
          marginTop: 4,
          color: "var(--text-muted)",
          fontSize: 12,
        }}>
          Run this node to see output here.
        </div>
      )}
    </>
  );
}

/* ── Arg Field ──────────────────────────────────────────── */

function ArgField({
  arg,
  value,
  onChange,
}: {
  arg: ArgDef;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  const id = `arg-${arg.key}`;

  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={id} style={{
        display: "block",
        fontSize: 12,
        fontWeight: 600,
        marginBottom: 4,
        color: "var(--text-primary)",
      }}>
        {arg.label}
        {arg.required && <span style={{ color: "var(--accent-red)" }}> *</span>}
        {arg.flag && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6, fontFamily: "var(--font-mono)" }}>
            {arg.flag}
          </span>
        )}
      </label>
      {arg.description && (
        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6, lineHeight: 1.4 }}>
          {arg.description}
        </div>
      )}

      {arg.type === "enum" && arg.options ? (
        <select
          id={id}
          className="zyra-input"
          value={(value as string) ?? arg.default ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" disabled>Select...</option>
          {arg.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : arg.type === "boolean" ? (
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            id={id}
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            style={{ accentColor: "var(--accent-blue)" }}
          />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {value ? "Enabled" : "Disabled"}
          </span>
        </label>
      ) : (
        <input
          id={id}
          className="zyra-input"
          type={isSensitive(arg) ? "password" : arg.type === "number" ? "number" : "text"}
          value={(value as string) ?? ""}
          placeholder={arg.placeholder ?? ""}
          onChange={(e) =>
            onChange(arg.type === "number" ? Number(e.target.value) : e.target.value)
          }
        />
      )}
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────── */

function StatusBadge({ status }: { status: NodeRunStatus }) {
  const color = (STATUS_COLORS as Record<string, string>)[status];
  if (!color) return null;

  const labels: Partial<Record<NodeRunStatus, string>> = {
    "dry-run": "DRY",
    succeeded: "\u2713",
    failed: "\u2717",
    canceled: "\u2014",
  };

  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: 10,
      height: labels[status] ? 16 : 10,
      padding: labels[status] ? "0 5px" : 0,
      borderRadius: labels[status] ? "var(--radius-sm)" : "50%",
      background: color,
      fontSize: 9,
      fontWeight: 700,
      color: "#fff",
      animation: status === "running" ? "zyra-pulse 1.2s infinite" : undefined,
    }}>
      {labels[status] ?? ""}
    </span>
  );
}

function RunningIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ color: "var(--accent-blue)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
      Running… {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
    </div>
  );
}

const SENSITIVE_KEY = /password|secret|token|credential|auth|api.?key/i;

function maskArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SENSITIVE_KEY.test(k) ? "••••••••" : v;
  }
  return out;
}
