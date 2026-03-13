/**
 * Pipeline-level resources: named values that nodes reference via ${res:name}.
 * Enables dependency injection — swap infrastructure config without editing nodes.
 */

/** A named pipeline-level resource. */
export interface PipelineResource {
  name: string;
  value: string;
  description?: string;
}

/** Map of resource name → value for fast lookup. */
export type ResourceMap = Record<string, string>;

/** Regex matching ${res:name} tokens in arg values. */
const RES_REF = /\$\{res:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Valid resource name pattern. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Convert a PipelineResource[] to a ResourceMap for resolution. */
export function toResourceMap(resources: PipelineResource[]): ResourceMap {
  const map: ResourceMap = {};
  for (const r of resources) map[r.name] = r.value;
  return map;
}

/** Return all ${res:name} references found in a string value. */
export function findResourceRefs(value: string): string[] {
  const refs: string[] = [];
  const re = new RegExp(RES_REF.source, RES_REF.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

/**
 * Resolve all ${res:name} references in a single arg value.
 * Non-string values pass through unchanged.
 * Unresolved references are left as-is.
 */
export function resolveResourceRefs(
  value: string | number | boolean,
  resources: ResourceMap,
): string | number | boolean {
  if (typeof value !== "string") return value;
  return value.replace(
    new RegExp(RES_REF.source, RES_REF.flags),
    (match, name) => (name in resources ? resources[name] : match),
  );
}

/** Resolve all ${res:name} references in a full args record. */
export function resolveArgsResources(
  args: Record<string, string | number | boolean>,
  resources: ResourceMap,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = resolveResourceRefs(v, resources);
  }
  return out;
}

/**
 * Resolve ${res:name} in a Record<string, unknown> (as used by RunStepRequest.args).
 * Only string values are resolved; other types pass through.
 */
export function resolveRequestResources(
  args: Record<string, unknown>,
  resources: ResourceMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      out[k] = v.replace(
        new RegExp(RES_REF.source, RES_REF.flags),
        (match, name) => (name in resources ? resources[name] : match),
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Validate resource definitions. Returns diagnostics for invalid entries. */
export function validateResources(
  resources: PipelineResource[],
): { name: string; message: string }[] {
  const errors: { name: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const r of resources) {
    if (!NAME_RE.test(r.name)) {
      errors.push({
        name: r.name,
        message: `Invalid name "${r.name}" — must match [A-Za-z_][A-Za-z0-9_]*`,
      });
    }
    if (seen.has(r.name)) {
      errors.push({ name: r.name, message: `Duplicate resource name "${r.name}"` });
    }
    seen.add(r.name);
  }
  return errors;
}
