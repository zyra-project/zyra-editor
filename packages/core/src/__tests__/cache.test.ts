import { describe, it, expect } from "vitest";
import { canonicalizeRequest, computeCacheKey } from "../cache.js";
import type { RunStepRequest } from "../execution.js";

function req(overrides?: Partial<RunStepRequest>): RunStepRequest {
  return {
    stage: "acquire",
    command: "http",
    args: { url: "http://example.com", format: "json" },
    mode: "async",
    ...overrides,
  };
}

describe("canonicalizeRequest", () => {
  it("produces deterministic JSON", () => {
    const a = canonicalizeRequest(req());
    const b = canonicalizeRequest(req());
    expect(a).toBe(b);
  });

  it("ignores mode field", () => {
    const a = canonicalizeRequest(req({ mode: "async" }));
    const b = canonicalizeRequest(req({ mode: "sync" }));
    expect(a).toBe(b);
  });

  it("sorts arg keys alphabetically", () => {
    const a = canonicalizeRequest(req({ args: { z: 1, a: 2 } }));
    const b = canonicalizeRequest(req({ args: { a: 2, z: 1 } }));
    expect(a).toBe(b);
    // Verify key order in the JSON
    expect(a).toContain('"a":2');
    const aIdx = a.indexOf('"a"');
    const zIdx = a.indexOf('"z"');
    expect(aIdx).toBeLessThan(zIdx);
  });

  it("sorts nested object keys", () => {
    const a = canonicalizeRequest(
      req({ args: { opts: { z: 1, a: 2 } } as Record<string, unknown> }),
    );
    const b = canonicalizeRequest(
      req({ args: { opts: { a: 2, z: 1 } } as Record<string, unknown> }),
    );
    expect(a).toBe(b);
  });

  it("includes stage and command", () => {
    const json = canonicalizeRequest(req());
    expect(json).toContain('"stage":"acquire"');
    expect(json).toContain('"command":"http"');
  });
});

describe("computeCacheKey", () => {
  it("returns a 64-char hex string (SHA-256)", async () => {
    const key = await computeCacheKey(req());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", async () => {
    const a = await computeCacheKey(req());
    const b = await computeCacheKey(req());
    expect(a).toBe(b);
  });

  it("ignores mode", async () => {
    const a = await computeCacheKey(req({ mode: "async" }));
    const b = await computeCacheKey(req({ mode: "sync" }));
    expect(a).toBe(b);
  });

  it("differs when stage changes", async () => {
    const a = await computeCacheKey(req({ stage: "acquire" }));
    const b = await computeCacheKey(req({ stage: "process" }));
    expect(a).not.toBe(b);
  });

  it("differs when command changes", async () => {
    const a = await computeCacheKey(req({ command: "http" }));
    const b = await computeCacheKey(req({ command: "s3" }));
    expect(a).not.toBe(b);
  });

  it("differs when args change", async () => {
    const a = await computeCacheKey(req({ args: { url: "http://a.com" } }));
    const b = await computeCacheKey(req({ args: { url: "http://b.com" } }));
    expect(a).not.toBe(b);
  });

  it("is stable regardless of arg key order", async () => {
    const a = await computeCacheKey(req({ args: { x: 1, y: 2 } }));
    const b = await computeCacheKey(req({ args: { y: 2, x: 1 } }));
    expect(a).toBe(b);
  });
});
