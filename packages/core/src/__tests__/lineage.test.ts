/**
 * Unit tests for the computeLineage function.
 */
import { describe, it, expect } from "vitest";
import { computeLineage } from "../lineage.js";

const edges = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
  { source: "c", target: "d" },
  { source: "a", target: "e" },
  { source: "e", target: "d" },
  { source: "x", target: "y" }, // disconnected pair
];

describe("computeLineage", () => {
  it("returns empty sets for a node with no connections", () => {
    const result = computeLineage("z", edges);
    expect(result.upstream.size).toBe(0);
    expect(result.downstream.size).toBe(0);
  });

  it("finds upstream ancestors", () => {
    const result = computeLineage("d", edges);
    // d has upstream: c, b, a (via c→d) and e, a (via e→d)
    expect(result.upstream).toEqual(new Set(["a", "b", "c", "e"]));
  });

  it("finds downstream dependents", () => {
    const result = computeLineage("a", edges);
    // a → b → c → d, a → e → d
    expect(result.downstream).toEqual(new Set(["b", "c", "d", "e"]));
  });

  it("does not include the selected node in either set", () => {
    const result = computeLineage("b", edges);
    expect(result.upstream.has("b")).toBe(false);
    expect(result.downstream.has("b")).toBe(false);
  });

  it("computes both directions for a middle node", () => {
    const result = computeLineage("c", edges);
    expect(result.upstream).toEqual(new Set(["a", "b"]));
    expect(result.downstream).toEqual(new Set(["d"]));
  });

  it("handles disconnected subgraphs", () => {
    const result = computeLineage("x", edges);
    expect(result.upstream.size).toBe(0);
    expect(result.downstream).toEqual(new Set(["y"]));
  });

  it("handles a single-edge graph", () => {
    const result = computeLineage("a", [{ source: "a", target: "b" }]);
    expect(result.upstream.size).toBe(0);
    expect(result.downstream).toEqual(new Set(["b"]));
  });

  it("handles empty edge list", () => {
    const result = computeLineage("a", []);
    expect(result.upstream.size).toBe(0);
    expect(result.downstream.size).toBe(0);
  });

  it("handles diamond patterns correctly", () => {
    // a → b, a → c, b → d, c → d (diamond)
    const diamond = [
      { source: "a", target: "b" },
      { source: "a", target: "c" },
      { source: "b", target: "d" },
      { source: "c", target: "d" },
    ];
    const result = computeLineage("b", diamond);
    expect(result.upstream).toEqual(new Set(["a"]));
    expect(result.downstream).toEqual(new Set(["d"]));
  });
});
