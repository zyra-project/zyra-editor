import { useEffect, useRef, useState } from "react";
import { STATUS_COLORS } from "@zyra/core";
import type { RunStateMap } from "./useExecution";
import type { RunStepRecord } from "@zyra/core";

// ── Data types ──────────────────────────────────────────────────────

export interface GanttBar {
  nodeId: string;
  startMs: number;
  endMs: number;
  status: string;
}

// ── Converters ──────────────────────────────────────────────────────

/** Convert live RunStateMap to Gantt bars. */
export function runStateToGanttBars(runState: RunStateMap): GanttBar[] {
  const bars: GanttBar[] = [];
  const now = Date.now();
  for (const [nodeId, ns] of runState) {
    if (!ns.startedAt) continue;
    bars.push({
      nodeId,
      startMs: ns.startedAt,
      endMs: ns.completedAt ?? now,
      status: ns.status,
    });
  }
  bars.sort((a, b) => a.startMs - b.startMs);
  return bars;
}

/** Convert historical RunStepRecord[] to Gantt bars. */
export function stepsToGanttBars(steps: RunStepRecord[]): GanttBar[] {
  const bars: GanttBar[] = [];
  for (const step of steps) {
    if (!step.startedAt) continue;
    const startMs = new Date(step.startedAt).getTime();
    const endMs = step.completedAt
      ? new Date(step.completedAt).getTime()
      : step.durationMs
        ? startMs + step.durationMs
        : startMs + 1000; // fallback 1s
    bars.push({
      nodeId: step.nodeId,
      startMs,
      endMs,
      status: step.status,
    });
  }
  bars.sort((a, b) => a.startMs - b.startMs);
  return bars;
}

// ── Chart constants ────────────────────────────────────────────────

const ROW_HEIGHT = 26;
const BAR_HEIGHT = 16;
const LABEL_WIDTH = 130;
const HEADER_HEIGHT = 22;
const MIN_BAR_PX = 4;
const PADDING_RIGHT = 8;

// ── Chart component ────────────────────────────────────────────────

export function GanttChart({ bars, width }: { bars: GanttBar[]; width: number }) {
  // Live tick for running bars
  const hasRunning = bars.some((b) => b.status === "running");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  if (bars.length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 11, color: "var(--text-muted)" }}>
        No timing data available.
      </div>
    );
  }

  const now = Date.now();
  const effectiveBars = bars.map((b) => ({
    ...b,
    endMs: b.status === "running" ? now : b.endMs,
  }));

  const minStart = Math.min(...effectiveBars.map((b) => b.startMs));
  const maxEnd = Math.max(...effectiveBars.map((b) => b.endMs));
  const totalDuration = Math.max(maxEnd - minStart, 1);
  const chartWidth = Math.max(width - LABEL_WIDTH - PADDING_RIGHT, 60);
  const svgHeight = HEADER_HEIGHT + bars.length * ROW_HEIGHT + 4;

  function xScale(ms: number): number {
    return LABEL_WIDTH + ((ms - minStart) / totalDuration) * chartWidth;
  }

  // Compute time axis ticks (3-5 marks)
  const ticks = computeTicks(totalDuration);

  return (
    <svg
      width={width}
      height={svgHeight}
      style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 9 }}
    >
      {/* Time axis ticks */}
      {ticks.map((tickMs) => {
        const x = xScale(minStart + tickMs);
        return (
          <g key={tickMs}>
            <line
              x1={x} y1={HEADER_HEIGHT - 2}
              x2={x} y2={svgHeight}
              stroke="var(--border-default)"
              strokeWidth={0.5}
              strokeDasharray="2,3"
            />
            <text
              x={x}
              y={HEADER_HEIGHT - 6}
              fill="var(--text-muted)"
              textAnchor="middle"
              fontSize={9}
            >
              +{formatTickLabel(tickMs)}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {effectiveBars.map((bar, i) => {
        const y = HEADER_HEIGHT + i * ROW_HEIGHT;
        const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2;
        const x1 = xScale(bar.startMs);
        const x2 = xScale(bar.endMs);
        const barWidth = Math.max(x2 - x1, MIN_BAR_PX);
        const color = (STATUS_COLORS as Record<string, string>)[bar.status] ?? "#555";
        const durationSec = ((bar.endMs - bar.startMs) / 1000).toFixed(1);
        const truncatedId = bar.nodeId.length > 16
          ? bar.nodeId.slice(0, 15) + "\u2026"
          : bar.nodeId;

        return (
          <g key={bar.nodeId}>
            {/* Node label */}
            <text
              x={LABEL_WIDTH - 6}
              y={barY + BAR_HEIGHT / 2}
              fill="var(--text-secondary)"
              textAnchor="end"
              dominantBaseline="central"
              fontSize={10}
            >
              {truncatedId}
            </text>

            {/* Bar rect */}
            <rect
              x={x1}
              y={barY}
              width={barWidth}
              height={BAR_HEIGHT}
              rx={3}
              fill={color}
              opacity={0.85}
            >
              <title>{bar.nodeId} — {bar.status} ({durationSec}s)</title>
            </rect>

            {/* Duration label inside bar if wide enough */}
            {barWidth > 40 && (
              <text
                x={x1 + barWidth / 2}
                y={barY + BAR_HEIGHT / 2}
                fill="#fff"
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9}
                fontWeight={600}
              >
                {durationSec}s
              </text>
            )}

            {/* Pulsing indicator for running bars */}
            {bar.status === "running" && (
              <rect
                x={x1 + barWidth - 3}
                y={barY}
                width={3}
                height={BAR_HEIGHT}
                rx={1}
                fill="#fff"
                opacity={0.7}
              >
                <animate
                  attributeName="opacity"
                  values="0.7;0.2;0.7"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              </rect>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Responsive container wrapper ────────────────────────────────────

export function GanttChartContainer({ bars }: { bars: GanttBar[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ width: "100%", overflow: "hidden" }}>
      <GanttChart bars={bars} width={width} />
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function computeTicks(totalMs: number): number[] {
  const totalSec = totalMs / 1000;
  // Choose a nice step size for 3-5 ticks
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let step = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (totalSec / c <= 6) {
      step = c;
      break;
    }
  }
  const ticks: number[] = [0];
  let t = step;
  while (t * 1000 < totalMs) {
    ticks.push(t * 1000);
    t += step;
  }
  return ticks;
}

function formatTickLabel(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem > 0 ? `${min}m${rem}s` : `${min}m`;
}
