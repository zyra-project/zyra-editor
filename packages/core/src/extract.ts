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
  try {
    const obj: unknown = JSON.parse(json);
    const result = resolvePath(obj, expression);
    if (result === undefined || result === null) {
      return fallback ?? "";
    }
    return typeof result === "object" ? JSON.stringify(result) : String(result);
  } catch {
    return fallback ?? "";
  }
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
