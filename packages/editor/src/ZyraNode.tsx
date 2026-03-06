import { useState, useMemo } from "react";
import { Handle, Position, NodeResizer, useReactFlow, type NodeProps } from "@xyflow/react";
import type { ArgDef, StageDef, NodeRunStatus, PortDef } from "@zyra/core";
import { STATUS_COLORS, getEffectivePorts } from "@zyra/core";

export const SENSITIVE_PATTERNS = /password|secret|token|credential|auth|api.?key/i;
export function isSensitive(arg: ArgDef): boolean {
  return SENSITIVE_PATTERNS.test(arg.key) || SENSITIVE_PATTERNS.test(arg.label);
}

export interface ZyraNodeData {
  stageDef: StageDef;
  argValues: Record<string, string | number | boolean>;
  /** User-customizable display label for this node. */
  nodeLabel?: string;
  runStatus?: NodeRunStatus;
  dryRunArgv?: string;
  /** Callback to run this single node. Injected by App. */
  onRunNode?: (nodeId: string) => void;
  /** Set of port IDs that have incoming edges (for arg-port linked state). */
  connectedInputPorts?: Set<string>;
  /** Set of port IDs that have outgoing edges (for implicit output visibility). */
  connectedOutputPorts?: Set<string>;
  [key: string]: unknown;
}

const statusIndicator: Record<
  NodeRunStatus,
  { color: string; label: string; pulse?: boolean }
> = {
  idle: { color: "transparent", label: "" },
  "dry-run": { color: STATUS_COLORS["dry-run"], label: "DRY" },
  queued: { color: STATUS_COLORS.queued, label: "" },
  running: { color: STATUS_COLORS.running, label: "", pulse: true },
  succeeded: { color: STATUS_COLORS.succeeded, label: "\u2713" },
  failed: { color: STATUS_COLORS.failed, label: "\u2717" },
  canceled: { color: STATUS_COLORS.canceled, label: "\u2014" },
};

export function ZyraNode({ id, data, selected }: NodeProps) {
  const {
    stageDef, argValues, nodeLabel, runStatus, dryRunArgv, onRunNode,
    connectedInputPorts, connectedOutputPorts,
  } = data as unknown as ZyraNodeData;
  const indicator = statusIndicator[runStatus ?? "idle"];
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [expanded, setExpanded] = useState(false);
  const { deleteElements, updateNodeData } = useReactFlow();

  const displayLabel = nodeLabel || stageDef.label;

  const connIn = connectedInputPorts ?? new Set<string>();
  const connOut = connectedOutputPorts ?? new Set<string>();

  // Compute effective ports (explicit + arg-inputs + implicit outputs)
  const { inputs: allInputs, outputs: allOutputs } = useMemo(
    () => getEffectivePorts(stageDef),
    [stageDef],
  );

  // Visible inputs: explicit ports always shown, arg-ports shown if connected/filled/expanded
  const visibleInputs = useMemo(() => {
    return allInputs.filter((port) => {
      if (!port.implicit) return true; // explicit ports always visible
      if (connIn.has(port.id)) return true; // connected
      if (port.argKey && argValues[port.argKey] !== undefined && argValues[port.argKey] !== "") return true; // filled
      return expanded;
    });
  }, [allInputs, connIn, argValues, expanded]);

  // Visible outputs: explicit ports always shown, implicit shown if connected or expanded
  const visibleOutputs = useMemo(() => {
    return allOutputs.filter((port) => {
      if (!port.implicit) return true;
      if (connOut.has(port.id)) return true;
      return expanded;
    });
  }, [allOutputs, connOut, expanded]);

  // Count hidden ports for the expand toggle
  const hiddenInputCount = allInputs.length - visibleInputs.length;
  const hiddenOutputCount = allOutputs.length - visibleOutputs.length;
  const hiddenCount = hiddenInputCount + hiddenOutputCount;

  // Build a map from argKey -> ArgDef for looking up sensitive status
  const argDefMap = useMemo(() => {
    const m = new Map<string, ArgDef>();
    for (const a of stageDef.args) m.set(a.key, a);
    return m;
  }, [stageDef.args]);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "var(--bg-node)",
        border: selected ? "2px solid var(--node-selected)" : "1px solid var(--border-strong)",
        borderRadius: "var(--radius-lg)",
        minWidth: 180,
        width: "100%",
        height: "100%",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        color: "var(--text-bright)",
        overflow: "hidden",
        boxShadow: `0 2px 8px var(--node-shadow)`,
        transition: "border-color 0.15s, box-shadow 0.15s",
        display: "flex",
        flexDirection: "column" as const,
      }}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={180}
        minHeight={80}
        lineStyle={{ borderColor: "var(--node-selected)" }}
        handleStyle={{ background: "var(--node-selected)", width: 8, height: 8 }}
      />
      {/* Header */}
      <div
        style={{
          background: stageDef.color,
          padding: "6px 12px",
          borderRadius: "7px 7px 0 0",
          fontWeight: 600,
          fontSize: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        {editing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => {
              const trimmed = editValue.trim();
              updateNodeData(id, { nodeLabel: trimmed || undefined });
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") { setEditing(false); }
            }}
            style={{
              background: "rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.3)",
              borderRadius: 3,
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              padding: "1px 4px",
              outline: "none",
              width: "100%",
              fontFamily: "inherit",
            }}
          />
        ) : (
          <span
            onDoubleClick={() => {
              setEditValue(nodeLabel || "");
              setEditing(true);
            }}
            title="Double-click to rename"
            style={{ cursor: "text" }}
          >
            {displayLabel}
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {hovered && onRunNode && runStatus !== "running" && (
            <button
              title="Run this step"
              aria-label="Run this step"
              onClick={(e) => {
                e.stopPropagation();
                onRunNode(id);
              }}
              style={{
                background: "rgba(0,0,0,0.3)",
                border: "none",
                borderRadius: 3,
                color: "var(--accent-green)",
                cursor: "pointer",
                fontSize: 11,
                lineHeight: 1,
                padding: "2px 5px",
                display: "inline-flex",
                alignItems: "center",
                fontWeight: 700,
              }}
            >
              &#9654;
            </button>
          )}
          {hovered && (
            <button
              title="Delete node"
              onClick={(e) => {
                e.stopPropagation();
                deleteElements({ nodes: [{ id }] });
              }}
              style={{
                background: "rgba(0,0,0,0.3)",
                border: "none",
                borderRadius: 3,
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1,
                padding: "2px 4px",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              &times;
            </button>
          )}
          <span style={{ fontSize: 10, opacity: 0.7 }}>{stageDef.stage}</span>
          {indicator.color !== "transparent" && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: indicator.label ? "auto" : 10,
                minWidth: 10,
                height: indicator.label ? 16 : 10,
                padding: indicator.label ? "0 4px" : 0,
                borderRadius: indicator.label ? 3 : "50%",
                background: indicator.color,
                fontSize: 9,
                fontWeight: 700,
                color: "#fff",
                animation: indicator.pulse ? "zyra-pulse 1.2s infinite" : undefined,
              }}
            >
              {indicator.label}
            </span>
          )}
        </div>
      </div>

      {/* Ports — flex column so outputs stay pinned at the bottom */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        overflow: "hidden",
        position: "relative",
      }}>
        {/* Scrollable input ports */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 12px 0",
          minHeight: 0,
        }}>
          {visibleInputs.map((port) => (
            <InputPortRow
              key={port.id}
              port={port}
              isConnected={connIn.has(port.id)}
              argDef={port.argKey ? argDefMap.get(port.argKey) : undefined}
              argValue={port.argKey ? argValues[port.argKey] : undefined}
            />
          ))}

          {/* Expand/collapse toggle */}
          {hiddenCount > 0 && !expanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
              style={{ ...expandButtonStyle, marginTop: 4 }}
            >
              + {hiddenCount} more port{hiddenCount !== 1 ? "s" : ""}
            </button>
          )}
          {expanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
              style={{ ...expandButtonStyle, marginTop: 4 }}
            >
              show less
            </button>
          )}
        </div>

        {/* Pinned output ports + dry-run (always visible at bottom) */}
        <div style={{
          flexShrink: 0,
          padding: "4px 12px 8px",
          borderTop: visibleOutputs.length > 0 ? "1px solid var(--border-default)" : undefined,
        }}>
          {visibleOutputs.map((port) => (
            <OutputPortRow key={port.id} port={port} isImplicit={!!port.implicit} />
          ))}

          {/* Dry-run resolved command */}
          {dryRunArgv && (
            <div
              style={{
                borderTop: "1px solid var(--border-default)",
                marginTop: 6,
                paddingTop: 6,
                fontSize: 10,
                color: "var(--accent-blue)",
                fontFamily: "var(--font-mono)",
                wordBreak: "break-all",
                maxHeight: 40,
                overflow: "auto",
              }}
            >
              {dryRunArgv}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Port row components ──────────────────────────────────────── */

function InputPortRow({ port, isConnected, argDef, argValue }: {
  port: PortDef;
  isConnected: boolean;
  argDef?: ArgDef;
  argValue?: string | number | boolean;
}) {
  const isArgPort = !!port.argKey;
  const hasFill = argValue !== undefined && argValue !== "";
  const sensitive = argDef ? isSensitive(argDef) : false;

  return (
    <div style={{ position: "relative", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        style={{
          ...handleStyle,
          top: "50%",
          background: isConnected ? "var(--accent-blue)" : isArgPort ? "var(--handle-arg)" : "var(--handle-input)",
          borderStyle: isArgPort && !isConnected ? "dashed" : "solid",
        }}
      />
      <span style={{
        fontSize: 11,
        color: isConnected ? "var(--accent-blue)" : "var(--text-secondary)",
        marginLeft: 8,
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {port.label}
        {!isArgPort && (
          <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: 4 }}>
            [{port.types.join(", ")}]
          </span>
        )}
      </span>
      {/* Show value for arg-ports (or linked indicator) */}
      {isArgPort && isConnected && (
        <span style={{
          fontSize: 9,
          color: "var(--accent-blue)",
          fontFamily: "var(--font-mono)",
          flexShrink: 0,
        }}>
          linked
        </span>
      )}
      {isArgPort && !isConnected && hasFill && (
        <span style={{
          fontSize: 10,
          color: "var(--accent-blue)",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: "50%",
          flexShrink: 1,
          textAlign: "right",
        }} title={String(argValue)}>
          {sensitive ? "••••••••" : String(argValue)}
        </span>
      )}
    </div>
  );
}

function OutputPortRow({ port, isImplicit }: { port: PortDef; isImplicit: boolean }) {
  return (
    <div
      style={{
        position: "relative",
        textAlign: "right",
        marginBottom: 4,
      }}
    >
      <Handle
        type="source"
        position={Position.Right}
        id={port.id}
        style={{
          ...handleStyle,
          top: "50%",
          background: isImplicit ? "var(--handle-arg)" : "var(--handle-output)",
          borderStyle: isImplicit ? "dashed" : "solid",
        }}
      />
      <span style={{ fontSize: 11, color: isImplicit ? "var(--text-muted)" : "var(--text-secondary)", marginRight: 8 }}>
        <span style={{ fontSize: 9, color: "var(--text-muted)", marginRight: 4 }}>
          [{port.types.join(", ")}]
        </span>
        {port.label}
      </span>
    </div>
  );
}

/* ── Styles ──────────────────────────────────────────────────── */

const handleStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  border: "2px solid var(--handle-border)",
  transition: "transform 0.1s",
};

const expandButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  fontSize: 10,
  cursor: "pointer",
  padding: "2px 0",
  fontFamily: "inherit",
  textAlign: "left",
  width: "100%",
};
