import type { StageDef } from "@zyra/core";
import { useManifest } from "./ManifestLoader";

interface Props {
  onAddNode: (stage: StageDef) => void;
}

export function NodePalette({ onAddNode }: Props) {
  const manifest = useManifest();

  // Group stages by their stage category
  const groups = new Map<string, StageDef[]>();
  for (const s of manifest.stages) {
    const list = groups.get(s.stage) ?? [];
    list.push(s);
    groups.set(s.stage, list);
  }

  return (
    <div style={panelStyle}>
      <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>
        Node Palette
      </h3>
      {[...groups.entries()].map(([stage, defs]) => (
        <div key={stage} style={{ marginBottom: 12 }}>
          <div style={groupLabelStyle}>{stage}</div>
          {defs.map((def) => (
            <button
              key={`${def.stage}/${def.command}`}
              style={{ ...nodeButtonStyle, borderLeftColor: def.color }}
              onClick={() => onAddNode(def)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/zyra-stage",
                  JSON.stringify(def),
                );
                e.dataTransfer.effectAllowed = "move";
              }}
              title={def.cli}
            >
              <span>{def.label}</span>
              {def.status !== "implemented" && (
                <span style={badgeStyle}>{def.status}</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: 220,
  minWidth: 220,
  background: "#1a1a2e",
  borderRight: "1px solid #333",
  padding: 16,
  overflowY: "auto",
  color: "#eee",
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "#888",
  marginBottom: 6,
};

const nodeButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  padding: "8px 10px",
  marginBottom: 4,
  background: "#16213e",
  border: "none",
  borderLeft: "3px solid",
  borderRadius: 4,
  color: "#ddd",
  cursor: "grab",
  fontSize: 13,
  textAlign: "left",
};

const badgeStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "2px 5px",
  borderRadius: 3,
  background: "#555",
  color: "#ccc",
};
