import type { RunStepRequest } from "./execution.js";

/**
 * Recursively sort object keys so JSON.stringify produces a
 * deterministic string regardless of insertion order.
 */
function sortKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Build a deterministic JSON string from a RunStepRequest,
 * using only the fields that affect output (stage, command, args).
 * `mode` (sync/async) is intentionally excluded.
 */
export function canonicalizeRequest(req: RunStepRequest): string {
  return JSON.stringify({
    stage: req.stage,
    command: req.command,
    args: sortKeys(req.args),
  });
}

/**
 * Compute a SHA-256 hex digest cache key from a RunStepRequest.
 * Uses the Web Crypto API (available in all modern browsers and Node 18+).
 */
export async function computeCacheKey(req: RunStepRequest): Promise<string> {
  const canonical = canonicalizeRequest(req);
  const data = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
