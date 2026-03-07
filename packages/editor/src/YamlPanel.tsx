import { useState, useCallback, useEffect, useRef } from "react";
import yaml from "js-yaml";
import type { Pipeline, PipelineStep, PipelineGroup, PipelineControl } from "@zyra/core";

/** Zyra native YAML format: stages array with stage/command fields. */
interface NativeStage {
  stage: string;
  command: string;
  args?: Record<string, string | number | boolean>;
}

interface NativeYaml {
  name?: string;
  stages?: NativeStage[];
}

/**
 * Normalize parsed YAML into our Pipeline format.
 * Accepts both:
 * - Editor format: { version, steps: [{ name, command, args }] }
 * - Zyra native format: { name?, stages: [{ stage, command, args }] }
 */
function normalizePipeline(raw: unknown): Pipeline | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Editor format
  if (Array.isArray(obj.steps)) {
    const rawSteps = obj.steps as unknown[];
    const steps: PipelineStep[] = [];

    for (const s of rawSteps) {
      if (!s || typeof s !== "object") continue;
      const stepObj = s as Record<string, unknown>;

      const name = typeof stepObj.name === "string" ? stepObj.name : undefined;
      const command = typeof stepObj.command === "string" ? stepObj.command : undefined;
      if (!name || !command) continue;

      let args: Record<string, string | number | boolean> = {};
      const rawArgs = stepObj.args;
      if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            args[key] = value;
          }
        }
      }

      const step: PipelineStep = { name, command, args };

      if (typeof stepObj.label === "string" && stepObj.label) {
        step.label = stepObj.label;
      }

      if (
        stepObj._layout &&
        typeof stepObj._layout === "object" &&
        !Array.isArray(stepObj._layout)
      ) {
        const lo = stepObj._layout as Record<string, unknown>;
        if (typeof lo.x === "number" && typeof lo.y === "number") {
          const layout: PipelineStep["_layout"] = { x: lo.x, y: lo.y };
          if (typeof lo.w === "number") layout.w = lo.w;
          if (typeof lo.h === "number") layout.h = lo.h;
          step._layout = layout;
        }
      }

      if (Array.isArray(stepObj.depends_on)) {
        const deps = (stepObj.depends_on as unknown[]).filter(
          (d): d is string => typeof d === "string",
        );
        if (deps.length > 0) {
          step.depends_on = deps;
        }
      }

      steps.push(step);
    }

    if (steps.length === 0) return null;

    // Pass through _controls if present
    const pipeline: Pipeline = { version: "1", steps };
    const controls: PipelineControl[] = [];
    if (Array.isArray(obj._controls)) {
      for (const c of obj._controls as unknown[]) {
        if (!c || typeof c !== "object") continue;
        const co = c as Record<string, unknown>;
        if (typeof co.id !== "string" || typeof co.stageCommand !== "string") continue;
        let argValues: Record<string, string | number | boolean> = {};
        if (co.argValues && typeof co.argValues === "object" && !Array.isArray(co.argValues)) {
          for (const [k, v] of Object.entries(co.argValues as Record<string, unknown>)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") argValues[k] = v;
          }
        }
        const edges: PipelineControl["edges"] = [];
        if (Array.isArray(co.edges)) {
          for (const e of co.edges as unknown[]) {
            if (!e || typeof e !== "object") continue;
            const eo = e as Record<string, unknown>;
            if (typeof eo.targetNode === "string" && typeof eo.targetPort === "string") {
              edges.push({ targetNode: eo.targetNode, targetPort: eo.targetPort });
            }
          }
        }
        const ctrl: PipelineControl = { id: co.id, stageCommand: co.stageCommand, argValues, edges };
        if (typeof co.label === "string" && co.label) ctrl.label = co.label;
        if (co._layout && typeof co._layout === "object" && !Array.isArray(co._layout)) {
          const lo = co._layout as Record<string, unknown>;
          if (typeof lo.x === "number" && typeof lo.y === "number") {
            const layout: PipelineControl["_layout"] = { x: lo.x, y: lo.y };
            if (typeof lo.w === "number") layout.w = lo.w;
            if (typeof lo.h === "number") layout.h = lo.h;
            ctrl._layout = layout;
          }
        }
        controls.push(ctrl);
      }
      if (controls.length > 0) pipeline._controls = controls;
    }

    // Pass through _groups if present
    if (Array.isArray(obj._groups)) {
      const groups: PipelineGroup[] = [];
      const stepNames = new Set(steps.map((s) => s.name));
      for (const c of controls) stepNames.add(c.id);
      for (const g of obj._groups as unknown[]) {
        if (!g || typeof g !== "object") continue;
        const go = g as Record<string, unknown>;
        if (typeof go.id !== "string" || typeof go.label !== "string") continue;
        const pos = go.position as Record<string, unknown> | undefined;
        const sz = go.size as Record<string, unknown> | undefined;
        if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") continue;
        if (!sz || typeof sz.w !== "number" || typeof sz.h !== "number") continue;
        const children = Array.isArray(go.children)
          ? (go.children as unknown[]).filter((c): c is string => typeof c === "string" && stepNames.has(c))
          : [];
        groups.push({
          id: go.id,
          label: go.label,
          description: typeof go.description === "string" ? go.description : undefined,
          color: typeof go.color === "string" ? go.color : "#3b82f6",
          locked: typeof go.locked === "boolean" ? go.locked : undefined,
          position: { x: pos.x, y: pos.y },
          size: { w: sz.w, h: sz.h },
          children,
        });
      }
      if (groups.length > 0) pipeline._groups = groups;
    }

    return pipeline;
  }

  // Zyra native format
  if (Array.isArray(obj.stages)) {
    const rawStages = obj.stages as unknown[];
    const seen = new Map<string, number>();
    const steps: PipelineStep[] = [];
    for (const s of rawStages) {
      if (!s || typeof s !== "object") continue;
      const stageObj = s as Record<string, unknown>;

      const stage = typeof stageObj.stage === "string" ? stageObj.stage : undefined;
      const command = typeof stageObj.command === "string" ? stageObj.command : undefined;
      if (!stage || !command) continue;

      const base = `${stage}/${command}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const name = count === 1 ? base : `${base}-${count}`;

      let args: Record<string, string | number | boolean> = {};
      const rawArgs = stageObj.args;
      if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            args[key] = value;
          }
        }
      }

      const step: PipelineStep = {
        name,
        command: `${stage}/${command}`,
        args,
      };

      // Infer sequential dependencies from list order
      if (steps.length > 0) {
        step.depends_on = [steps[steps.length - 1].name];
      }

      steps.push(step);
    }
    return { version: "1", steps };
  }

  return null;
}

interface YamlPanelProps {
  /** Current pipeline derived from the canvas. */
  pipeline: Pipeline;
  /** Called when the user edits the YAML and it parses successfully. */
  onPipelineChange: (pipeline: Pipeline) => void;
  onClose: () => void;
}

export function YamlPanel({ pipeline, onPipelineChange, onClose }: YamlPanelProps) {
  const [yamlText, setYamlText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const userEditingRef = useRef(false);

  useEffect(() => {
    if (!userEditingRef.current) {
      setYamlText(yaml.dump(pipeline, { lineWidth: -1, noRefs: true }));
      setParseError(null);
    }
  }, [pipeline]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setYamlText(text);
    userEditingRef.current = true;
    setEditing(true);

    try {
      const raw = yaml.load(text, { schema: yaml.JSON_SCHEMA });
      const p = normalizePipeline(raw);
      if (p) {
        setParseError(null);
        onPipelineChange(p);
      } else {
        setParseError("Unrecognized format — expected 'steps' or 'stages' array");
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, [onPipelineChange]);

  const handleBlur = useCallback(() => {
    userEditingRef.current = false;
    setEditing(false);
  }, []);

  const handleSync = useCallback(() => {
    userEditingRef.current = false;
    setEditing(false);
    setYamlText(yaml.dump(pipeline, { lineWidth: -1, noRefs: true }));
    setParseError(null);
  }, [pipeline]);

  const handleOpen = useCallback(async () => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".yaml,.yml";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        setYamlText(text);
        userEditingRef.current = true;
        setEditing(true);
        try {
          const raw = yaml.load(text, { schema: yaml.JSON_SCHEMA });
          const p = normalizePipeline(raw);
          if (p) {
            setParseError(null);
            onPipelineChange(p);
          } else {
            setParseError("Unrecognized format — expected 'steps' or 'stages' array");
          }
        } catch (err) {
          setParseError(err instanceof Error ? err.message : String(err));
        }
      };
      input.click();
    } catch {
      // User cancelled
    }
  }, [onPipelineChange]);

  const handleSave = useCallback(() => {
    const blob = new Blob([yamlText], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pipeline.yaml";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [yamlText]);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      color: "var(--text-primary)",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-default)",
        gap: 8,
      }}>
        <span style={{ fontWeight: 600, flex: 1, fontSize: 14 }}>Pipeline YAML</span>
        <button className="zyra-btn zyra-btn--neutral" onClick={handleOpen} title="Open YAML file" style={{ fontSize: 11, padding: "4px 10px" }}>
          Open
        </button>
        <button className="zyra-btn zyra-btn--neutral" onClick={handleSave} title="Save as YAML file" style={{ fontSize: 11, padding: "4px 10px" }}>
          Save
        </button>
        {editing && (
          <button className="zyra-btn zyra-btn--info" onClick={handleSync} title="Discard edits and reload YAML from the canvas" style={{ fontSize: 11, padding: "4px 10px" }}>
            Reset
          </button>
        )}
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 18,
            padding: "0 4px",
            lineHeight: 1,
          }}
          title="Close YAML panel"
          aria-label="Close YAML panel"
        >
          &times;
        </button>
      </div>

      {/* Error bar */}
      {parseError && (
        <div style={{
          padding: "8px 16px",
          background: "var(--bg-error)",
          color: "var(--text-error)",
          fontSize: 11,
          borderBottom: "1px solid var(--border-default)",
          whiteSpace: "pre-wrap",
        }}>
          {parseError}
        </div>
      )}

      {/* Editor */}
      <textarea
        ref={textareaRef}
        value={yamlText}
        onChange={handleTextChange}
        onBlur={handleBlur}
        spellCheck={false}
        style={{
          flex: 1,
          background: "var(--bg-primary)",
          color: "var(--text-primary)",
          border: "none",
          padding: 16,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.6,
          resize: "none",
          outline: "none",
          tabSize: 2,
        }}
      />
    </div>
  );
}
