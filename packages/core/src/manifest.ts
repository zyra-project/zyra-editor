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
  type: "string" | "number" | "boolean" | "filepath" | "enum";
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

// ── arg-port helpers ──────────────────────────────────────────────

const ARG_TYPE_MAP: Record<string, string[]> = {
  string: ["string"],
  number: ["number"],
  boolean: ["boolean"],
  filepath: ["filepath", "string"],
  enum: ["string"],
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

/** Standard implicit output ports added to every node. */
export function getImplicitOutputs(): PortDef[] {
  return [
    { id: "implicit:stdout", label: "stdout", types: ["string"], implicit: true },
    { id: "implicit:stderr", label: "stderr", types: ["string"], implicit: true },
    { id: "implicit:exitcode", label: "exit code", types: ["number"], implicit: true },
  ];
}

/** Full port list for a node: explicit manifest ports + arg-ports + implicit outputs. */
export function getEffectivePorts(stageDef: StageDef): { inputs: PortDef[]; outputs: PortDef[] } {
  // Control nodes don't accept incoming arg-port connections (those edges aren't round-tripped)
  const includeArgPorts = stageDef.stage !== "control";
  const argPorts = includeArgPorts ? stageDef.args.map(argToPort) : [];
  // Only executable stages (non-empty cli) produce implicit stdout/stderr/exitcode
  const hasExecutableCli = stageDef.cli != null && stageDef.cli.trim().length > 0;
  return {
    inputs: [...stageDef.inputs, ...argPorts],
    outputs: hasExecutableCli
      ? [...stageDef.outputs, ...getImplicitOutputs()]
      : [...stageDef.outputs],
  };
}
