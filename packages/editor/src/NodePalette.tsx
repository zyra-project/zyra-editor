import { useState, useRef, useEffect } from "react";
import type { StageDef } from "@zyra/core";
import { useManifest } from "./ManifestLoader";

interface Props {
  onAddNode: (stage: StageDef) => void;
  onAddGroup: () => void;
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

export function NodePalette({ onAddNode, onAddGroup, collapsed, onToggleCollapse }: Props) {
  const manifest = useManifest();
  const [searchQuery, setSearchQuery] = useState("");
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleGroup = (stage: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };

  // Clear hover timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

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

  // Filter by search (also matches against description)
  const filteredEntries = searchQuery
    ? sortedEntries
        .map(([stage, defs]) => [
          stage,
          defs.filter(
            (d) => {
              const q = searchQuery.toLowerCase();
              return d.label.toLowerCase().includes(q) ||
                d.command.toLowerCase().includes(q) ||
                (d.description ?? "").toLowerCase().includes(q);
            },
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
              <button
                title={stage}
                aria-label={`${stage} stages`}
                onFocus={() => {
                  if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
                  setHoveredStage(stage);
                }}
                onBlur={() => {
                  hoverTimeoutRef.current = setTimeout(() => setHoveredStage(null), 150);
                }}
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
                  border: "none",
                  padding: 0,
                  color: "inherit",
                  fontFamily: "inherit",
                }}
              >
                {STAGE_ICONS[stage] ?? stage[0].toUpperCase()}
              </button>

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
                  {defs.map((def) => {
                    const disabled = def.status !== "implemented";
                    return (
                    <button
                      key={`${def.stage}/${def.command}`}
                      onClick={disabled ? undefined : () => {
                        onAddNode(def);
                        setHoveredStage(null);
                      }}
                      draggable={!disabled}
                      onDragStart={disabled ? undefined : (e) => {
                        e.dataTransfer.setData("application/zyra-stage", JSON.stringify(def));
                        e.dataTransfer.effectAllowed = "move";
                        setHoveredStage(null);
                      }}
                      title={disabled ? `${def.label} (${def.status})` : (def.description ?? def.cli)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                        padding: "6px 8px",
                        marginBottom: 2,
                        background: "var(--bg-node)",
                        border: "none",
                        borderLeft: `3px solid ${disabled ? "var(--text-muted)" : def.color}`,
                        borderRadius: "var(--radius-sm)",
                        color: disabled ? "var(--text-muted)" : "var(--text-primary)",
                        cursor: disabled ? "default" : "grab",
                        fontSize: 12,
                        textAlign: "left",
                        fontFamily: "var(--font-sans)",
                        transition: "background 0.1s",
                        opacity: disabled ? 0.5 : 1,
                      }}
                      onMouseEnter={disabled ? undefined : (e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-secondary)";
                      }}
                      onMouseLeave={disabled ? undefined : (e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-node)";
                      }}
                    >
                      <span>{def.label}</span>
                      {disabled && (
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
                    );
                  })}
                </div>
              )}
            </div>
          ))
        ) : (
          filteredEntries.map(([stage, defs]) => {
            const isGroupCollapsed = !searchQuery && collapsedGroups.has(stage);
            return (
            <div key={stage} style={{ marginBottom: 12 }}>
              <button
                onClick={() => toggleGroup(stage)}
                aria-expanded={!isGroupCollapsed}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  width: "100%",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                  marginBottom: isGroupCollapsed ? 0 : 6,
                  paddingLeft: 4,
                  paddingTop: 0,
                  paddingBottom: 0,
                  paddingRight: 0,
                  fontFamily: "var(--font-sans)",
                }}
              >
                <span style={{
                  display: "inline-block",
                  fontSize: 8,
                  transition: "transform 0.15s ease",
                  transform: isGroupCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                }}>
                  ▼
                </span>
                {STAGE_ICONS[stage] ?? ""} {stage}
                <span style={{
                  marginLeft: "auto",
                  fontSize: 9,
                  color: "var(--text-muted)",
                  opacity: 0.7,
                }}>
                  {defs.length}
                </span>
              </button>
              {!isGroupCollapsed && defs.map((def) => {
                const disabled = def.status !== "implemented";
                return (
                <button
                  key={`${def.stage}/${def.command}`}
                  onClick={disabled ? undefined : () => onAddNode(def)}
                  draggable={!disabled}
                  onDragStart={disabled ? undefined : (e) => {
                    e.dataTransfer.setData("application/zyra-stage", JSON.stringify(def));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  title={disabled ? `${def.label} (${def.status})` : (def.description ?? def.cli)}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    flexDirection: "column",
                    width: "100%",
                    padding: "7px 10px",
                    marginBottom: 3,
                    background: "var(--bg-node)",
                    border: "none",
                    borderLeft: `3px solid ${disabled ? "var(--text-muted)" : def.color}`,
                    borderRadius: "var(--radius-sm)",
                    color: disabled ? "var(--text-muted)" : "var(--text-primary)",
                    cursor: disabled ? "default" : "grab",
                    fontSize: 12,
                    textAlign: "left",
                    fontFamily: "var(--font-sans)",
                    transition: "background 0.1s",
                    opacity: disabled ? 0.5 : 1,
                  }}
                  onMouseEnter={disabled ? undefined : (e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-secondary)";
                  }}
                  onMouseLeave={disabled ? undefined : (e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-node)";
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
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
                  </div>
                  {def.description && (
                    <div style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      marginTop: 2,
                      lineHeight: 1.3,
                    }}>
                      {def.description}
                    </div>
                  )}
                </button>
                );
              })}
            </div>
            );
          })
        )}
      </div>

      {/* Add Group button */}
      <div style={{
        padding: collapsed ? "8px 4px" : "8px 12px",
        borderTop: "1px solid var(--border-default)",
      }}>
        <button
          onClick={onAddGroup}
          title="Add a group box to organize nodes"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "flex-start",
            gap: 6,
            width: "100%",
            padding: collapsed ? "8px 0" : "7px 10px",
            background: "var(--bg-node)",
            border: "1px dashed var(--border-default)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "var(--font-sans)",
            transition: "background 0.1s, color 0.1s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-secondary)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-node)";
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          <span style={{ fontSize: 14 }}>+</span>
          {!collapsed && <span>Group</span>}
        </button>
      </div>
    </div>
  );
}
