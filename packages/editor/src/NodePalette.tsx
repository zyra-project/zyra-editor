import { useState } from "react";
import type { StageDef } from "@zyra/core";
import { useManifest } from "./ManifestLoader";

interface Props {
  onAddNode: (stage: StageDef) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

// Canonical stage ordering matching Zyra's composable pipeline stages
const STAGE_ORDER: string[] = [
  "control",
  "search",
  "acquire",
  "process",
  "visualize",
  "narrate",
  "verify",
  "export",
];

const STAGE_ICONS: Record<string, string> = {
  control: "\u2699",   // gear
  search: "\ud83d\udd0d",  // magnifying glass
  acquire: "\u2b07",   // down arrow
  process: "\u26a1",   // lightning
  visualize: "\ud83d\udcca", // chart
  narrate: "\ud83d\udcdd",  // memo
  verify: "\u2705",    // check
  export: "\ud83d\udce4",   // outbox
};

export function NodePalette({ onAddNode, collapsed, onToggleCollapse }: Props) {
  const manifest = useManifest();
  const [searchQuery, setSearchQuery] = useState("");

  // Group stages by their stage category
  const groups = new Map<string, StageDef[]>();
  for (const s of manifest.stages) {
    const list = groups.get(s.stage) ?? [];
    list.push(s);
    groups.set(s.stage, list);
  }

  // Sort groups by canonical stage order
  const sortedEntries = [...groups.entries()].sort(([a], [b]) => {
    const ia = STAGE_ORDER.indexOf(a);
    const ib = STAGE_ORDER.indexOf(b);
    return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  });

  // Filter by search
  const filteredEntries = searchQuery
    ? sortedEntries
        .map(([stage, defs]) => [
          stage,
          defs.filter(
            (d) =>
              d.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
              d.command.toLowerCase().includes(searchQuery.toLowerCase()),
          ),
        ] as [string, StageDef[]])
        .filter(([, defs]) => defs.length > 0)
    : sortedEntries;

  return (
    <div className="zyra-palette" style={{
      width: collapsed ? 48 : 240,
      minWidth: collapsed ? 48 : 240,
      background: "var(--bg-tertiary)",
      borderRight: "1px solid var(--border-default)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      transition: "width 0.2s ease, min-width 0.2s ease",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: collapsed ? "12px 8px" : "12px 16px",
        gap: 8,
        borderBottom: "1px solid var(--border-default)",
        minHeight: 48,
        justifyContent: collapsed ? "center" : "flex-start",
      }}>
        <button
          onClick={onToggleCollapse}
          title={collapsed ? "Expand palette" : "Collapse palette"}
          aria-label={collapsed ? "Expand palette" : "Collapse palette"}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 14,
            padding: "2px 4px",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {collapsed ? "\u00bb" : "\u00ab"}
        </button>
        {!collapsed && (
          <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
            Nodes
          </span>
        )}
      </div>

      {/* Search */}
      {!collapsed && (
        <div style={{ padding: "8px 12px" }}>
          <input
            className="zyra-input"
            type="text"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ fontSize: 12, padding: "5px 8px" }}
          />
        </div>
      )}

      {/* Node list */}
      <div style={{ flex: 1, overflowY: "auto", padding: collapsed ? "8px 4px" : "4px 12px 12px" }}>
        {collapsed ? (
          // Collapsed: show stage category icons
          sortedEntries.map(([stage]) => (
            <div
              key={stage}
              title={stage}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                margin: "0 auto 4px",
                borderRadius: "var(--radius-md)",
                fontSize: 16,
                cursor: "default",
                background: "var(--bg-node)",
              }}
            >
              {STAGE_ICONS[stage] ?? stage[0].toUpperCase()}
            </div>
          ))
        ) : (
          filteredEntries.map(([stage, defs]) => (
            <div key={stage} style={{ marginBottom: 12 }}>
              <div style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-muted)",
                marginBottom: 6,
                paddingLeft: 4,
              }}>
                {STAGE_ICONS[stage] ?? ""} {stage}
              </div>
              {defs.map((def) => (
                <button
                  key={`${def.stage}/${def.command}`}
                  onClick={() => onAddNode(def)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/zyra-stage", JSON.stringify(def));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  title={def.cli}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    width: "100%",
                    padding: "7px 10px",
                    marginBottom: 3,
                    background: "var(--bg-node)",
                    border: "none",
                    borderLeft: `3px solid ${def.color}`,
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text-primary)",
                    cursor: "grab",
                    fontSize: 12,
                    textAlign: "left",
                    fontFamily: "var(--font-sans)",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-secondary)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-node)";
                  }}
                >
                  <span>{def.label}</span>
                  {def.status !== "implemented" && (
                    <span style={{
                      fontSize: 9,
                      padding: "2px 5px",
                      borderRadius: 3,
                      background: "var(--border-default)",
                      color: "var(--text-secondary)",
                    }}>
                      {def.status}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
