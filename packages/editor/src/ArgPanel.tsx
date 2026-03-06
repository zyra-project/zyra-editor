import type { ArgDef, StageDef } from "@zyra/core";
import type { ZyraNodeData } from "./ZyraNode";
import { isSensitive } from "./ZyraNode";

interface Props {
  nodeId: string;
  data: ZyraNodeData;
  onArgChange: (nodeId: string, key: string, value: string | number | boolean) => void;
  onClose: () => void;
}

export function ArgPanel({ nodeId, data, onArgChange, onClose }: Props) {
  const { stageDef, argValues } = data;

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{stageDef.label}</h3>
        <button onClick={onClose} style={closeBtnStyle}>
          &times;
        </button>
      </div>
      <div style={{ fontSize: 11, color: "#888", marginBottom: stageDef.description ? 4 : 12 }}>
        {stageDef.cli}
      </div>
      {stageDef.description && (
        <div style={{ fontSize: 12, color: "#aaa", marginBottom: 12, lineHeight: 1.4 }}>
          {stageDef.description}
        </div>
      )}

      {stageDef.args.map((arg) => (
        <ArgField
          key={arg.key}
          arg={arg}
          value={argValues[arg.key]}
          onChange={(v) => onArgChange(nodeId, arg.key, v)}
        />
      ))}

      {/* Show extra args from YAML that aren't defined in the stage manifest */}
      {(() => {
        const definedKeys = new Set(stageDef.args.map((a) => a.key));
        const extraKeys = Object.keys(argValues).filter((k) => !definedKeys.has(k));
        if (extraKeys.length === 0) return null;
        return (
          <>
            {extraKeys.map((key) => (
              <ArgField
                key={key}
                arg={{
                  key,
                  label: key,
                  type: typeof argValues[key] === "number" ? "number"
                    : typeof argValues[key] === "boolean" ? "boolean"
                    : "string",
                  required: false,
                }}
                value={argValues[key]}
                onChange={(v) => onArgChange(nodeId, key, v)}
              />
            ))}
          </>
        );
      })()}
    </div>
  );
}

function ArgField({
  arg,
  value,
  onChange,
}: {
  arg: ArgDef;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}) {
  const id = `arg-${arg.key}`;

  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={id} style={labelStyle}>
        {arg.label}
        {arg.required && <span style={{ color: "#f44" }}> *</span>}
        {arg.flag && (
          <span style={{ fontSize: 10, color: "#666", marginLeft: 6 }}>
            {arg.flag}
          </span>
        )}
      </label>
      {arg.description && (
        <div style={{ fontSize: 11, color: "#666", marginBottom: 4 }}>
          {arg.description}
        </div>
      )}

      {arg.type === "enum" && arg.options ? (
        <select
          id={id}
          value={(value as string) ?? arg.default ?? ""}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        >
          <option value="" disabled>
            Select...
          </option>
          {arg.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : arg.type === "boolean" ? (
        <input
          id={id}
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : (
        <input
          id={id}
          type={isSensitive(arg) ? "password" : arg.type === "number" ? "number" : "text"}
          value={(value as string) ?? ""}
          placeholder={arg.placeholder ?? ""}
          onChange={(e) =>
            onChange(
              arg.type === "number" ? Number(e.target.value) : e.target.value,
            )
          }
          style={inputStyle}
        />
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  right: 0,
  top: 0,
  bottom: 0,
  width: 300,
  background: "#1a1a2e",
  borderLeft: "1px solid #333",
  padding: 16,
  overflowY: "auto",
  zIndex: 10,
  color: "#eee",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 4,
};

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#888",
  fontSize: 20,
  cursor: "pointer",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  background: "#0d1117",
  border: "1px solid #444",
  borderRadius: 4,
  color: "#eee",
  fontSize: 13,
  boxSizing: "border-box",
};
