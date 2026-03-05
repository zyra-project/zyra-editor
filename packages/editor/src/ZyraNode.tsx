import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StageDef } from "@zyra/core";

export interface ZyraNodeData {
  stageDef: StageDef;
  argValues: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export function ZyraNode({ data, selected }: NodeProps) {
  const { stageDef } = data as unknown as ZyraNodeData;

  return (
    <div
      style={{
        background: "#16213e",
        border: selected ? "2px solid #58a6ff" : "1px solid #444",
        borderRadius: 8,
        minWidth: 180,
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        color: "#eee",
      }}
    >
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
        <span>{stageDef.label}</span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>{stageDef.stage}</span>
      </div>

      {/* Ports */}
      <div style={{ padding: "8px 12px", position: "relative" }}>
        {stageDef.inputs.map((port, i) => (
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
        {stageDef.outputs.map((port, i) => (
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
        {stageDef.args.length > 0 && (
          <div
            style={{
              borderTop: "1px solid #333",
              marginTop: 6,
              paddingTop: 6,
              fontSize: 11,
              color: "#777",
            }}
          >
            {stageDef.args.length} arg{stageDef.args.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

const handleStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  border: "2px solid #1a1a2e",
};
