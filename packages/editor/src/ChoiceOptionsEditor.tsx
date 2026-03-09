import { useState, useRef, useCallback } from "react";

/** A single choice option with an optional human-readable label. */
interface ChoiceOption {
  label: string;
  value: string;
}

/**
 * Parse the serialized options string into label/value pairs.
 * Format: comma-separated entries, each either `label=value` or just `value`.
 */
function parseOptions(raw: string): ChoiceOption[] {
  if (!raw) return [];
  return raw.split(",").map((s) => {
    const trimmed = s.trim();
    if (!trimmed) return null;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const label = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      return { label: label || value, value: value || label };
    }
    return { label: trimmed, value: trimmed };
  }).filter((o): o is ChoiceOption => o !== null);
}

/** Serialize label/value pairs back to the comma-separated format. */
function serializeOptions(opts: ChoiceOption[]): string {
  return opts.map((o) => o.label === o.value ? o.value : `${o.label}=${o.value}`).join(",");
}

/**
 * Visual editor for the Choice node's options list.
 * Each option has an optional label (human-readable) and a value (machine-readable).
 * Format: "label=value" per entry, comma-separated. If label equals value, just "value".
 */
export function ChoiceOptionsEditor({
  value,
  onChange,
  selected,
  onSelectChange,
}: {
  /** Comma-separated options string (label=value or just value) */
  value: string;
  onChange: (csv: string) => void;
  /** Currently selected value */
  selected: string;
  onSelectChange: (v: string) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editValue, setEditValue] = useState("");
  const addLabelRef = useRef<HTMLInputElement>(null);
  const addValueRef = useRef<HTMLInputElement>(null);

  const options = parseOptions(value);

  const commit = useCallback(
    (opts: ChoiceOption[]) => {
      onChange(serializeOptions(opts));
      // If the selected value was removed, clear it
      if (selected && !opts.some((o) => o.value === selected)) {
        onSelectChange("");
      }
    },
    [onChange, selected, onSelectChange],
  );

  const removeOption = (index: number) => {
    const next = [...options];
    next.splice(index, 1);
    commit(next);
  };

  const startEditing = (index: number) => {
    setEditLabel(options[index].label);
    setEditValue(options[index].value);
    setEditingIndex(index);
  };

  const commitEdit = (index: number) => {
    const trimLabel = editLabel.trim();
    const trimValue = editValue.trim();
    if (!trimValue && !trimLabel) {
      removeOption(index);
      setEditingIndex(null);
      return;
    }
    const finalValue = trimValue || trimLabel;
    const finalLabel = trimLabel || trimValue;
    const next = [...options];
    // If the selected value was this option, update it
    if (selected === next[index].value) {
      onSelectChange(finalValue);
    }
    next[index] = { label: finalLabel, value: finalValue };
    commit(next);
    setEditingIndex(null);
  };

  const addOption = () => {
    const trimLabel = addLabelRef.current?.value.trim() ?? "";
    const trimValue = addValueRef.current?.value.trim() ?? "";
    if (!trimValue && !trimLabel) return;
    const finalValue = trimValue || trimLabel;
    const finalLabel = trimLabel || trimValue;
    // Avoid duplicate values
    if (options.some((o) => o.value === finalValue)) return;
    commit([...options, { label: finalLabel, value: finalValue }]);
    if (addLabelRef.current) addLabelRef.current.value = "";
    if (addValueRef.current) addValueRef.current.value = "";
    addLabelRef.current?.focus();
  };

  const isSelected = (opt: ChoiceOption) => selected === opt.value;

  return (
    <div>
      {/* Column headers */}
      {options.length > 0 && (
        <div style={{
          display: "flex",
          gap: 6,
          marginBottom: 4,
          paddingLeft: 26, // align with content after radio
          paddingRight: 24, // space for x button
          fontSize: 10,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}>
          <span style={{ flex: 1 }}>Label</span>
          <span style={{ flex: 1 }}>Value</span>
        </div>
      )}

      {/* Option rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
        {options.map((opt, i) => {
          const sel = isSelected(opt);
          const hasLabel = opt.label !== opt.value;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: sel ? "var(--accent-blue)" : "var(--bg-primary)",
                color: sel ? "#fff" : "var(--text-primary)",
                borderRadius: "var(--radius-sm)",
                padding: "4px 8px",
                fontSize: 12,
                border: `1px solid ${sel ? "var(--accent-blue)" : "var(--border-default)"}`,
                cursor: "pointer",
                minHeight: 28,
              }}
            >
              {editingIndex === i ? (
                <div style={{ display: "flex", gap: 4, flex: 1, alignItems: "center" }}>
                  <input
                    className="zyra-input"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    placeholder="Label"
                    autoFocus
                    style={{
                      flex: 1,
                      fontSize: 12,
                      padding: "2px 4px",
                      minWidth: 0,
                      background: "var(--bg-secondary)",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(i);
                      if (e.key === "Escape") setEditingIndex(null);
                    }}
                  />
                  <input
                    className="zyra-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    placeholder="Value"
                    style={{
                      flex: 1,
                      fontSize: 12,
                      padding: "2px 4px",
                      minWidth: 0,
                      background: "var(--bg-secondary)",
                      fontFamily: "var(--font-mono)",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(i);
                      if (e.key === "Escape") setEditingIndex(null);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => commitEdit(i)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--accent-blue)",
                      cursor: "pointer",
                      fontSize: 12,
                      padding: "0 4px",
                      flexShrink: 0,
                    }}
                  >
                    &#10003;
                  </button>
                </div>
              ) : (
                <>
                  {/* Select radio */}
                  <span
                    onClick={() => onSelectChange(opt.value)}
                    title="Select this option"
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      border: `2px solid ${sel ? "#fff" : "var(--text-muted)"}`,
                      background: sel ? "#fff" : "transparent",
                      flexShrink: 0,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {sel && (
                      <span style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--accent-blue)",
                      }} />
                    )}
                  </span>

                  {/* Label + value display — click to edit */}
                  <span
                    onClick={() => startEditing(i)}
                    title="Click to edit"
                    style={{
                      flex: 1,
                      display: "flex",
                      gap: 6,
                      alignItems: "baseline",
                      overflow: "hidden",
                      cursor: "text",
                    }}
                  >
                    <span style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {opt.label}
                    </span>
                    {hasLabel && (
                      <span style={{
                        flex: 1,
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        color: sel ? "rgba(255,255,255,0.7)" : "var(--text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {opt.value}
                      </span>
                    )}
                  </span>

                  {/* Remove button */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeOption(i);
                    }}
                    title="Remove option"
                    style={{
                      background: "none",
                      border: "none",
                      color: sel ? "rgba(255,255,255,0.7)" : "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 14,
                      lineHeight: 1,
                      padding: "0 2px",
                      flexShrink: 0,
                    }}
                  >
                    &times;
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Add new option row */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          ref={addLabelRef}
          className="zyra-input"
          placeholder="Label"
          style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // If value field is empty, focus it first
              if (!addValueRef.current?.value.trim()) {
                addValueRef.current?.focus();
              } else {
                addOption();
              }
            }
          }}
        />
        <input
          ref={addValueRef}
          className="zyra-input"
          placeholder="Value"
          style={{ flex: 1, fontSize: 12, padding: "4px 8px", fontFamily: "var(--font-mono)" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") addOption();
          }}
        />
        <button
          type="button"
          onClick={addOption}
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            borderRadius: "var(--radius-sm)",
            padding: "4px 10px",
            fontSize: 12,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

/** Export for use in ZyraNode canvas preview. */
export { parseOptions };
