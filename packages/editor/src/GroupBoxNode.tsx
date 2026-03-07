import { useState } from "react";
import { NodeResizer, useReactFlow, type NodeProps } from "@xyflow/react";

export interface GroupBoxData {
  label: string;
  description?: string;
  color: string;
  locked?: boolean;
  [key: string]: unknown;
}

/** Convert a 6-digit hex color to rgba with the given alpha (0-1). */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const PRESET_COLORS = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#6b7280", // gray
];

export function GroupBoxNode({ id, data, selected }: NodeProps) {
  const { label, description, color, locked } = data as unknown as GroupBoxData;
  const { deleteElements, updateNodeData } = useReactFlow();
  const [editingLabel, setEditingLabel] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [hovered, setHovered] = useState(false);
  const [showColors, setShowColors] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setShowColors(false); }}
      style={{
        width: "100%",
        height: "100%",
        background: hexToRgba(color, 0.06),
        border: selected
          ? `2px ${locked ? "solid" : "dashed"} ${color}`
          : `1px ${locked ? "solid" : "dashed"} ${hexToRgba(color, 0.53)}`,
        borderRadius: "var(--radius-lg)",
        fontFamily: "var(--font-sans)",
        position: "relative",
        overflow: "visible",
      }}
    >
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={120}
        lineStyle={{ borderColor: color }}
        handleStyle={{ background: color, width: 8, height: 8 }}
      />

      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderBottom: `1px dashed ${hexToRgba(color, 0.27)}`,
        }}
      >
        {/* Color dot / picker toggle */}
        <div style={{ position: "relative" }}>
          <span
            onClick={() => setShowColors((v) => !v)}
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: color,
              cursor: "pointer",
              flexShrink: 0,
              border: "2px solid var(--border-default)",
            }}
            title="Change color"
          />
          {showColors && (
            <div
              style={{
                position: "absolute",
                top: 20,
                left: 0,
                zIndex: 100,
                display: "flex",
                gap: 4,
                padding: 6,
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                boxShadow: "0 4px 12px var(--node-shadow)",
              }}
            >
              {PRESET_COLORS.map((c) => (
                <span
                  key={c}
                  onClick={() => {
                    updateNodeData(id, { color: c });
                    setShowColors(false);
                  }}
                  style={{
                    display: "inline-block",
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: c,
                    cursor: "pointer",
                    border: c === color ? "2px solid #fff" : "2px solid transparent",
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Label */}
        {editingLabel ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => {
              const trimmed = editValue.trim();
              if (trimmed) updateNodeData(id, { label: trimmed });
              setEditingLabel(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingLabel(false);
            }}
            style={{
              background: "var(--bg-overlay)",
              border: `1px solid ${color}`,
              borderRadius: 3,
              color: "var(--text-bright)",
              fontSize: 13,
              fontWeight: 600,
              padding: "1px 6px",
              outline: "none",
              flex: 1,
              fontFamily: "inherit",
            }}
          />
        ) : (
          <span
            onDoubleClick={() => {
              setEditValue(label);
              setEditingLabel(true);
            }}
            title="Double-click to rename"
            style={{
              color,
              fontSize: 13,
              fontWeight: 600,
              cursor: "text",
              flex: 1,
            }}
          >
            {label}
          </span>
        )}

        {/* Lock toggle */}
        <button
          title={locked ? "Unlock group" : "Lock group in place"}
          onClick={(e) => {
            e.stopPropagation();
            updateNodeData(id, { locked: !locked });
          }}
          style={{
            background: locked ? hexToRgba(color, 0.2) : "var(--bg-overlay)",
            border: "none",
            borderRadius: 3,
            color: locked ? color : "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            lineHeight: 1,
            padding: "2px 5px",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          {locked ? "\u{1F512}" : "\u{1F513}"}
        </button>

        {/* Delete button */}
        {hovered && (
          <button
            title="Delete group"
            onClick={(e) => {
              e.stopPropagation();
              deleteElements({ nodes: [{ id }] });
            }}
            style={{
              background: "var(--bg-overlay)",
              border: "none",
              borderRadius: 3,
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              padding: "2px 5px",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            &times;
          </button>
        )}
      </div>

      {/* Description area */}
      <div style={{ padding: "4px 10px" }}>
        {editingDesc ? (
          <textarea
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => {
              updateNodeData(id, { description: editValue.trim() || undefined });
              setEditingDesc(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingDesc(false);
            }}
            style={{
              background: "var(--bg-tertiary)",
              border: `1px solid ${hexToRgba(color, 0.27)}`,
              borderRadius: 3,
              color: "var(--text-secondary)",
              fontSize: 11,
              padding: "4px 6px",
              outline: "none",
              width: "100%",
              minHeight: 36,
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
        ) : (
          <span
            onDoubleClick={() => {
              setEditValue(description || "");
              setEditingDesc(true);
            }}
            title="Double-click to add description"
            style={{
              color: "var(--text-muted)",
              fontSize: 11,
              cursor: "text",
              fontStyle: description ? "normal" : "italic",
              opacity: description ? 1 : 0.6,
            }}
          >
            {description || (hovered ? "Double-click to add description" : "")}
          </span>
        )}
      </div>
    </div>
  );
}
