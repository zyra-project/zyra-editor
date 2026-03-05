/** A single input or output port on a node. */
export interface PortDef {
  id: string;
  label: string;
  /** Accepted/produced data types. "any" matches everything. */
  types: string[];
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
