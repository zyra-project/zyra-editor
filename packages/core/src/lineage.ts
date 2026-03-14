/**
 * Asset lineage: compute upstream (ancestors) and downstream (dependents)
 * of a given node by walking the edge graph in both directions.
 */

export interface LineageResult {
  /** Node IDs that are ancestors (data flows FROM these TO the selected node). */
  upstream: Set<string>;
  /** Node IDs that are dependents (data flows FROM the selected node TO these). */
  downstream: Set<string>;
}

/**
 * BFS in both directions from `nodeId` through the edge list.
 * The selected node itself is NOT included in either set.
 */
export function computeLineage(
  nodeId: string,
  edges: readonly { source: string; target: string }[],
): LineageResult {
  // Build adjacency lists
  const parents = new Map<string, string[]>(); // target → sources
  const children = new Map<string, string[]>(); // source → targets

  for (const e of edges) {
    if (!parents.has(e.target)) parents.set(e.target, []);
    parents.get(e.target)!.push(e.source);
    if (!children.has(e.source)) children.set(e.source, []);
    children.get(e.source)!.push(e.target);
  }

  // BFS upstream (walk parent edges)
  const upstream = new Set<string>();
  let queue = [...(parents.get(nodeId) ?? [])];
  for (const p of queue) upstream.add(p);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of parents.get(current) ?? []) {
      if (!upstream.has(parent)) {
        upstream.add(parent);
        queue.push(parent);
      }
    }
  }

  // BFS downstream (walk child edges)
  const downstream = new Set<string>();
  queue = [...(children.get(nodeId) ?? [])];
  for (const c of queue) downstream.add(c);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (!downstream.has(child)) {
        downstream.add(child);
        queue.push(child);
      }
    }
  }

  return { upstream, downstream };
}
