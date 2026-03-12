import { describe, it, expect } from "vitest";
import {
  portsCompatible,
  argToPort,
  argToOutputPort,
  getImplicitOutputs,
  getEffectivePorts,
  validateArgs,
} from "../manifest.js";
import type { PortDef, ArgDef, StageDef } from "../manifest.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function makePort(types: string[], id = "p"): PortDef {
  return { id, label: id, types };
}

function makeArg(overrides: Partial<ArgDef> = {}): ArgDef {
  return {
    key: "my_arg",
    label: "My Arg",
    type: "string",
    required: false,
    ...overrides,
  };
}

function makeStageDef(overrides: Partial<StageDef> = {}): StageDef {
  return {
    stage: "test",
    command: "run",
    label: "Test Run",
    cli: "zyra test run",
    status: "implemented",
    color: "#ff0000",
    inputs: [],
    outputs: [],
    args: [],
    ...overrides,
  };
}

// ── portsCompatible ──────────────────────────────────────────────────────────

describe("portsCompatible", () => {
  it("returns true when types overlap", () => {
    expect(portsCompatible(makePort(["string"]), makePort(["string"]))).toBe(true);
  });

  it("returns false when types do not overlap", () => {
    expect(portsCompatible(makePort(["string"]), makePort(["number"]))).toBe(false);
  });

  it("returns true when output has 'any'", () => {
    expect(portsCompatible(makePort(["any"]), makePort(["number"]))).toBe(true);
  });

  it("returns true when input has 'any'", () => {
    expect(portsCompatible(makePort(["filepath"]), makePort(["any"]))).toBe(true);
  });

  it("returns true when both have 'any'", () => {
    expect(portsCompatible(makePort(["any"]), makePort(["any"]))).toBe(true);
  });

  it("returns true when one type in a multi-type output matches input", () => {
    expect(portsCompatible(makePort(["filepath", "string"]), makePort(["string"]))).toBe(true);
  });

  it("returns false when neither side contains a matching type", () => {
    expect(portsCompatible(makePort(["number", "boolean"]), makePort(["string"]))).toBe(false);
  });
});

// ── argToPort ────────────────────────────────────────────────────────────────

describe("argToPort", () => {
  it("creates a port with id prefixed 'arg:'", () => {
    const port = argToPort(makeArg({ key: "output_file", type: "filepath" }));
    expect(port.id).toBe("arg:output_file");
  });

  it("maps filepath type to ['filepath', 'string']", () => {
    const port = argToPort(makeArg({ type: "filepath" }));
    expect(port.types).toEqual(["filepath", "string"]);
  });

  it("maps string type to ['string']", () => {
    const port = argToPort(makeArg({ type: "string" }));
    expect(port.types).toEqual(["string"]);
  });

  it("maps number type to ['number']", () => {
    const port = argToPort(makeArg({ type: "number" }));
    expect(port.types).toEqual(["number"]);
  });

  it("maps boolean type to ['boolean']", () => {
    const port = argToPort(makeArg({ type: "boolean" }));
    expect(port.types).toEqual(["boolean"]);
  });

  it("maps enum type to ['string']", () => {
    const port = argToPort(makeArg({ type: "enum" }));
    expect(port.types).toEqual(["string"]);
  });

  it("maps date type to ['date', 'string']", () => {
    const port = argToPort(makeArg({ type: "date" }));
    expect(port.types).toEqual(["date", "string"]);
  });

  it("marks the port as implicit with the arg's key", () => {
    const port = argToPort(makeArg({ key: "src" }));
    expect(port.implicit).toBe(true);
    expect(port.argKey).toBe("src");
  });
});

// ── argToOutputPort ──────────────────────────────────────────────────────────

describe("argToOutputPort", () => {
  it("creates a port with id prefixed 'argout:'", () => {
    const port = argToOutputPort(makeArg({ key: "format" }));
    expect(port.id).toBe("argout:format");
  });

  it("uses the same type mapping as argToPort", () => {
    const inPort = argToPort(makeArg({ type: "date" }));
    const outPort = argToOutputPort(makeArg({ type: "date" }));
    expect(outPort.types).toEqual(inPort.types);
  });

  it("is marked implicit with the arg's key", () => {
    const port = argToOutputPort(makeArg({ key: "region" }));
    expect(port.implicit).toBe(true);
    expect(port.argKey).toBe("region");
  });
});

// ── getImplicitOutputs ───────────────────────────────────────────────────────

describe("getImplicitOutputs", () => {
  it("returns three ports: stdout, stderr, exitcode", () => {
    const ports = getImplicitOutputs();
    expect(ports).toHaveLength(3);
    const ids = ports.map((p) => p.id);
    expect(ids).toContain("implicit:stdout");
    expect(ids).toContain("implicit:stderr");
    expect(ids).toContain("implicit:exitcode");
  });

  it("stdout and stderr are string type", () => {
    const ports = getImplicitOutputs();
    const stdout = ports.find((p) => p.id === "implicit:stdout")!;
    const stderr = ports.find((p) => p.id === "implicit:stderr")!;
    expect(stdout.types).toEqual(["string"]);
    expect(stderr.types).toEqual(["string"]);
  });

  it("exitcode is number type", () => {
    const ports = getImplicitOutputs();
    const exitcode = ports.find((p) => p.id === "implicit:exitcode")!;
    expect(exitcode.types).toEqual(["number"]);
  });

  it("all ports are marked implicit", () => {
    const ports = getImplicitOutputs();
    expect(ports.every((p) => p.implicit)).toBe(true);
  });
});

// ── getEffectivePorts ────────────────────────────────────────────────────────

describe("getEffectivePorts", () => {
  it("includes explicit manifest inputs", () => {
    const stage = makeStageDef({
      inputs: [makePort(["filepath"], "in_file")],
    });
    const { inputs } = getEffectivePorts(stage);
    expect(inputs.some((p) => p.id === "in_file")).toBe(true);
  });

  it("adds arg-input ports for each ArgDef", () => {
    const stage = makeStageDef({
      args: [makeArg({ key: "region" }), makeArg({ key: "format" })],
    });
    const { inputs } = getEffectivePorts(stage);
    expect(inputs.some((p) => p.id === "arg:region")).toBe(true);
    expect(inputs.some((p) => p.id === "arg:format")).toBe(true);
  });

  it("includes implicit stdout/stderr/exitcode in outputs for executable stages", () => {
    const stage = makeStageDef({ cli: "zyra test run" });
    const { outputs } = getEffectivePorts(stage);
    expect(outputs.some((p) => p.id === "implicit:stdout")).toBe(true);
    expect(outputs.some((p) => p.id === "implicit:stderr")).toBe(true);
    expect(outputs.some((p) => p.id === "implicit:exitcode")).toBe(true);
  });

  it("omits implicit stdout/stderr/exitcode when cli is empty", () => {
    const stage = makeStageDef({ cli: "" });
    const { outputs } = getEffectivePorts(stage);
    expect(outputs.every((p) => !p.id.startsWith("implicit:"))).toBe(true);
  });

  it("omits implicit stdout/stderr/exitcode when cli is whitespace only", () => {
    const stage = makeStageDef({ cli: "   " });
    const { outputs } = getEffectivePorts(stage);
    expect(outputs.every((p) => !p.id.startsWith("implicit:"))).toBe(true);
  });

  it("includes argout ports for executable stages with args", () => {
    const stage = makeStageDef({
      cli: "zyra test run",
      args: [makeArg({ key: "out" })],
    });
    const { outputs } = getEffectivePorts(stage);
    expect(outputs.some((p) => p.id === "argout:out")).toBe(true);
  });

  it("does NOT add arg-ports for control-stage nodes", () => {
    const stage = makeStageDef({
      stage: "control",
      command: "string",
      cli: "",
      args: [makeArg({ key: "value" })],
    });
    const { inputs, outputs } = getEffectivePorts(stage);
    expect(inputs.every((p) => !p.id.startsWith("arg:"))).toBe(true);
    expect(outputs.every((p) => !p.id.startsWith("argout:"))).toBe(true);
  });
});

// ── validateArgs ──────────────────────────────────────────────────────────────

describe("validateArgs", () => {
  it("returns no errors when all required fields are filled", () => {
    const args = [makeArg({ key: "name", required: true })];
    expect(validateArgs(args, { name: "hello" })).toEqual([]);
  });

  it("returns error for missing required field", () => {
    const args = [makeArg({ key: "name", label: "Name", required: true })];
    const errors = validateArgs(args, {});
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("name");
    expect(errors[0].message).toContain("required");
  });

  it("returns error for empty string on required field", () => {
    const args = [makeArg({ key: "name", label: "Name", required: true })];
    expect(validateArgs(args, { name: "" })).toHaveLength(1);
  });

  it("skips required check for linked (wired) args", () => {
    const args = [makeArg({ key: "name", required: true })];
    expect(validateArgs(args, {}, new Set(["name"]))).toEqual([]);
  });

  it("returns no errors for optional empty fields", () => {
    const args = [makeArg({ key: "opt", required: false })];
    expect(validateArgs(args, {})).toEqual([]);
  });

  it("validates number type — rejects non-numeric string", () => {
    const args = [makeArg({ key: "count", label: "Count", type: "number", required: false })];
    const errors = validateArgs(args, { count: "abc" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("valid number");
  });

  it("validates number type — accepts numeric string", () => {
    const args = [makeArg({ key: "count", type: "number", required: false })];
    expect(validateArgs(args, { count: "42" })).toEqual([]);
  });

  it("validates number type — accepts actual number", () => {
    const args = [makeArg({ key: "count", type: "number", required: false })];
    expect(validateArgs(args, { count: 0 })).toEqual([]);
  });

  it("validates enum type — rejects value not in options", () => {
    const args = [makeArg({ key: "fmt", label: "Format", type: "enum", options: ["csv", "json"], required: false })];
    const errors = validateArgs(args, { fmt: "xml" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("one of");
  });

  it("validates enum type — accepts valid option", () => {
    const args = [makeArg({ key: "fmt", type: "enum", options: ["csv", "json"], required: false })];
    expect(validateArgs(args, { fmt: "csv" })).toEqual([]);
  });

  it("validates date type — rejects invalid date", () => {
    const args = [makeArg({ key: "since", label: "Since", type: "date", required: false })];
    const errors = validateArgs(args, { since: "not-a-date" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("valid date");
  });

  it("validates date type — accepts valid date", () => {
    const args = [makeArg({ key: "since", type: "date", required: false })];
    expect(validateArgs(args, { since: "2025-01-15" })).toEqual([]);
  });

  it("collects multiple errors across different args", () => {
    const args = [
      makeArg({ key: "name", label: "Name", required: true }),
      makeArg({ key: "count", label: "Count", type: "number", required: false }),
    ];
    const errors = validateArgs(args, { count: "abc" });
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.key)).toEqual(["name", "count"]);
  });
});
