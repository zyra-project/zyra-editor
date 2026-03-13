import { useState, useCallback } from "react";
import type { PipelineResource } from "@zyra/core";
import { validateResources } from "@zyra/core";

interface ResourcePanelProps {
  resources: PipelineResource[];
  onChange: (resources: PipelineResource[]) => void;
  onClose: () => void;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function ResourcePanel({ resources, onChange, onClose }: ResourcePanelProps) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const errors = validateResources(resources);
  const errorNames = new Set(errors.map((e) => e.name));
  const errorMessages = new Map(errors.map((e) => [e.name, e.message]));

  const handleAdd = useCallback(() => {
    const base = "new_resource";
    let name = base;
    let i = 1;
    const existing = new Set(resources.map((r) => r.name));
    while (existing.has(name)) name = `${base}_${i++}`;
    onChange([...resources, { name, value: "" }]);
    setEditingIdx(resources.length);
  }, [resources, onChange]);

  const handleRemove = useCallback(
    (idx: number) => {
      onChange(resources.filter((_, i) => i !== idx));
      if (editingIdx === idx) setEditingIdx(null);
    },
    [resources, onChange, editingIdx],
  );

  const handleChange = useCallback(
    (idx: number, field: "name" | "value" | "description", val: string) => {
      onChange(
        resources.map((r, i) =>
          i === idx
            ? { ...r, [field]: field === "description" && !val ? undefined : val }
            : r,
        ),
      );
    },
    [resources, onChange],
  );

  return (
    <div
      style={{
        position: "fixed",
        top: 48,
        right: 0,
        bottom: 0,
        width: 380,
        zIndex: 40,
        background: "var(--bg-primary)",
        borderLeft: "1px solid var(--border-default)",
        boxShadow: "-4px 0 16px var(--node-shadow)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-default)",
          background: "var(--bg-secondary)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text-bright)" }}>
          Pipeline Resources
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: "0 4px",
            lineHeight: 1,
          }}
        >
          &times;
        </button>
      </div>

      {/* Description */}
      <div
        style={{
          padding: "10px 16px",
          color: "var(--text-muted)",
          fontSize: 11,
          lineHeight: 1.5,
          borderBottom: "1px solid var(--border-default)",
          flexShrink: 0,
        }}
      >
        Define named values referenced in node args via{" "}
        <code style={{ background: "var(--bg-tertiary)", padding: "1px 4px", borderRadius: 3 }}>
          {"${res:name}"}
        </code>
        . Change once here, updates everywhere.
      </div>

      {/* Resource list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {resources.length === 0 && (
          <div
            style={{
              padding: "24px 12px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 12,
            }}
          >
            No resources defined.
            <br />
            Click "Add Resource" to create one.
          </div>
        )}

        {resources.map((r, idx) => {
          const hasError = errorNames.has(r.name);
          const isEditing = editingIdx === idx;

          return (
            <div
              key={idx}
              style={{
                marginBottom: 8,
                padding: "10px 12px",
                background: "var(--bg-secondary)",
                border: `1px solid ${hasError ? "var(--accent-red)" : "var(--border-default)"}`,
                borderRadius: "var(--radius-md)",
              }}
            >
              {/* Header row: name + actions */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 6,
                }}
              >
                <input
                  value={r.name}
                  onChange={(e) => handleChange(idx, "name", e.target.value)}
                  onFocus={() => setEditingIdx(idx)}
                  placeholder="resource_name"
                  spellCheck={false}
                  style={{
                    flex: 1,
                    background: "var(--bg-primary)",
                    border: `1px solid ${!NAME_RE.test(r.name) ? "var(--accent-red)" : "var(--border-default)"}`,
                    borderRadius: 4,
                    padding: "4px 8px",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    color: "var(--text-bright)",
                    outline: "none",
                  }}
                />
                <button
                  onClick={() => handleRemove(idx)}
                  title="Remove resource"
                  aria-label={`Remove ${r.name}`}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 14,
                    padding: "0 2px",
                    lineHeight: 1,
                  }}
                >
                  &times;
                </button>
              </div>

              {/* Value */}
              <input
                value={r.value}
                onChange={(e) => handleChange(idx, "value", e.target.value)}
                onFocus={() => setEditingIdx(idx)}
                placeholder="value (e.g. /data/output, s3://bucket)"
                spellCheck={false}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-primary)",
                  outline: "none",
                  marginBottom: isEditing ? 6 : 0,
                }}
              />

              {/* Description (only when editing) */}
              {isEditing && (
                <input
                  value={r.description ?? ""}
                  onChange={(e) => handleChange(idx, "description", e.target.value)}
                  placeholder="Description (optional)"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 4,
                    padding: "4px 8px",
                    fontSize: 11,
                    fontFamily: "var(--font-sans)",
                    color: "var(--text-secondary)",
                    outline: "none",
                  }}
                />
              )}

              {/* Usage hint */}
              <div
                style={{
                  marginTop: 4,
                  fontSize: 10,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {"${res:" + r.name + "}"}
              </div>

              {/* Validation error */}
              {hasError && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 10,
                    color: "var(--accent-red)",
                  }}
                >
                  {errorMessages.get(r.name)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--border-default)",
          flexShrink: 0,
          display: "flex",
          gap: 8,
        }}
      >
        <button
          className="zyra-btn zyra-btn--primary"
          onClick={handleAdd}
          style={{ fontSize: 12, flex: 1 }}
        >
          + Add Resource
        </button>
      </div>
    </div>
  );
}
