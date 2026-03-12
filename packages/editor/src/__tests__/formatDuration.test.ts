/**
 * Tests for the formatDuration helper used in NodeDetailPanel.
 *
 * Since formatDuration is not exported from NodeDetailPanel, we replicate
 * the logic here to validate the expected behavior contract.
 */
import { describe, it, expect } from "vitest";

// Mirror of the formatDuration function in NodeDetailPanel.tsx
function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

describe("formatDuration", () => {
  it("formats 0ms as '0s'", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats sub-second durations as '0s'", () => {
    expect(formatDuration(499)).toBe("0s");
  });

  it("rounds to nearest second", () => {
    expect(formatDuration(500)).toBe("1s");
    expect(formatDuration(1500)).toBe("2s");
  });

  it("formats seconds under a minute", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats exactly 60 seconds as '1m 0s'", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("formats larger durations", () => {
    expect(formatDuration(600000)).toBe("10m 0s");
    expect(formatDuration(3661000)).toBe("61m 1s");
  });
});
