import { useState, useMemo } from "react";

/* ── Cron presets ───────────────────────────────────────────────── */

interface CronPreset {
  label: string;
  expression: string;
  description: string;
}

const PRESETS: CronPreset[] = [
  { label: "Every hour",        expression: "0 * * * *",     description: "Runs at the top of every hour" },
  { label: "Every 6 hours",     expression: "0 */6 * * *",   description: "Runs every 6 hours at :00" },
  { label: "Daily at midnight", expression: "0 0 * * *",     description: "Runs once daily at 00:00" },
  { label: "Daily at 6 AM",     expression: "0 6 * * *",     description: "Runs once daily at 06:00" },
  { label: "Weekly on Monday",  expression: "0 6 * * MON",   description: "Runs every Monday at 06:00" },
  { label: "Weekdays at 6 AM",  expression: "0 6 * * MON-FRI", description: "Runs Mon–Fri at 06:00" },
  { label: "Monthly (1st)",     expression: "0 0 1 * *",     description: "Runs on the 1st of each month at 00:00" },
  { label: "Quarterly (Jan/Apr/Jul/Oct)", expression: "0 0 1 1,4,7,10 *", description: "Runs on the 1st of each quarter" },
];

/* ── Human-readable cron description ───────────────────────────── */

const WEEKDAY_NAMES: Record<string, string> = {
  "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday",
  "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday",
  SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday",
  THU: "Thursday", FRI: "Friday", SAT: "Saturday",
};

const MONTH_NAMES: Record<string, string> = {
  "1": "January", "2": "February", "3": "March", "4": "April",
  "5": "May", "6": "June", "7": "July", "8": "August",
  "9": "September", "10": "October", "11": "November", "12": "December",
  JAN: "January", FEB: "February", MAR: "March", APR: "April",
  MAY: "May", JUN: "June", JUL: "July", AUG: "August",
  SEP: "September", OCT: "October", NOV: "November", DEC: "December",
};

function describeField(
  value: string,
  allLabel: string,
  nameMap?: Record<string, string>,
): string {
  if (value === "*") return allLabel;

  // Step: */n
  const stepMatch = value.match(/^\*\/(\d+)$/);
  if (stepMatch) return `every ${stepMatch[1]}`;

  // Range: a-b
  const rangeMatch = value.match(/^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/);
  if (rangeMatch) {
    const from = nameMap?.[rangeMatch[1].toUpperCase()] ?? rangeMatch[1];
    const to = nameMap?.[rangeMatch[2].toUpperCase()] ?? rangeMatch[2];
    return `${from}\u2013${to}`;
  }

  // List: a,b,c
  if (value.includes(",")) {
    const items = value.split(",").map((v) => {
      const trimmed = v.trim();
      return nameMap?.[trimmed.toUpperCase()] ?? trimmed;
    });
    return items.join(", ");
  }

  // Single value
  return nameMap?.[value.toUpperCase()] ?? value;
}

export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return "Invalid cron expression";

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const pieces: string[] = [];

  // Time
  if (minute === "*" && hour === "*") {
    pieces.push("Every minute");
  } else if (minute !== "*" && hour === "*") {
    pieces.push(`At :${minute.padStart(2, "0")} every hour`);
  } else if (hour.startsWith("*/")) {
    pieces.push(`Every ${hour.slice(2)} hours at :${minute === "*" ? "00" : minute.padStart(2, "0")}`);
  } else if (minute !== "*" && hour !== "*") {
    // Specific time
    const hourDesc = describeField(hour, "every hour");
    if (hour.includes(",") || hour.includes("-")) {
      pieces.push(`At :${minute.padStart(2, "0")} during hours ${hourDesc}`);
    } else {
      pieces.push(`At ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`);
    }
  } else {
    pieces.push(`Hour: ${describeField(hour, "every hour")}, Minute: ${describeField(minute, "every minute")}`);
  }

  // Day of month
  if (dayOfMonth !== "*") {
    const dom = describeField(dayOfMonth, "every day");
    pieces.push(`on day ${dom}`);
  }

  // Month
  if (month !== "*") {
    const m = describeField(month, "every month", MONTH_NAMES);
    pieces.push(`in ${m}`);
  }

  // Day of week
  if (dayOfWeek !== "*") {
    const dow = describeField(dayOfWeek, "every day", WEEKDAY_NAMES);
    pieces.push(`on ${dow}`);
  }

  return pieces.join(" ");
}

/* ── Cron field labels ─────────────────────────────────────────── */

const FIELD_LABELS = ["Minute", "Hour", "Day", "Month", "Weekday"];
const FIELD_HINTS = ["0\u201359", "0\u201323", "1\u201331", "1\u201312", "0\u20137 / MON\u2013SUN"];

/* ── Component ─────────────────────────────────────────────────── */

interface Props {
  value: string;
  onChange: (expression: string) => void;
}

export function CronScheduleEditor({ value, onChange }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fields = useMemo(() => {
    const parts = (value || "").trim().split(/\s+/);
    while (parts.length < 5) parts.push("*");
    return parts.slice(0, 5);
  }, [value]);

  const description = useMemo(() => {
    if (!value || value.trim().split(/\s+/).length < 5) return null;
    return describeCron(value);
  }, [value]);

  const activePreset = PRESETS.find((p) => p.expression === value?.trim());

  const updateField = (index: number, fieldValue: string) => {
    const next = [...fields];
    next[index] = fieldValue || "*";
    onChange(next.join(" "));
  };

  return (
    <div>
      {/* Presets */}
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        marginBottom: 10,
      }}>
        {PRESETS.map((preset) => (
          <button
            key={preset.expression}
            onClick={() => onChange(preset.expression)}
            title={`${preset.expression} — ${preset.description}`}
            style={{
              padding: "3px 8px",
              fontSize: 11,
              borderRadius: "var(--radius-sm, 4px)",
              border: preset.expression === value?.trim()
                ? "1px solid var(--accent-blue)"
                : "1px solid var(--border-default)",
              background: preset.expression === value?.trim()
                ? "var(--accent-blue)"
                : "var(--bg-primary)",
              color: preset.expression === value?.trim()
                ? "#fff"
                : "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "inherit",
              lineHeight: 1.4,
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Human-readable description */}
      {description && (
        <div style={{
          padding: "6px 10px",
          marginBottom: 10,
          background: "var(--bg-primary)",
          borderRadius: "var(--radius-sm, 4px)",
          border: "1px solid var(--border-default)",
          fontSize: 12,
          color: "var(--accent-blue)",
          lineHeight: 1.4,
        }}>
          {description}
          {activePreset && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
              {activePreset.description}
            </div>
          )}
        </div>
      )}

      {/* Toggle for advanced mode */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          fontSize: 11,
          cursor: "pointer",
          padding: 0,
          marginBottom: 8,
          fontFamily: "inherit",
          textDecoration: "underline",
        }}
      >
        {showAdvanced ? "Hide advanced editor" : "Edit fields individually\u2026"}
      </button>

      {showAdvanced && (
        <>
          {/* Individual field editors */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
            gap: 4,
            marginBottom: 8,
          }}>
            {fields.map((f, i) => (
              <div key={i}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2, textAlign: "center" }}>
                  {FIELD_LABELS[i]}
                </div>
                <input
                  className="zyra-input"
                  value={f}
                  onChange={(e) => updateField(i, e.target.value)}
                  placeholder="*"
                  title={`${FIELD_LABELS[i]}: ${FIELD_HINTS[i]}`}
                  style={{
                    textAlign: "center",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    padding: "4px 2px",
                  }}
                />
                <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 1, textAlign: "center" }}>
                  {FIELD_HINTS[i]}
                </div>
              </div>
            ))}
          </div>

          {/* Raw expression */}
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>
              Raw cron expression
            </div>
            <input
              className="zyra-input"
              value={value || ""}
              onChange={(e) => onChange(e.target.value)}
              placeholder="0 6 * * MON"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
