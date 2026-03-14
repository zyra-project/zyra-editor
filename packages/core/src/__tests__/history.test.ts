/**
 * Unit tests for the buildRunRecord pure function.
 */
import { describe, it, expect } from "vitest";
import { buildRunRecord } from "../history.js";
import { emptyRunState } from "../execution.js";
import type { NodeRunState } from "../execution.js";

function makeState(overrides: Partial<NodeRunState>): NodeRunState {
  return { ...emptyRunState(), ...overrides };
}

describe("buildRunRecord", () => {
  it("returns undefined when all nodes are idle", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "idle" }));
    map.set("b", makeState({ status: "queued" }));
    expect(buildRunRecord(map, "pipeline")).toBeUndefined();
  });

  it("returns undefined for an empty map", () => {
    expect(buildRunRecord(new Map(), "pipeline")).toBeUndefined();
  });

  it("skips idle, dry-run, and queued nodes", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "idle" }));
    map.set("b", makeState({ status: "dry-run" }));
    map.set("c", makeState({ status: "queued" }));
    map.set("d", makeState({ status: "succeeded", startedAt: 1000, completedAt: 2000 }));
    const record = buildRunRecord(map, "pipeline");
    expect(record).toBeDefined();
    expect(record!.steps).toHaveLength(1);
    expect(record!.steps[0].nodeId).toBe("d");
    expect(record!.nodeCount).toBe(1);
  });

  it("computes 'succeeded' when all steps succeeded", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded", startedAt: 1000, completedAt: 2000 }));
    map.set("b", makeState({ status: "succeeded", startedAt: 1500, completedAt: 3000 }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("succeeded");
  });

  it("computes 'failed' when any step failed", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    map.set("b", makeState({ status: "failed" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("failed");
  });

  it("computes 'failed' even when there are also canceled steps", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "failed" }));
    map.set("b", makeState({ status: "canceled" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("failed");
  });

  it("computes 'canceled' when steps are canceled but none failed", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    map.set("b", makeState({ status: "canceled" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("canceled");
  });

  it("computes 'partial' when steps are running (not all succeeded, no failure/cancel)", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    map.set("b", makeState({ status: "running" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("partial");
  });

  it("computes correct durationMs from earliest startedAt to latest completedAt", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded", startedAt: 1000, completedAt: 3000 }));
    map.set("b", makeState({ status: "succeeded", startedAt: 2000, completedAt: 5000 }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.durationMs).toBe(4000); // 5000 - 1000
  });

  it("sets durationMs to undefined when timing is missing", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.durationMs).toBeUndefined();
  });

  it("converts timestamps to ISO strings", () => {
    const t = 1710000000000; // some epoch ms
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded", startedAt: t, completedAt: t + 1000 }));
    const record = buildRunRecord(map, "single-node")!;
    expect(record.steps[0].startedAt).toBe(new Date(t).toISOString());
    expect(record.steps[0].completedAt).toBe(new Date(t + 1000).toISOString());
    expect(record.steps[0].durationMs).toBe(1000);
  });

  it("preserves mode in the record", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    expect(buildRunRecord(map, "pipeline")!.mode).toBe("pipeline");
    expect(buildRunRecord(map, "single-node")!.mode).toBe("single-node");
  });

  it("includes graphSnapshot when provided", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    const snapshot = { nodes: [{ id: "n1" }], edges: [] };
    const record = buildRunRecord(map, "pipeline", snapshot)!;
    expect(record.graphSnapshot).toBe(snapshot);
  });

  it("sets graphSnapshot to undefined when not provided", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.graphSnapshot).toBeUndefined();
  });

  it("generates a valid UUID for the id", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "succeeded" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("treats 'cached' nodes as succeeded when computing overall status", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "cached", stdout: "cached output" }));
    map.set("b", makeState({ status: "succeeded" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("succeeded");
    expect(record.steps).toHaveLength(2);
  });

  it("records 'failed' when retry has cached + failed nodes", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "cached", stdout: "from cache" }));
    map.set("b", makeState({ status: "failed", stderr: "exit 1" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);
    expect(record.steps.find((s) => s.nodeId === "a")!.status).toBe("cached");
    expect(record.steps.find((s) => s.nodeId === "b")!.status).toBe("failed");
  });

  it("records 'canceled' when retry has cached + canceled (no failure)", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({ status: "cached" }));
    map.set("b", makeState({ status: "succeeded" }));
    map.set("c", makeState({ status: "canceled" }));
    const record = buildRunRecord(map, "pipeline")!;
    expect(record.status).toBe("canceled");
  });

  it("preserves step details: jobId, exitCode, stdout, stderr, events", () => {
    const events = [{ type: "submitted" as const, timestamp: 1000, message: "go" }];
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({
      status: "succeeded",
      jobId: "job-123",
      exitCode: 0,
      stdout: "hello",
      stderr: "warn",
      events,
    }));
    const step = buildRunRecord(map, "pipeline")!.steps[0];
    expect(step.jobId).toBe("job-123");
    expect(step.exitCode).toBe(0);
    expect(step.stdout).toBe("hello");
    expect(step.stderr).toBe("warn");
    expect(step.events).toBe(events);
  });
});

describe("buildRunRecord — secret redaction", () => {
  it("redacts secret values from stdout and stderr", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({
      status: "succeeded",
      startedAt: 1000,
      completedAt: 2000,
      stdout: "Connecting with key=sk-secret-123 to server",
      stderr: "DEBUG: Authorization: sk-secret-123",
    }));
    const record = buildRunRecord(map, "single-node", undefined, ["sk-secret-123"]);
    expect(record).toBeDefined();
    const step = record!.steps[0];
    expect(step.stdout).toBe("Connecting with key=***REDACTED*** to server");
    expect(step.stderr).toBe("DEBUG: Authorization: ***REDACTED***");
    expect(step.stdout).not.toContain("sk-secret-123");
    expect(step.stderr).not.toContain("sk-secret-123");
  });

  it("redacts secret values from request args", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({
      status: "succeeded",
      startedAt: 1000,
      completedAt: 2000,
      submittedRequest: {
        stage: "search",
        command: "zyra search api",
        args: { header: "X-API-Key: my-secret", param: "api_key=my-secret" },
        mode: "async",
      },
    }));
    const record = buildRunRecord(map, "single-node", undefined, ["my-secret"]);
    const step = record!.steps[0];
    expect(step.request?.args.header).toBe("X-API-Key: ***REDACTED***");
    expect(step.request?.args.param).toBe("api_key=***REDACTED***");
  });

  it("handles multiple secret values", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({
      status: "succeeded",
      startedAt: 1000,
      completedAt: 2000,
      stdout: "key1=aaa key2=bbb",
    }));
    const record = buildRunRecord(map, "single-node", undefined, ["aaa", "bbb"]);
    expect(record!.steps[0].stdout).toBe("key1=***REDACTED*** key2=***REDACTED***");
  });

  it("passes through unchanged when no secrets provided", () => {
    const map = new Map<string, NodeRunState>();
    map.set("a", makeState({
      status: "succeeded",
      startedAt: 1000,
      completedAt: 2000,
      stdout: "plain output",
    }));
    const record = buildRunRecord(map, "single-node");
    expect(record!.steps[0].stdout).toBe("plain output");
  });
});
