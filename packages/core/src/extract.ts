/**
 * Lightweight dot-notation extractor for JSON strings.
 *
 * Supports paths like:
 *   "name"            → obj.name
 *   "data.url"        → obj.data.url
 *   "results[0].path" → obj.results[0].path
 *   "items[2].name"   → obj.items[2].name
 */

/**
 * Parse a JSON string and extract a value at the given dot-notation path.
 * Returns the extracted value as a string, or the fallback if extraction fails.
 */
export function extractByPath(
  json: string,
  expression: string,
  fallback?: string,
): string {
  const obj = parseJson(json);
  if (obj === undefined) return fallback ?? "";
  const result = resolvePath(obj, expression);
  if (result === undefined || result === null) {
    return fallback ?? "";
  }
  return typeof result === "object" ? JSON.stringify(result) : String(result);
}

/**
 * Try to parse JSON from a string that may contain multiple concatenated
 * JSON values (e.g. CLI commands that emit results per-URL).
 * Returns the last successfully parsed non-empty value, or undefined.
 */
function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Fast path: single valid JSON value
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to multi-block parsing
  }

  // Find all top-level JSON arrays/objects by matching balanced brackets.
  // Walk through the string looking for '[' or '{' at the top level.
  const blocks: unknown[] = [];
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === "[" || ch === "{") {
      const close = ch === "[" ? "]" : "}";
      let depth = 1;
      let j = i + 1;
      let inString = false;
      let escape = false;
      while (j < trimmed.length && depth > 0) {
        const c = trimmed[j];
        if (escape) { escape = false; }
        else if (c === "\\") { escape = true; }
        else if (c === '"') { inString = !inString; }
        else if (!inString) {
          if (c === ch) depth++;
          else if (c === close) depth--;
        }
        j++;
      }
      if (depth === 0) {
        try {
          const parsed = JSON.parse(trimmed.slice(i, j));
          blocks.push(parsed);
        } catch { /* skip malformed block */ }
      }
      i = j;
    } else {
      i++;
    }
  }

  if (blocks.length === 0) return undefined;
  // Prefer the last non-empty array/object (CLI output often starts with empty [])
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    if (Array.isArray(b) && b.length > 0) return b;
    if (b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length > 0) return b;
  }
  // Fall back to the last block even if empty
  return blocks[blocks.length - 1];
}

function resolvePath(obj: unknown, path: string): unknown {
  // Normalize "foo[0].bar" → "foo.0.bar"
  const segments = path.replace(/\[(\d+)]/g, ".$1").split(".").filter(Boolean);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}
