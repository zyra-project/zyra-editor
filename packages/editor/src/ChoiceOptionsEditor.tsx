import { useState, useRef, useCallback } from "react";

/** A single choice option with a human-readable label and a machine value. */
export interface ChoiceOption {
  label: string;
  value: string;
}

/** Parse the JSON options string. Returns [] on invalid/empty input. */
export function parseOptions(raw: string): ChoiceOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is ChoiceOption =>
        o !== null && typeof o === "object" && typeof o.value === "string",
    ).map((o) => ({
      label: typeof o.label === "string" && o.label ? o.label : o.value,
      value: o.value,
    }));
  } catch {
    return [];
  }
}

/** Serialize options to JSON. Omits label when it matches value. */
function serializeOptions(opts: ChoiceOption[]): string {
  return JSON.stringify(
    opts.map((o) =>
      o.label === o.value ? { value: o.value } : { label: o.label, value: o.value },
    ),
  );
}

/**
 * Visual editor for the Choice node's options list.
 * Each option has a label (human-readable) and a value (machine-readable).
 * Stored as a JSON array of {label?, value} objects.
 */
export function ChoiceOptionsEditor({
  value,
  onChange,
  selected,
  onSelectChange,
}: {
  /** JSON-encoded options array */
  value: string;
  onChange: (json: string) => void;
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
    const finalLabel = trimLabel || finalValue;
    const next = [...options];
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
    const finalLabel = trimLabel || finalValue;
    if (options.some((o) => o.value === finalValue)) return;
    commit([...options, { label: finalLabel, value: finalValue }]);
    if (addLabelRef.current) addLabelRef.current.value = "";
    if (addValueRef.current) addValueRef.current.value = "";
    addLabelRef.current?.focus();
  };

  return (
    <div>
      {/* Column headers */}
      {options.length > 0 && (
        <div style={{
          display: "flex",
          gap: 6,
          marginBottom: 4,
          paddingLeft: 26,
          paddingRight: 24,
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
      <div role="radiogroup" aria-label="Choice options" style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
        {options.map((opt, i) => {
          const sel = selected === opt.value;
          const hasDistinctLabel = opt.label !== opt.value;
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
                      flex: 1, fontSize: 12, padding: "2px 4px",
                      minWidth: 0, background: "var(--bg-secondary)",
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
                      flex: 1, fontSize: 12, padding: "2px 4px",
                      minWidth: 0, background: "var(--bg-secondary)",
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
                      background: "none", border: "none",
                      color: "var(--accent-blue)", cursor: "pointer",
                      fontSize: 12, padding: "0 4px", flexShrink: 0,
                    }}
                  >
                    &#10003;
                  </button>
                </div>
              ) : (
                <>
                  {/* Select radio */}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    aria-label={`Select ${opt.label}`}
                    onClick={() => onSelectChange(opt.value)}
                    title="Select this option"
                    style={{
                      width: 14, height: 14, borderRadius: "50%",
                      border: `2px solid ${sel ? "#fff" : "var(--text-muted)"}`,
                      background: sel ? "#fff" : "transparent",
                      flexShrink: 0, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      padding: 0,
                    }}
                  >
                    {sel && (
                      <span style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: "var(--accent-blue)",
                      }} />
                    )}
                  </button>

                  {/* Label + value display */}
                  <button
                    type="button"
                    onClick={() => startEditing(i)}
                    title="Click to edit"
                    aria-label={`Edit option ${opt.label}`}
                    style={{
                      flex: 1, display: "flex", gap: 6,
                      alignItems: "baseline", overflow: "hidden", cursor: "text",
                      background: "none", border: "none", padding: 0,
                      color: "inherit", font: "inherit", textAlign: "left",
                    }}
                  >
                    <span style={{
                      flex: 1, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {opt.label}
                    </span>
                    {hasDistinctLabel && (
                      <span style={{
                        flex: 1, fontFamily: "var(--font-mono)", fontSize: 10,
                        color: sel ? "rgba(255,255,255,0.7)" : "var(--text-muted)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {opt.value}
                      </span>
                    )}
                  </button>

                  {/* Remove */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeOption(i); }}
                    title="Remove option"
                    style={{
                      background: "none", border: "none",
                      color: sel ? "rgba(255,255,255,0.7)" : "var(--text-muted)",
                      cursor: "pointer", fontSize: 14, lineHeight: 1,
                      padding: "0 2px", flexShrink: 0,
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

      {/* Add new option */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          ref={addLabelRef}
          className="zyra-input"
          placeholder="Label"
          style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
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
            padding: "4px 10px", fontSize: 12,
            cursor: "pointer", flexShrink: 0,
          }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}
