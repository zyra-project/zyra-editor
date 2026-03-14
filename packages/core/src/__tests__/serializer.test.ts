import { describe, it, expect } from "vitest";
import { graphToPipeline, resolvePeriodISO, PERIOD_TO_ISO } from "../serializer.js";
import type { Graph, Pipeline, PipelineDiagnostic } from "../serializer.js";
import type { StageDef } from "../manifest.js";

// ── fixture helpers ──────────────────────────────────────────────────────────

function makeStageDef(
  stage: string,
  command: string,
  overrides: Partial<StageDef> = {},
): StageDef {
  return {
    stage,
    command,
    label: `${stage}/${command}`,
    cli: `zyra ${stage} ${command}`,
    status: "implemented",
    color: "#aaa",
    inputs: [{ id: "in", label: "in", types: ["any"] }],
    outputs: [{ id: "out", label: "out", types: ["any"] }],
    args: [],
    ...overrides,
  };
}

const STAGES: StageDef[] = [
  makeStageDef("acquire", "http"),
  makeStageDef("process", "filter"),
  makeStageDef("export", "csv"),
];

function emptyGraph(): Graph {
  return { nodes: [], edges: [] };
}

// ── resolvePeriodISO ─────────────────────────────────────────────────────────

describe("resolvePeriodISO", () => {
  it.each(Object.entries(PERIOD_TO_ISO))(
    "maps '%s' → '%s'",
    (period, iso) => {
      expect(resolvePeriodISO(period, undefined)).toBe(iso);
    },
  );

  it("returns undefined for undefined period", () => {
    expect(resolvePeriodISO(undefined, undefined)).toBeUndefined();
  });

  it("returns undefined for empty string period", () => {
    expect(resolvePeriodISO("", undefined)).toBeUndefined();
  });

  it("returns customPeriod string when period is 'custom'", () => {
    expect(resolvePeriodISO("custom", "P2W")).toBe("P2W");
  });

  it("returns undefined when period is 'custom' and no customPeriod", () => {
    expect(resolvePeriodISO("custom", undefined)).toBeUndefined();
  });

  it("passes through unknown period values as-is", () => {
    expect(resolvePeriodISO("P3D", undefined)).toBe("P3D");
  });
});

// ── graphToPipeline — basic ──────────────────────────────────────────────────

describe("graphToPipeline — basic", () => {
  it("returns version '1'", () => {
    const pipeline = graphToPipeline(emptyGraph(), STAGES);
    expect(pipeline.version).toBe("1");
  });

  it("produces an empty steps array for an empty graph", () => {
    const pipeline = graphToPipeline(emptyGraph(), STAGES);
    expect(pipeline.steps).toEqual([]);
  });

  it("produces one step per non-control node", () => {
    const graph: Graph = {
      nodes: [{ id: "n1", stageCommand: "acquire/http", argValues: {} }],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps).toHaveLength(1);
    expect(pipeline.steps[0].name).toBe("n1");
  });

  it("sets the step command to the stage's cli value", () => {
    const graph: Graph = {
      nodes: [{ id: "fetch", stageCommand: "acquire/http", argValues: {} }],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0].command).toBe("zyra acquire http");
  });

  it("preserves argValues on the step", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "node1",
          stageCommand: "acquire/http",
          argValues: { url: "http://example.com", retries: 3 },
        },
      ],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0].args).toMatchObject({ url: "http://example.com", retries: 3 });
  });

  it("sets depends_on from edges between non-control nodes", () => {
    const graph: Graph = {
      nodes: [
        { id: "a", stageCommand: "acquire/http", argValues: {} },
        { id: "b", stageCommand: "process/filter", argValues: {} },
      ],
      edges: [{ sourceNode: "a", sourcePort: "out", targetNode: "b", targetPort: "in" }],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    const stepB = pipeline.steps.find((s) => s.name === "b")!;
    expect(stepB.depends_on).toEqual(["a"]);
  });

  it("topologically sorts steps (source before target)", () => {
    const graph: Graph = {
      nodes: [
        { id: "b", stageCommand: "process/filter", argValues: {} },
        { id: "a", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [{ sourceNode: "a", sourcePort: "out", targetNode: "b", targetPort: "in" }],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    const names = pipeline.steps.map((s) => s.name);
    expect(names.indexOf("a")).toBeLessThan(names.indexOf("b"));
  });

  it("throws when the graph has a cycle", () => {
    const graph: Graph = {
      nodes: [
        { id: "x", stageCommand: "acquire/http", argValues: {} },
        { id: "y", stageCommand: "process/filter", argValues: {} },
      ],
      edges: [
        { sourceNode: "x", sourcePort: "out", targetNode: "y", targetPort: "in" },
        { sourceNode: "y", sourcePort: "out", targetNode: "x", targetPort: "in" },
      ],
    };
    expect(() => graphToPipeline(graph, STAGES)).toThrow(/cycle/i);
  });

  it("serialises node label when it differs from id", () => {
    const graph: Graph = {
      nodes: [
        { id: "n1", label: "My Fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0].label).toBe("My Fetch");
  });

  it("omits step label when it equals the node id", () => {
    const graph: Graph = {
      nodes: [{ id: "n1", label: "n1", stageCommand: "acquire/http", argValues: {} }],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0].label).toBeUndefined();
  });

  it("includes _layout when node has a position", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "n1",
          stageCommand: "acquire/http",
          argValues: {},
          position: { x: 100, y: 200 },
        },
      ],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0]._layout).toMatchObject({ x: 100, y: 200 });
  });
});

// ── graphToPipeline — cron schedule ─────────────────────────────────────────

describe("graphToPipeline — cron schedule", () => {
  it("extracts schedule from a control/cron node", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "cron1",
          stageCommand: "control/cron",
          argValues: { expression: "0 * * * *", timezone: "UTC" },
        },
      ],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.schedule).toEqual({ cron: "0 * * * *", timezone: "UTC" });
  });

  it("sets schedule.enabled = false when cron node has enabled: false", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "cron1",
          stageCommand: "control/cron",
          argValues: { expression: "0 0 * * *", enabled: false },
        },
      ],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.schedule?.enabled).toBe(false);
  });

  it("emits a warning for a cron node without an expression", () => {
    const graph: Graph = {
      nodes: [{ id: "c1", stageCommand: "control/cron", argValues: {} }],
      edges: [],
    };
    const diagnostics: PipelineDiagnostic[] = [];
    const pipeline = graphToPipeline(graph, STAGES, diagnostics);
    expect(pipeline.schedule).toBeUndefined();
    expect(diagnostics.some((d) => d.level === "warn" && /cron/i.test(d.message))).toBe(true);
  });

  it("emits a warning when multiple cron nodes exist and uses only the first", () => {
    const graph: Graph = {
      nodes: [
        { id: "c1", stageCommand: "control/cron", argValues: { expression: "0 * * * *" } },
        { id: "c2", stageCommand: "control/cron", argValues: { expression: "1 * * * *" } },
      ],
      edges: [],
    };
    const diagnostics: PipelineDiagnostic[] = [];
    const pipeline = graphToPipeline(graph, STAGES, diagnostics);
    expect(pipeline.schedule?.cron).toBe("0 * * * *");
    expect(diagnostics.some((d) => d.level === "warn" && /multiple cron/i.test(d.message))).toBe(true);
  });
});

// ── graphToPipeline — delay nodes ───────────────────────────────────────────

describe("graphToPipeline — delay nodes", () => {
  it("sets delay_seconds from a control/delay node", () => {
    const graph: Graph = {
      nodes: [
        { id: "wait", stageCommand: "control/delay", argValues: { duration: 30, unit: "seconds" } },
        { id: "fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [{ sourceNode: "wait", sourcePort: "delay", targetNode: "fetch", targetPort: "in" }],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    const step = pipeline.steps.find((s) => s.name === "fetch")!;
    expect(step.delay_seconds).toBe(30);
  });

  it("converts minutes to seconds", () => {
    const graph: Graph = {
      nodes: [
        { id: "wait", stageCommand: "control/delay", argValues: { duration: 5, unit: "minutes" } },
        { id: "fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [{ sourceNode: "wait", sourcePort: "delay", targetNode: "fetch", targetPort: "in" }],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps.find((s) => s.name === "fetch")!.delay_seconds).toBe(300);
  });

  it("converts hours to seconds", () => {
    const graph: Graph = {
      nodes: [
        { id: "wait", stageCommand: "control/delay", argValues: { duration: 2, unit: "hours" } },
        { id: "fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [{ sourceNode: "wait", sourcePort: "delay", targetNode: "fetch", targetPort: "in" }],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps.find((s) => s.name === "fetch")!.delay_seconds).toBe(7200);
  });

  it("ignores delay nodes with zero duration", () => {
    const graph: Graph = {
      nodes: [
        { id: "wait", stageCommand: "control/delay", argValues: { duration: 0, unit: "seconds" } },
        { id: "fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [{ sourceNode: "wait", sourcePort: "delay", targetNode: "fetch", targetPort: "in" }],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps.find((s) => s.name === "fetch")!.delay_seconds).toBeUndefined();
  });
});

// ── graphToPipeline — conditional nodes ─────────────────────────────────────

describe("graphToPipeline — conditional nodes", () => {
  it("attaches a condition to a step from a control/conditional node", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "cond1",
          stageCommand: "control/conditional",
          argValues: { field: "status", operator: "==", compare_value: "200" },
        },
        { id: "n1", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [{ sourceNode: "cond1", sourcePort: "true", targetNode: "n1", targetPort: "in" }],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    const step = pipeline.steps.find((s) => s.name === "n1")!;
    expect(step.condition).toEqual({
      field: "status",
      operator: "==",
      value: "200",
      branch: "true",
    });
  });
});

// ── graphToPipeline — control node inlining ──────────────────────────────────

describe("graphToPipeline — control node inlining", () => {
  it("inlines a control/string value into a downstream arg", () => {
    const stages = [
      ...STAGES,
      makeStageDef("control", "string", {
        stage: "control",
        command: "string",
        cli: "",
        inputs: [],
        outputs: [{ id: "value", label: "Value", types: ["string"] }],
        args: [{ key: "value", label: "Value", type: "string", required: false }],
      }),
    ];
    const graph: Graph = {
      nodes: [
        { id: "str1", stageCommand: "control/string", argValues: { value: "hello" } },
        { id: "fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [
        {
          sourceNode: "str1",
          sourcePort: "value",
          targetNode: "fetch",
          targetPort: "arg:url",
        },
      ],
    };
    const pipeline = graphToPipeline(graph, stages);
    const step = pipeline.steps.find((s) => s.name === "fetch")!;
    expect(step.args.url).toBe("hello");
  });

  it("emits a warning for control-node edges to non-arg: ports", () => {
    const stages = [
      ...STAGES,
      makeStageDef("control", "string", {
        stage: "control",
        command: "string",
        cli: "",
        inputs: [],
        outputs: [{ id: "value", label: "Value", types: ["string"] }],
        args: [{ key: "value", label: "Value", type: "string", required: false }],
      }),
    ];
    const graph: Graph = {
      nodes: [
        { id: "str1", stageCommand: "control/string", argValues: { value: "x" } },
        { id: "fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [
        {
          sourceNode: "str1",
          sourcePort: "value",
          targetNode: "fetch",
          targetPort: "in", // not arg:*
        },
      ],
    };
    const diagnostics: PipelineDiagnostic[] = [];
    graphToPipeline(graph, stages, diagnostics);
    expect(diagnostics.some((d) => d.level === "warn")).toBe(true);
  });

  it("serialises control nodes as _controls metadata", () => {
    const stages = [
      ...STAGES,
      makeStageDef("control", "string", {
        stage: "control",
        command: "string",
        cli: "",
        inputs: [],
        outputs: [{ id: "value", label: "Value", types: ["string"] }],
        args: [{ key: "value", label: "Value", type: "string", required: false }],
      }),
    ];
    const graph: Graph = {
      nodes: [{ id: "str1", stageCommand: "control/string", argValues: { value: "x" } }],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, stages);
    expect(pipeline._controls).toHaveLength(1);
    expect(pipeline._controls![0].id).toBe("str1");
    expect(pipeline._controls![0].stageCommand).toBe("control/string");
  });

  it("strips plaintext value from control/secret nodes in _controls", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "sec1",
          stageCommand: "control/secret",
          argValues: { name: "API_KEY", value: "super-secret" },
        },
      ],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    const ctrl = pipeline._controls?.find((c) => c.id === "sec1");
    expect(ctrl?.argValues.value).toBeUndefined();
    expect(ctrl?.argValues.name).toBe("API_KEY");
  });

  it("emits env-var reference ${NAME} for secret nodes wired to step args", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "sec1",
          stageCommand: "control/secret",
          argValues: { name: "MY_TOKEN", value: "plaintext" },
        },
        { id: "fetch", stageCommand: "acquire/http", argValues: {} },
      ],
      edges: [
        {
          sourceNode: "sec1",
          sourcePort: "value",
          targetNode: "fetch",
          targetPort: "arg:token",
        },
      ],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0].args.token).toBe("${MY_TOKEN}");
  });

  it("interpolates wired value into {} placeholder in existing arg", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "sec1",
          stageCommand: "control/secret",
          argValues: { name: "API_KEY", value: "abc123" },
        },
        {
          id: "fetch",
          stageCommand: "acquire/http",
          argValues: { header: "X-API-Key: {}", param: "api_key={}" },
        },
      ],
      edges: [
        {
          sourceNode: "sec1",
          sourcePort: "value",
          targetNode: "fetch",
          targetPort: "arg:header",
        },
        {
          sourceNode: "sec1",
          sourcePort: "value",
          targetNode: "fetch",
          targetPort: "arg:param",
        },
      ],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0].args.header).toBe("X-API-Key: ${API_KEY}");
    expect(pipeline.steps[0].args.param).toBe("api_key=${API_KEY}");
  });

  it("replaces entire arg when no {} placeholder is present (backward compat)", () => {
    const graph: Graph = {
      nodes: [
        {
          id: "sec1",
          stageCommand: "control/secret",
          argValues: { name: "TOKEN", value: "secret" },
        },
        {
          id: "fetch",
          stageCommand: "acquire/http",
          argValues: { token: "old-value" },
        },
      ],
      edges: [
        {
          sourceNode: "sec1",
          sourcePort: "value",
          targetNode: "fetch",
          targetPort: "arg:token",
        },
      ],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.steps[0].args.token).toBe("${TOKEN}");
  });
});

// ── graphToPipeline — transitive dependencies ────────────────────────────────

describe("graphToPipeline — transitive dependencies", () => {
  it("injects step A → step B dependency when A feeds a control node that feeds B", () => {
    const stages = [
      ...STAGES,
      makeStageDef("control", "string", {
        stage: "control",
        command: "string",
        cli: "",
        inputs: [{ id: "in", label: "in", types: ["any"] }],
        outputs: [{ id: "value", label: "Value", types: ["string"] }],
        args: [{ key: "value", label: "Value", type: "string", required: false }],
      }),
    ];
    const graph: Graph = {
      nodes: [
        { id: "a", stageCommand: "acquire/http", argValues: {} },
        { id: "ctrl", stageCommand: "control/string", argValues: { value: "x" } },
        { id: "b", stageCommand: "process/filter", argValues: {} },
      ],
      edges: [
        { sourceNode: "a", sourcePort: "out", targetNode: "ctrl", targetPort: "in" },
        { sourceNode: "ctrl", sourcePort: "value", targetNode: "b", targetPort: "arg:format" },
      ],
    };
    const pipeline = graphToPipeline(graph, stages);
    const stepB = pipeline.steps.find((s) => s.name === "b")!;
    expect(stepB.depends_on).toContain("a");
  });
});

// ── Pipeline.resources ──────────────────────────────────────────────────────

describe("Pipeline.resources", () => {
  it("Pipeline type accepts resources field", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [{ name: "a", command: "acquire/http", args: { path: "${res:work_dir}" } }],
      resources: [
        { name: "work_dir", value: "/data/output" },
        { name: "s3_bucket", value: "s3://my-bucket", description: "Main bucket" },
      ],
    };
    expect(pipeline.resources).toHaveLength(2);
    expect(pipeline.resources![0].name).toBe("work_dir");
    expect(pipeline.resources![1].description).toBe("Main bucket");
  });

  it("Pipeline without resources has undefined field", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [{ name: "a", command: "acquire/http", args: {} }],
    };
    expect(pipeline.resources).toBeUndefined();
  });

  it("graphToPipeline does not populate resources (set externally)", () => {
    const graph: Graph = {
      nodes: [{ id: "a", stageCommand: "acquire/http", argValues: {} }],
      edges: [],
    };
    const pipeline = graphToPipeline(graph, STAGES);
    expect(pipeline.resources).toBeUndefined();
  });
});
