/**
 * Unit tests for the execution module: emptyRunState, STATUS_COLORS, and type contracts.
 */
import { describe, it, expect } from "vitest";
import { emptyRunState, STATUS_COLORS } from "../execution.js";
import type { NodeRunState, NodeRunStatus, RunEvent, RunEventType } from "../execution.js";

describe("emptyRunState", () => {
  it("returns status 'idle'", () => {
    expect(emptyRunState().status).toBe("idle");
  });

  it("returns empty stdout and stderr", () => {
    const s = emptyRunState();
    expect(s.stdout).toBe("");
    expect(s.stderr).toBe("");
  });

  it("returns an empty events array", () => {
    const s = emptyRunState();
    expect(s.events).toEqual([]);
    expect(Array.isArray(s.events)).toBe(true);
  });

  it("does not include optional timing fields", () => {
    const s = emptyRunState();
    expect(s.startedAt).toBeUndefined();
    expect(s.completedAt).toBeUndefined();
    expect(s.jobId).toBeUndefined();
    expect(s.exitCode).toBeUndefined();
  });

  it("returns a fresh object on each call (no shared state)", () => {
    const a = emptyRunState();
    const b = emptyRunState();
    expect(a).not.toBe(b);
    expect(a.events).not.toBe(b.events);
    // Mutating one should not affect the other
    a.events.push({ type: "submitted", timestamp: 1 });
    expect(b.events).toHaveLength(0);
  });
});

describe("STATUS_COLORS", () => {
  const ALL_STATUSES: NodeRunStatus[] = [
    "idle",
    "dry-run",
    "queued",
    "running",
    "succeeded",
    "failed",
    "canceled",
    "cached",
  ];

  it("has an entry for every NodeRunStatus", () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_COLORS[status]).toBeDefined();
      expect(typeof STATUS_COLORS[status]).toBe("string");
    }
  });

  it("all values are valid hex colors", () => {
    for (const color of Object.values(STATUS_COLORS)) {
      expect(color).toMatch(/^#[0-9a-fA-F]{3,6}$/);
    }
  });

  it("differentiates succeeded, failed, and canceled", () => {
    const { succeeded, failed, canceled } = STATUS_COLORS;
    expect(succeeded).not.toBe(failed);
    expect(succeeded).not.toBe(canceled);
    expect(failed).not.toBe(canceled);
  });
});

describe("RunEvent type contract", () => {
  it("can create a minimal RunEvent", () => {
    const event: RunEvent = {
      type: "submitted",
      timestamp: Date.now(),
    };
    expect(event.type).toBe("submitted");
    expect(typeof event.timestamp).toBe("number");
    expect(event.message).toBeUndefined();
    expect(event.detail).toBeUndefined();
  });

  it("can create a RunEvent with all optional fields", () => {
    const event: RunEvent = {
      type: "error",
      timestamp: Date.now(),
      message: "Connection refused",
      detail: { code: "ECONNREFUSED", host: "localhost" },
    };
    expect(event.message).toBe("Connection refused");
    expect(event.detail).toHaveProperty("code", "ECONNREFUSED");
  });

  it("supports all RunEventType values", () => {
    const allTypes: RunEventType[] = [
      "submitted",
      "job-accepted",
      "ws-connected",
      "ws-disconnected",
      "poll-fallback",
      "completed",
      "canceled",
      "error",
      "cache-hit",
    ];
    for (const type of allTypes) {
      const ev: RunEvent = { type, timestamp: 0 };
      expect(ev.type).toBe(type);
    }
  });
});

describe("NodeRunState with events", () => {
  it("can accumulate events over time", () => {
    const state: NodeRunState = emptyRunState();
    const t0 = 1000;

    state.status = "running";
    state.startedAt = t0;
    state.events.push({ type: "submitted", timestamp: t0, message: "Job submitted" });
    state.events.push({ type: "job-accepted", timestamp: t0 + 100, message: "Job accepted" });
    state.events.push({ type: "ws-connected", timestamp: t0 + 200 });

    expect(state.events).toHaveLength(3);
    expect(state.events[0].type).toBe("submitted");
    expect(state.events[2].timestamp - state.events[0].timestamp).toBe(200);
  });

  it("tracks timing from startedAt to completedAt", () => {
    const state: NodeRunState = emptyRunState();
    state.startedAt = 1000;
    state.completedAt = 6000;
    expect(state.completedAt - state.startedAt).toBe(5000);
  });
});
