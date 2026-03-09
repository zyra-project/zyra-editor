import { useState, useRef, useCallback } from "react";

/**
 * Visual editor for the Choice node's options list.
 * Renders each option as an individual editable chip/row with add/remove controls.
 * The underlying value is still a comma-separated string for serialization.
 */
export function ChoiceOptionsEditor({
  value,
  onChange,
  selected,
  onSelectChange,
}: {
  /** Comma-separated options string */
  value: string;
  onChange: (csv: string) => void;
  /** Currently selected value */
  selected: string;
  onSelectChange: (v: string) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const options = value
    ? value.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const commit = useCallback(
    (opts: string[]) => {
      onChange(opts.join(","));
      // If the selected value was removed, clear it
      if (selected && !opts.includes(selected)) {
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

  const updateOption = (index: number, newVal: string) => {
    const trimmed = newVal.trim();
    if (!trimmed) {
      removeOption(index);
      return;
    }
    const next = [...options];
    // If the selected value was this option, update it
    if (selected === next[index]) {
      onSelectChange(trimmed);
    }
    next[index] = trimmed;
    commit(next);
    setEditingIndex(null);
  };

  const addOption = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    // Avoid duplicates
    if (options.includes(trimmed)) return;
    commit([...options, trimmed]);
    if (addRef.current) addRef.current.value = "";
  };

  return (
    <div>
      {/* Option chips */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
        {options.map((opt, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: selected === opt ? "var(--accent-blue)" : "var(--bg-primary)",
              color: selected === opt ? "#fff" : "var(--text-primary)",
              borderRadius: "var(--radius-sm)",
              padding: "4px 8px",
              fontSize: 12,
              border: `1px solid ${selected === opt ? "var(--accent-blue)" : "var(--border-default)"}`,
              cursor: "pointer",
              minHeight: 28,
            }}
          >
            {editingIndex === i ? (
              <input
                ref={inputRef}
                className="zyra-input"
                defaultValue={opt}
                autoFocus
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: "2px 4px",
                  minWidth: 0,
                  background: "var(--bg-secondary)",
                }}
                onBlur={(e) => updateOption(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") updateOption(i, e.currentTarget.value);
                  if (e.key === "Escape") setEditingIndex(null);
                }}
              />
            ) : (
              <>
                {/* Select radio */}
                <span
                  onClick={() => onSelectChange(opt)}
                  title="Select this option"
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: `2px solid ${selected === opt ? "#fff" : "var(--text-muted)"}`,
                    background: selected === opt ? "#fff" : "transparent",
                    flexShrink: 0,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selected === opt && (
                    <span style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--accent-blue)",
                    }} />
                  )}
                </span>

                {/* Label — click to edit */}
                <span
                  onClick={() => setEditingIndex(i)}
                  title="Click to edit"
                  style={{
                    flex: 1,
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    cursor: "text",
                  }}
                >
                  {opt}
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
                    color: selected === opt ? "rgba(255,255,255,0.7)" : "var(--text-muted)",
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
        ))}
      </div>

      {/* Add new option row */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          ref={addRef}
          className="zyra-input"
          placeholder="New option..."
          style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              addOption(e.currentTarget.value);
            }
          }}
        />
        <button
          type="button"
          onClick={() => {
            if (addRef.current) addOption(addRef.current.value);
          }}
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
