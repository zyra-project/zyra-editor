import { describe, it, expect } from "vitest";
import { pipelineToGraph } from "../deserializer.js";
import type { Pipeline } from "../serializer.js";
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

function emptyPipeline(): Pipeline {
  return { version: "1", steps: [] };
}

// ── pipelineToGraph — basic ──────────────────────────────────────────────────

describe("pipelineToGraph — basic", () => {
  it("returns an empty graph for an empty pipeline", () => {
    const { nodes, edges } = pipelineToGraph(emptyPipeline(), STAGES);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("creates one node per pipeline step", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: {} },
        { name: "filter", command: "zyra process filter", args: {} },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.id)).toEqual(["fetch", "filter"]);
  });

  it("resolves stageCommand from cli string", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [{ name: "fetch", command: "zyra acquire http", args: {} }],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    expect(nodes[0].stageCommand).toBe("acquire/http");
  });

  it("preserves argValues from pipeline step args", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "fetch",
          command: "zyra acquire http",
          args: { url: "http://example.com", retries: 3 },
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    expect(nodes[0].argValues).toMatchObject({ url: "http://example.com", retries: 3 });
  });

  it("restores position from _layout", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "fetch",
          command: "zyra acquire http",
          args: {},
          _layout: { x: 50, y: 120 },
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    expect(nodes[0].position).toEqual({ x: 50, y: 120 });
  });

  it("restores size from _layout when w and h are present", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "fetch",
          command: "zyra acquire http",
          args: {},
          _layout: { x: 0, y: 0, w: 300, h: 200 },
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    expect(nodes[0].size).toEqual({ w: 300, h: 200 });
  });

  it("creates edges from depends_on", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: {} },
        { name: "filter", command: "zyra process filter", args: {}, depends_on: ["fetch"] },
      ],
    };
    const { edges } = pipelineToGraph(pipeline, STAGES);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceNode).toBe("fetch");
    expect(edges[0].targetNode).toBe("filter");
  });

  it("uses the stage's first output port for dependency edges", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: {} },
        { name: "filter", command: "zyra process filter", args: {}, depends_on: ["fetch"] },
      ],
    };
    const { edges } = pipelineToGraph(pipeline, STAGES);
    // STAGES[0] (acquire/http) has first output "out" (then implicit ports)
    expect(edges[0].sourcePort).toBe("out");
  });

  it("falls back to stageCommand when command is not found in stages", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [{ name: "unknown", command: "mystery/node", args: {} }],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    expect(nodes[0].stageCommand).toBe("mystery/node");
  });
});

// ── pipelineToGraph — backward-compat aliases ────────────────────────────────

describe("pipelineToGraph — backward-compat aliases", () => {
  it("maps 'control/variable' to 'control/string'", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [],
      _controls: [
        {
          id: "v1",
          stageCommand: "control/variable",
          argValues: { value: "x" },
          edges: [],
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const ctrl = nodes.find((n) => n.id === "v1");
    expect(ctrl?.stageCommand).toBe("control/string");
  });
});

// ── pipelineToGraph — schedule reconstruction ────────────────────────────────

describe("pipelineToGraph — schedule reconstruction", () => {
  it("creates a control/cron node from pipeline.schedule when no _controls cron exists", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [],
      schedule: { cron: "0 * * * *", timezone: "UTC" },
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const cronNode = nodes.find((n) => n.stageCommand === "control/cron");
    expect(cronNode).toBeDefined();
    expect(cronNode?.argValues.expression).toBe("0 * * * *");
    expect(cronNode?.argValues.timezone).toBe("UTC");
  });

  it("does NOT create a duplicate cron node when _controls already has one", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [],
      schedule: { cron: "0 * * * *" },
      _controls: [
        {
          id: "cron1",
          stageCommand: "control/cron",
          argValues: { expression: "0 * * * *" },
          edges: [],
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const cronNodes = nodes.filter((n) => n.stageCommand === "control/cron");
    expect(cronNodes).toHaveLength(1);
  });
});

// ── pipelineToGraph — delay reconstruction ───────────────────────────────────

describe("pipelineToGraph — delay reconstruction", () => {
  it("creates a control/delay node from a step's delay_seconds", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: {}, delay_seconds: 60 },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const delayNode = nodes.find((n) => n.stageCommand === "control/delay");
    expect(delayNode).toBeDefined();
    expect(delayNode?.argValues.duration).toBe(1);
    expect(delayNode?.argValues.unit).toBe("minutes");
  });

  it("uses 'hours' when delay_seconds is divisible by 3600", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: {}, delay_seconds: 7200 },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const delay = nodes.find((n) => n.stageCommand === "control/delay");
    expect(delay?.argValues.unit).toBe("hours");
    expect(delay?.argValues.duration).toBe(2);
  });

  it("creates a delay→step edge", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: {}, delay_seconds: 30 },
      ],
    };
    const { nodes, edges } = pipelineToGraph(pipeline, STAGES);
    const delayNode = nodes.find((n) => n.stageCommand === "control/delay");
    expect(delayNode).toBeDefined();
    const edge = edges.find((e) => e.sourceNode === delayNode!.id);
    expect(edge?.targetNode).toBe("fetch");
    expect(edge?.sourcePort).toBe("delay");
  });
});

// ── pipelineToGraph — conditional reconstruction ─────────────────────────────

describe("pipelineToGraph — conditional reconstruction", () => {
  it("creates a control/conditional node from a step with condition", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "process",
          command: "zyra process filter",
          args: {},
          condition: { field: "status", operator: "==", value: "200", branch: "true" },
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const condNode = nodes.find((n) => n.stageCommand === "control/conditional");
    expect(condNode).toBeDefined();
    expect(condNode?.argValues.field).toBe("status");
    expect(condNode?.argValues.operator).toBe("==");
    expect(condNode?.argValues.compare_value).toBe("200");
  });

  it("wires conditional's true/false port to the downstream step", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "process",
          command: "zyra process filter",
          args: {},
          condition: { field: "ok", operator: "==", value: "true", branch: "false" },
        },
      ],
    };
    const { nodes, edges } = pipelineToGraph(pipeline, STAGES);
    const condNode = nodes.find((n) => n.stageCommand === "control/conditional")!;
    const edge = edges.find((e) => e.sourceNode === condNode.id);
    expect(edge?.sourcePort).toBe("false");
    expect(edge?.targetNode).toBe("process");
  });

  it("shares one conditional node for steps with the same condition signature", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "a",
          command: "zyra acquire http",
          args: {},
          condition: { field: "x", operator: "==", value: "1", branch: "true" },
        },
        {
          name: "b",
          command: "zyra process filter",
          args: {},
          condition: { field: "x", operator: "==", value: "1", branch: "false" },
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const condNodes = nodes.filter((n) => n.stageCommand === "control/conditional");
    expect(condNodes).toHaveLength(1);
  });
});

// ── pipelineToGraph — _controls reconstruction ───────────────────────────────

describe("pipelineToGraph — _controls reconstruction", () => {
  it("adds control nodes from _controls", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [],
      _controls: [
        {
          id: "str1",
          stageCommand: "control/string",
          argValues: { value: "hello" },
          edges: [],
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    expect(nodes.some((n) => n.id === "str1")).toBe(true);
  });

  it("reconstructs edges from _controls edge list", () => {
    // Use a stage that declares a 'url' arg so the deserializer's port
    // validation doesn't drop the edge.
    const stagesWithUrl = [
      makeStageDef("acquire", "http", {
        args: [{ key: "url", label: "URL", type: "string", required: true }],
      }),
      ...STAGES.slice(1),
    ];
    const pipeline: Pipeline = {
      version: "1",
      steps: [{ name: "fetch", command: "zyra acquire http", args: {} }],
      _controls: [
        {
          id: "str1",
          stageCommand: "control/string",
          argValues: { value: "http://example.com" },
          edges: [{ targetNode: "fetch", targetPort: "arg:url", sourcePort: "value" }],
        },
      ],
    };
    const { edges } = pipelineToGraph(pipeline, stagesWithUrl);
    const edge = edges.find((e) => e.sourceNode === "str1");
    expect(edge).toBeDefined();
    expect(edge?.targetNode).toBe("fetch");
    expect(edge?.targetPort).toBe("arg:url");
  });

  it("initialises secret node value to empty string when missing from _controls", () => {
    const pipeline: Pipeline = {
      version: "1",
      steps: [],
      _controls: [
        {
          id: "sec1",
          stageCommand: "control/secret",
          argValues: { name: "MY_KEY" }, // value is stripped during serialization
          edges: [],
        },
      ],
    };
    const { nodes } = pipelineToGraph(pipeline, STAGES);
    const sec = nodes.find((n) => n.id === "sec1");
    expect(sec?.argValues.value).toBe("");
  });
});

// ── pipelineToGraph — _argWires reconstruction ───────────────────────────────

describe("pipelineToGraph — _argWires reconstruction", () => {
  it("reconstructs arg-to-arg wire edges from _argWires", () => {
    const stages = [
      makeStageDef("acquire", "http", {
        args: [{ key: "url", label: "URL", type: "string", required: true }],
      }),
      makeStageDef("process", "filter", {
        args: [{ key: "source_url", label: "Source URL", type: "string", required: false }],
      }),
    ];
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: { url: "http://example.com" } },
        { name: "filter", command: "zyra process filter", args: {} },
      ],
      _argWires: [
        { sourceNode: "fetch", sourceArgKey: "url", targetNode: "filter", targetArgKey: "source_url" },
      ],
    };
    const { edges } = pipelineToGraph(pipeline, stages);
    const argEdge = edges.find(
      (e) => e.sourceNode === "fetch" && e.targetNode === "filter",
    );
    expect(argEdge).toBeDefined();
    expect(argEdge?.sourcePort).toBe("argout:url");
    expect(argEdge?.targetPort).toBe("arg:source_url");
  });

  it("skips arg-wire edges when the source arg does not exist in the stage", () => {
    const stages = [
      makeStageDef("acquire", "http", {
        args: [{ key: "url", label: "URL", type: "string", required: true }],
      }),
      makeStageDef("process", "filter", {
        args: [{ key: "source_url", label: "Source URL", type: "string", required: false }],
      }),
    ];
    const pipeline: Pipeline = {
      version: "1",
      steps: [
        { name: "fetch", command: "zyra acquire http", args: {} },
        { name: "filter", command: "zyra process filter", args: {} },
      ],
      _argWires: [
        {
          sourceNode: "fetch",
          sourceArgKey: "nonexistent_arg",
          targetNode: "filter",
          targetArgKey: "source_url",
        },
      ],
    };
    const { edges } = pipelineToGraph(pipeline, stages);
    expect(edges.every((e) => e.sourcePort !== "argout:nonexistent_arg")).toBe(true);
  });
});

// ── format placeholder round-trip ─────────────────────────────────────────────

describe("pipelineToGraph — format placeholder round-trip", () => {
  it("restores {} format strings from _controls edges into target node argValues", () => {
    const stages: StageDef[] = [
      makeStageDef("acquire", "http", {
        args: [
          { key: "header", label: "Header", type: "string", required: false },
          { key: "param", label: "Param", type: "string", required: false },
        ],
      }),
      makeStageDef("process", "filter"),
      makeStageDef("export", "csv"),
      makeStageDef("control", "secret", {
        stage: "control",
        command: "secret",
        cli: "",
        inputs: [],
        outputs: [{ id: "value", label: "Value", types: ["string"] }],
        args: [
          { key: "name", label: "Name", type: "string", required: true },
          { key: "value", label: "Value", type: "string", required: true },
        ],
      }),
    ];

    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "fetch",
          command: "zyra acquire http",
          args: { header: "X-API-Key: ${API_KEY}", param: "api_key=${API_KEY}" },
        },
      ],
      _controls: [
        {
          id: "sec1",
          stageCommand: "control/secret",
          argValues: { name: "API_KEY" },
          edges: [
            { targetNode: "fetch", targetPort: "arg:header", format: "X-API-Key: {}" },
            { targetNode: "fetch", targetPort: "arg:param", format: "api_key={}" },
          ],
        },
      ],
    };

    const { nodes } = pipelineToGraph(pipeline, stages);
    const fetch = nodes.find((n) => n.id === "fetch")!;
    expect(fetch.argValues.header).toBe("X-API-Key: {}");
    expect(fetch.argValues.param).toBe("api_key={}");
  });

  it("leaves arg value as-is when no format is specified on control edge", () => {
    const stages: StageDef[] = [
      ...STAGES,
      makeStageDef("control", "secret", {
        stage: "control",
        command: "secret",
        cli: "",
        inputs: [],
        outputs: [{ id: "value", label: "Value", types: ["string"] }],
        args: [
          { key: "name", label: "Name", type: "string", required: true },
          { key: "value", label: "Value", type: "string", required: true },
        ],
      }),
    ];

    const pipeline: Pipeline = {
      version: "1",
      steps: [
        {
          name: "fetch",
          command: "zyra acquire http",
          args: { token: "${MY_TOKEN}" },
        },
      ],
      _controls: [
        {
          id: "sec1",
          stageCommand: "control/secret",
          argValues: { name: "MY_TOKEN" },
          edges: [
            { targetNode: "fetch", targetPort: "arg:token" },
          ],
        },
      ],
    };

    const { nodes } = pipelineToGraph(pipeline, stages);
    const fetch = nodes.find((n) => n.id === "fetch")!;
    // Without format, the inlined value from step.args is kept
    expect(fetch.argValues.token).toBe("${MY_TOKEN}");
  });
});
