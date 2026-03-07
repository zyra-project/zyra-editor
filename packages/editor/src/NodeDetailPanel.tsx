import { useState, useEffect, useRef, useMemo } from "react";
import type { ArgDef, NodeRunStatus } from "@zyra/core";
import { STATUS_COLORS, getEffectivePorts } from "@zyra/core";
import type { ZyraNodeData } from "./ZyraNode";
import { isSensitive } from "./ZyraNode";
import type { NodeRunState } from "@zyra/core";
import { CronScheduleEditor } from "./CronScheduleEditor";

/** Scroll an element to its bottom. */
function scrollToBottom(el: HTMLElement | null) {
  if (el) el.scrollTop = el.scrollHeight;
}

type Tab = "settings" | "input" | "output";

interface Props {
  nodeId: string;
  data: ZyraNodeData;
  runState?: NodeRunState;
  connectedInputs: { portId: string; peerNodeId: string; peerLabel: string; peerValue?: string; peerStatus?: NodeRunStatus }[];
  connectedOutputs: { portId: string; peerNodeId: string; peerLabel: string; peerStatus?: NodeRunStatus }[];
  onArgChange: (nodeId: string, key: string, value: string | number | boolean) => void;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}

export function NodeDetailPanel({
  nodeId,
  data,
  runState,
  connectedInputs,
  connectedOutputs,
  onArgChange,
  onSelectNode,
  onClose,
}: Props) {
  const { stageDef, argValues } = data;
  const [activeTab, setActiveTab] = useState<Tab>("settings");


  // Auto-switch to output tab when node starts running
  useEffect(() => {
    if (runState?.status === "running") {
      setActiveTab("output");
    }
  }, [runState?.status]);

  // Auto-scroll the outer tab content to bottom so latest output is visible
  const tabContentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeTab === "output") {
      scrollToBottom(tabContentRef.current);
    }
  }, [runState?.stdout, runState?.stderr, runState?.exitCode, runState?.status, activeTab]);

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
          {stageDef.description && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.4 }}>
              {stageDef.description}
            </div>
          )}
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
      <div ref={tabContentRef} style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {activeTab === "settings" && (
          <SettingsTab
            nodeId={nodeId}
            stageDef={stageDef}
            argValues={argValues}
            connectedInputs={connectedInputs}
            onArgChange={onArgChange}
          />
        )}
        {activeTab === "input" && (
          <InputTab
            stageDef={stageDef}
            connectedInputs={connectedInputs}
            onSelectNode={onSelectNode}
          />
        )}
        {activeTab === "output" && (
          <OutputTab
            stageDef={stageDef}
            connectedOutputs={connectedOutputs}
            runState={runState}
            onSelectNode={onSelectNode}
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
  connectedInputs,
  onArgChange,
}: {
  nodeId: string;
  stageDef: ZyraNodeData["stageDef"];
  argValues: ZyraNodeData["argValues"];
  connectedInputs: Props["connectedInputs"];
  onArgChange: Props["onArgChange"];
}) {
  const definedKeys = new Set(stageDef.args.map((a) => a.key));
  const extraKeys = Object.keys(argValues).filter((k) => !definedKeys.has(k));

  // Build a map of arg key -> { label, value } for wired arg-ports
  const linkedArgs = new Map<string, { label: string; value?: string }>();
  for (const conn of connectedInputs) {
    // arg-port IDs have the format "arg:<key>"
    if (conn.portId.startsWith("arg:")) {
      linkedArgs.set(conn.portId.slice(4), { label: conn.peerLabel, value: conn.peerValue });
    }
  }

  return (
    <>
      {stageDef.args.length === 0 && extraKeys.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
          No configurable arguments for this node.
        </div>
      )}
      {stageDef.args.map((arg) => {
        const linkedFrom = linkedArgs.get(arg.key);
        // Mask the value field when the Variable node type is "secret"
        const isSecretVariable = stageDef.command === "variable"
          && arg.key === "value"
          && argValues.var_type === "secret";

        // Cron schedule: replace the expression field with the visual editor
        if (stageDef.command === "cron" && arg.key === "expression") {
          return (
            <div key={arg.key} style={{ marginBottom: 14 }}>
              <label style={{
                display: "block",
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 4,
                color: "var(--text-primary)",
              }}>
                {arg.label}
                {arg.required && <span style={{ color: "var(--accent-red)" }}> *</span>}
              </label>
              {arg.description && (
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6, lineHeight: 1.4 }}>
                  {arg.description}
                </div>
              )}
              <CronScheduleEditor
                value={String(argValues[arg.key] ?? "")}
                onChange={(v) => onArgChange(nodeId, arg.key, v)}
              />
            </div>
          );
        }

        return (
          <ArgField
            key={arg.key}
            arg={arg}
            value={argValues[arg.key]}
            linkedFrom={linkedFrom}
            onChange={(v) => onArgChange(nodeId, arg.key, v)}
            forceSecret={isSecretVariable}
          />
        );
      })}
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
  onSelectNode,
}: {
  stageDef: ZyraNodeData["stageDef"];
  connectedInputs: Props["connectedInputs"];
  onSelectNode: Props["onSelectNode"];
}) {
  const { inputs: allInputs } = useMemo(() => getEffectivePorts(stageDef), [stageDef]);
  // Show explicit ports always, arg-ports only if they have connections
  const visiblePorts = allInputs.filter((port) => {
    if (!port.implicit) return true;
    return connectedInputs.some((c) => c.portId === port.id);
  });

  return (
    <>
      {visiblePorts.map((port) => {
        const connections = connectedInputs.filter((c) => c.portId === port.id);
        const argDef = port.argKey ? stageDef.args?.find((a) => a.key === port.argKey) : undefined;
        const sensitive = argDef ? isSensitive(argDef) : false;
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
                <div
                  key={i}
                  onClick={() => onSelectNode(conn.peerNodeId)}
                  style={{
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
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-secondary)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-primary)"; }}
                  title={`Jump to ${conn.peerLabel}${conn.peerValue && !sensitive ? ` (${conn.peerValue})` : ""}`}
                >
                  <span style={{ color: "var(--text-primary)" }}>{conn.peerLabel}</span>
                  {conn.peerValue && (
                    <span style={{
                      color: "var(--text-muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}>
                      {sensitive ? "••••••••" : conn.peerValue.length > 24 ? conn.peerValue.slice(0, 24) + "\u2026" : conn.peerValue}
                    </span>
                  )}
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
      {visiblePorts.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
          No connected input ports. Connect arg-ports on the canvas to see them here.
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
  onSelectNode,
}: {
  stageDef: ZyraNodeData["stageDef"];
  connectedOutputs: Props["connectedOutputs"];
  runState?: NodeRunState;
  onSelectNode: Props["onSelectNode"];
}) {
  const stdoutRef = useRef<HTMLPreElement>(null);
  const stderrRef = useRef<HTMLPreElement>(null);

  // Auto-scroll stdout and stderr pre blocks to bottom when content changes
  useEffect(() => {
    scrollToBottom(stdoutRef.current);
  }, [runState?.stdout]);

  useEffect(() => {
    scrollToBottom(stderrRef.current);
  }, [runState?.stderr]);

  const { outputs: allOutputs } = useMemo(() => getEffectivePorts(stageDef), [stageDef]);
  // Show explicit ports always, implicit ports only if connected
  const visibleOutputPorts = allOutputs.filter((port) => {
    if (!port.implicit) return true;
    return connectedOutputs.some((c) => c.portId === port.id);
  });

  return (
    <>
      {/* Port info */}
      {visibleOutputPorts.map((port) => {
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
              <div
                key={i}
                onClick={() => onSelectNode(conn.peerNodeId)}
                style={{
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
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-secondary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-primary)"; }}
                title={`Jump to ${conn.peerLabel}`}
              >
                <span style={{ color: "var(--text-primary)" }}>{conn.peerLabel}</span>
                {conn.peerStatus && (
                  <StatusBadge status={conn.peerStatus} />
                )}
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
                color: "var(--text-secondary)",
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
            <pre ref={stdoutRef} style={{
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
            <pre ref={stderrRef} style={{
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

/* ── ISO 8601 Duration Validation ──────────────────────── */

const ISO8601_DURATION = /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?!$)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

function isValidISO8601Duration(v: string): boolean {
  return ISO8601_DURATION.test(v);
}

/* ── Arg Field ──────────────────────────────────────────── */

function ArgField({
  arg,
  value,
  linkedFrom,
  onChange,
  forceSecret,
}: {
  arg: ArgDef;
  value: string | number | boolean | undefined;
  /** If this arg is wired from another node, the peer node's label and optional value. */
  linkedFrom?: { label: string; value?: string };
  onChange: (v: string | number | boolean) => void;
  /** Override: treat this field as a secret (password input) regardless of name/label. */
  forceSecret?: boolean;
}) {
  const id = `arg-${arg.key}`;

  // ISO 8601 duration validation for the custom_period field
  const needsDurationValidation = arg.key === "custom_period";
  const strValue = typeof value === "string" ? value : "";
  const durationInvalid = needsDurationValidation && strValue.length > 0 && !isValidISO8601Duration(strValue);
  const treatAsSensitive = forceSecret || isSensitive(arg);

  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={linkedFrom ? undefined : id} style={{
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

      {/* Linked from another node — show read-only badge with optional value preview */}
      {linkedFrom && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          background: "var(--bg-primary)",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--accent-blue)",
          fontSize: 11,
          color: "var(--accent-blue)",
          overflow: "hidden",
        }}>
          <span style={{ fontSize: 9, opacity: 0.7, flexShrink: 0 }}>linked</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{linkedFrom.label}</span>
          {linkedFrom.value && (
            <span
              style={{
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flexShrink: 1,
                minWidth: 0,
              }}
              title={isSensitive(arg) ? "Linked value hidden (sensitive)" : linkedFrom.value}
            >
              {isSensitive(arg) ? "••••••••" : linkedFrom.value}
            </span>
          )}
        </div>
      )}

      {!linkedFrom && (
        arg.type === "enum" && arg.options ? (
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
        ) : arg.type === "date" ? (
          <input
            id={id}
            className="zyra-input"
            type="date"
            value={(value as string) ?? ""}
            placeholder={arg.placeholder ?? ""}
            onChange={(e) => onChange(e.target.value)}
            style={{ colorScheme: "dark" }}
          />
        ) : arg.type === "boolean" ? (
          (() => {
            const effectiveValue = value !== undefined ? !!value : !!arg.default;
            return (
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  id={id}
                  type="checkbox"
                  checked={effectiveValue}
                  onChange={(e) => onChange(e.target.checked)}
                  style={{ accentColor: "var(--accent-blue)" }}
                />
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  {effectiveValue ? "Enabled" : "Disabled"}
                </span>
              </label>
            );
          })()
        ) : (
          <>
            <input
              id={id}
              className="zyra-input"
              type={treatAsSensitive ? "password" : arg.type === "number" ? "number" : "text"}
              value={(value as string) ?? ""}
              placeholder={arg.placeholder ?? ""}
              onChange={(e) => {
                if (arg.type === "number") {
                  onChange(e.target.value === "" ? "" : Number(e.target.value));
                } else {
                  onChange(e.target.value);
                }
              }}
              style={durationInvalid ? { borderColor: "var(--accent-red)" } : undefined}
            />
            {durationInvalid && (
              <div style={{ fontSize: 11, color: "var(--accent-red)", marginTop: 4 }}>
                Invalid ISO 8601 duration. Use format like P1D, P2W, P1M, P1Y6M, PT12H.
              </div>
            )}
          </>
        )
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
