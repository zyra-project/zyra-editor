import { useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow, type NodeProps } from "@xyflow/react";
import type { ArgDef, StageDef, NodeRunStatus } from "@zyra/core";
import { STATUS_COLORS } from "@zyra/core";

const SENSITIVE_PATTERNS = /password|secret|token|credential|auth|api.?key/i;
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
  const { stageDef, argValues, nodeLabel, runStatus, dryRunArgv, onRunNode } = data as unknown as ZyraNodeData;
  const indicator = statusIndicator[runStatus ?? "idle"];
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const { deleteElements, updateNodeData } = useReactFlow();

  const displayLabel = nodeLabel || stageDef.label;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "#16213e",
        border: selected ? "2px solid #58a6ff" : "1px solid #444",
        borderRadius: 8,
        minWidth: 180,
        width: "100%",
        height: "100%",
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        color: "#eee",
        overflow: "hidden",
      }}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={180}
        minHeight={80}
        lineStyle={{ borderColor: "#58a6ff" }}
        handleStyle={{ background: "#58a6ff", width: 8, height: 8 }}
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
              onClick={(e) => {
                e.stopPropagation();
                onRunNode(id);
              }}
              style={{
                background: "rgba(0,0,0,0.3)",
                border: "none",
                borderRadius: 3,
                color: "#3fb950",
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
              🗑
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

      {/* Ports */}
      <div style={{ padding: "8px 12px", position: "relative" }}>
        {stageDef.inputs.map((port) => (
          <div key={port.id} style={{ position: "relative", marginBottom: 4 }}>
            <Handle
              type="target"
              position={Position.Left}
              id={port.id}
              style={{
                ...handleStyle,
                top: "50%",
                background: "#58a6ff",
              }}
            />
            <span style={{ fontSize: 11, color: "#aaa", marginLeft: 8 }}>
              {port.label}
              <span style={{ fontSize: 9, color: "#666", marginLeft: 4 }}>
                [{port.types.join(", ")}]
              </span>
            </span>
          </div>
        ))}
        {stageDef.outputs.map((port) => (
          <div
            key={port.id}
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
                background: "#3fb950",
              }}
            />
            <span style={{ fontSize: 11, color: "#aaa", marginRight: 8 }}>
              <span style={{ fontSize: 9, color: "#666", marginRight: 4 }}>
                [{port.types.join(", ")}]
              </span>
              {port.label}
            </span>
          </div>
        ))}

        {/* Args summary */}
        {(() => {
          const definedKeys = new Set(stageDef.args.map((a) => a.key));
          const filled = stageDef.args.filter(
            (a) => argValues[a.key] !== undefined && argValues[a.key] !== "",
          );
          // Extra args from YAML not in the stage manifest
          const extraFilled = Object.entries(argValues)
            .filter(([k, v]) => !definedKeys.has(k) && v !== undefined && v !== "");
          const totalArgs = stageDef.args.length + extraFilled.length;
          if (totalArgs === 0) return null;
          return (
            <div
              style={{
                borderTop: "1px solid #333",
                marginTop: 6,
                paddingTop: 6,
                fontSize: 11,
                color: "#777",
              }}
            >
              {filled.length === 0 && extraFilled.length === 0 ? (
                <span>{totalArgs} arg{totalArgs !== 1 ? "s" : ""}</span>
              ) : (
                <>
                  {filled.map((a) => (
                    <ArgRow key={a.key} label={a.label} value={
                      isSensitive(a) ? "••••••••" : String(argValues[a.key])
                    } />
                  ))}
                  {extraFilled.map(([k, v]) => (
                    <ArgRow key={k} label={k} value={String(v)} />
                  ))}
                </>
              )}
            </div>
          );
        })()}

        {/* Dry-run resolved command */}
        {dryRunArgv && (
          <div
            style={{
              borderTop: "1px solid #333",
              marginTop: 6,
              paddingTop: 6,
              fontSize: 10,
              color: "#58a6ff",
              fontFamily: "monospace",
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
  );
}

function ArgRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        marginBottom: 2,
      }}
    >
      <span style={{ color: "#888", flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: "#58a6ff",
          fontFamily: "monospace",
          fontSize: 10,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
          textAlign: "right",
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

const handleStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  border: "2px solid #1a1a2e",
};
