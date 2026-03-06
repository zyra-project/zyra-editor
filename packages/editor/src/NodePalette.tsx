import { useState, useRef } from "react";
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
  "decide",
  "simulate",
  "visualize",
  "narrate",
  "verify",
  "export",
];

const STAGE_ICONS: Record<string, string> = {
  control: "\u2699",         // gear
  search: "\ud83d\udd0d",   // magnifying glass
  acquire: "\u2b07",         // down arrow
  process: "\u26a1",         // lightning
  visualize: "\ud83d\udcca", // chart
  narrate: "\ud83d\udcdd",   // memo
  verify: "\u2705",          // check
  export: "\ud83d\udce4",    // outbox
  download: "\ud83d\udce5",  // inbox tray
  report: "\ud83d\udcc4",    // page facing up
  summarize: "\ud83d\udcac", // speech bubble
  transform: "\ud83d\udd00", // shuffle
  filter: "\ud83d\udcd0",    // triangular ruler
  merge: "\ud83d\udd17",     // link
  split: "\u2702",           // scissors
  validate: "\ud83d\udee1",  // shield
  analyze: "\ud83e\udde0",   // brain
  upload: "\u2b06",          // up arrow
  convert: "\ud83d\udd04",   // cycle
  clean: "\ud83e\uddf9",     // broom
  ingest: "\ud83d\udce8",    // incoming envelope
  publish: "\ud83d\udce2",   // loudspeaker
  decide: "\ud83c\udfaf",   // bullseye / target
  simulate: "\ud83c\udfb2", // dice
};

export function NodePalette({ onAddNode, collapsed, onToggleCollapse }: Props) {
  const manifest = useManifest();
  const [searchQuery, setSearchQuery] = useState("");
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      overflow: collapsed ? "visible" : "hidden",
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
      <div style={{ flex: 1, overflowY: collapsed ? "visible" : "auto", padding: collapsed ? "8px 4px" : "4px 12px 12px" }}>
        {collapsed ? (
          // Collapsed: show stage category icons with hover popout
          sortedEntries.map(([stage, defs]) => (
            <div
              key={stage}
              style={{ position: "relative" }}
              onMouseEnter={() => {
                if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                setHoveredStage(stage);
              }}
              onMouseLeave={() => {
                hoverTimeoutRef.current = setTimeout(() => setHoveredStage(null), 150);
              }}
            >
              <div
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
                  cursor: "pointer",
                  background: hoveredStage === stage ? "var(--bg-secondary)" : "var(--bg-node)",
                  transition: "background 0.1s",
                }}
              >
                {STAGE_ICONS[stage] ?? stage[0].toUpperCase()}
              </div>

              {/* Popout menu */}
              {hoveredStage === stage && (
                <div
                  style={{
                    position: "absolute",
                    left: 44,
                    top: 0,
                    zIndex: 200,
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--radius-md)",
                    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                    padding: "6px",
                    minWidth: 180,
                    maxWidth: 240,
                  }}
                >
                  <div style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "var(--text-muted)",
                    marginBottom: 4,
                    paddingLeft: 6,
                  }}>
                    {STAGE_ICONS[stage] ?? ""} {stage}
                  </div>
                  {defs.map((def) => (
                    <button
                      key={`${def.stage}/${def.command}`}
                      onClick={() => {
                        onAddNode(def);
                        setHoveredStage(null);
                      }}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/zyra-stage", JSON.stringify(def));
                        e.dataTransfer.effectAllowed = "move";
                        setHoveredStage(null);
                      }}
                      title={def.cli}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                        padding: "6px 8px",
                        marginBottom: 2,
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
              )}
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
