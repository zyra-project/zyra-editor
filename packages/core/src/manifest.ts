/** A single input or output port on a node. */
export interface PortDef {
  id: string;
  label: string;
  /** Accepted/produced data types. "any" matches everything. */
  types: string[];
  /** True for auto-generated ports (arg-ports, stdout/stderr/exitcode). */
  implicit?: boolean;
  /** If this input port maps to an ArgDef, its key. */
  argKey?: string;
}

/** A CLI argument / option exposed by the command. */
export interface ArgDef {
  key: string;
  /** CLI flag, e.g. "-o" or "--format". Omit for positional args. */
  flag?: string;
  label: string;
  type: "string" | "number" | "boolean" | "filepath" | "enum" | "date";
  required: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  description?: string;
  /** Only relevant when type === "enum". */
  options?: string[];
}

/** One command in the manifest — becomes one node type in the editor. */
export interface StageDef {
  stage: string;
  command: string;
  label: string;
  /** Short description of what this command does. */
  description?: string;
  /** Full CLI invocation, e.g. "zyra acquire http". */
  cli: string;
  status: "implemented" | "planned" | "experimental";
  /** Hex colour for the node header. */
  color: string;
  inputs: PortDef[];
  outputs: PortDef[];
  args: ArgDef[];
}

/** Root manifest shape emitted by `zyra manifest --json`. */
export interface Manifest {
  version: string;
  stages: StageDef[];
}

// ── helpers ────────────────────────────────────────────────────────

/** Check whether an output port is type-compatible with an input port. */
export function portsCompatible(
  output: PortDef,
  input: PortDef,
): boolean {
  if (output.types.includes("any") || input.types.includes("any")) return true;
  return output.types.some((t) => input.types.includes(t));
}

// ── arg validation ───────────────────────────────────────────────

/** A single validation error for an argument. */
export interface ArgValidationError {
  key: string;
  message: string;
}

/**
 * Validate argument values against their ArgDef constraints.
 * @param args      The ArgDef definitions from the stage manifest.
 * @param values    The current argument values keyed by ArgDef.key.
 * @param linkedKeys  Set of arg keys that are wired from another node (skip required check).
 * @returns Array of validation errors (empty = valid).
 */
export function validateArgs(
  args: ArgDef[],
  values: Record<string, unknown>,
  linkedKeys?: Set<string>,
): ArgValidationError[] {
  const errors: ArgValidationError[] = [];

  for (const arg of args) {
    const val = values[arg.key];
    const isLinked = linkedKeys?.has(arg.key);

    // Required check (skip if wired from another node)
    if (arg.required && !isLinked) {
      if (val === undefined || val === null || val === "") {
        errors.push({ key: arg.key, message: `${arg.label} is required` });
        continue; // no point checking type on empty value
      }
    }

    // Skip further checks if value is empty/undefined (optional field)
    if (val === undefined || val === null || val === "") continue;

    // Type-specific checks
    switch (arg.type) {
      case "number": {
        const n = typeof val === "number" ? val : Number(val);
        if (Number.isNaN(n)) {
          errors.push({ key: arg.key, message: `${arg.label} must be a valid number` });
        }
        break;
      }
      case "enum": {
        if (arg.options && !arg.options.includes(String(val))) {
          errors.push({ key: arg.key, message: `${arg.label} must be one of: ${arg.options.join(", ")}` });
        }
        break;
      }
      case "date": {
        const d = new Date(String(val));
        if (Number.isNaN(d.getTime())) {
          errors.push({ key: arg.key, message: `${arg.label} must be a valid date` });
        }
        break;
      }
    }
  }

  return errors;
}

// ── arg-port helpers ──────────────────────────────────────────────

const ARG_TYPE_MAP: Record<string, string[]> = {
  string: ["string"],
  number: ["number"],
  boolean: ["boolean"],
  filepath: ["filepath", "string"],
  enum: ["string"],
  date: ["date", "string"],
};

/** Convert an ArgDef into an implicit input PortDef. */
export function argToPort(arg: ArgDef): PortDef {
  return {
    id: `arg:${arg.key}`,
    label: arg.label,
    types: ARG_TYPE_MAP[arg.type] ?? ["string"],
    implicit: true,
    argKey: arg.key,
  };
}

/** Convert an ArgDef into an implicit output PortDef for arg-to-arg wiring. */
export function argToOutputPort(arg: ArgDef): PortDef {
  return {
    id: `argout:${arg.key}`,
    label: arg.label,
    types: ARG_TYPE_MAP[arg.type] ?? ["string"],
    implicit: true,
    argKey: arg.key,
  };
}

/** Standard implicit output ports added to every node. */
export function getImplicitOutputs(): PortDef[] {
  return [
    { id: "implicit:stdout", label: "stdout", types: ["string"], implicit: true },
    { id: "implicit:stderr", label: "stderr", types: ["string"], implicit: true },
    { id: "implicit:exitcode", label: "exit code", types: ["number"], implicit: true },
  ];
}

/** Full port list for a node: explicit manifest ports + arg-ports + implicit outputs + arg-output ports. */
export function getEffectivePorts(stageDef: StageDef): { inputs: PortDef[]; outputs: PortDef[] } {
  // Control nodes don't accept incoming arg-port connections (those edges aren't round-tripped)
  const includeArgPorts = stageDef.stage !== "control";
  const argPorts = includeArgPorts ? stageDef.args.map(argToPort) : [];
  const argOutputPorts = includeArgPorts ? stageDef.args.map(argToOutputPort) : [];
  // Only executable stages (non-empty cli) produce implicit stdout/stderr/exitcode
  const hasExecutableCli = stageDef.cli != null && stageDef.cli.trim().length > 0;
  return {
    inputs: [...stageDef.inputs, ...argPorts],
    outputs: hasExecutableCli
      ? [...stageDef.outputs, ...getImplicitOutputs(), ...argOutputPorts]
      : [...stageDef.outputs, ...argOutputPorts],
  };
}
