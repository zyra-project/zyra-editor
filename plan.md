# Plan: Arg-Ports — Every Argument as a Connectable Port

## Concept

Today, nodes have a small number of explicitly-defined data ports (e.g. "Output File") and a separate list of args (e.g. `--sync-dir`, `--pattern`). This plan promotes **every arg to a dual-purpose input port**: it can be filled manually in the inspector *or* wired from an upstream node's output. Similarly, we add **richer output ports** derived from what a command actually produces (log, metadata, directory listing, etc.).

The node on the canvas shows only connected or filled arg-ports by default, with an expand toggle to reveal all. This keeps nodes compact when simple, but fully wirable when needed.

---

## Design Details

### A. Arg-Input Ports (left side of node)

Each `ArgDef` in a stage's manifest generates an implicit input port:

| ArgDef field | Maps to |
|---|---|
| `key` | Port ID: `"arg:<key>"` (namespaced to avoid collision with existing data ports) |
| `label` | Port label |
| `type` ("string", "number", "boolean", "filepath", "enum") | Port type(s): `["string"]`, `["number"]`, `["boolean"]`, `["filepath", "string"]`, `["string"]` |

**Visibility rules on the node canvas:**
- **Always shown:** arg-ports that have an incoming edge (wired from another node)
- **Always shown:** arg-ports where the user has filled a value in the inspector
- **Hidden by default:** arg-ports with no value and no connection
- **Expand toggle:** a small "show all / hide empty" button at the bottom of the input port section reveals all arg-ports so you can drag a wire to them

**Behavior when wired:**
- If an arg-port has an incoming edge, that edge supplies the value at execution time — the inspector field becomes read-only with a "linked" badge and shows the upstream node label
- The user can disconnect the wire to regain manual control
- In the serialized pipeline, wired args are expressed as a reference to the upstream step's output rather than a literal value

### B. Richer Output Ports

Currently most nodes only expose a single "Output File" port. We expand this:

1. **Manifest-driven:** The `StageDef.outputs` array in the manifest already supports multiple ports. The server/manifest should list all meaningful outputs a command can produce (e.g. `file`, `log`, `listing`, `metadata`). No editor code change needed to *render* them — they'll appear automatically.

2. **Implicit outputs (editor-generated):** For every node, the editor automatically adds these virtual output ports if the manifest doesn't already define them:
   - `stdout` (type: `["string"]`) — the captured stdout text
   - `stderr` (type: `["string"]`) — the captured stderr text
   - `exitcode` (type: `["number"]`) — the exit code

   These let you wire a node's stdout into another node's `--input` arg, for example.

3. **Visibility:** Implicit output ports are hidden by default and shown via the same expand toggle, or shown whenever they have an outgoing edge.

### C. Core Type Changes (`packages/core/`)

#### `manifest.ts` — New types/fields

```ts
// Add to PortDef:
export interface PortDef {
  id: string;
  label: string;
  types: string[];
  implicit?: boolean;   // true for auto-generated ports (arg-ports, stdout/stderr/exitcode)
  argKey?: string;       // if this port maps to an ArgDef, its key (for arg-input ports)
}
```

#### New helper: `argToPort(arg: ArgDef): PortDef`

Converts an ArgDef into a PortDef for the input side:

```ts
function argToPort(arg: ArgDef): PortDef {
  const typeMap: Record<string, string[]> = {
    string: ["string"],
    number: ["number"],
    boolean: ["boolean"],
    filepath: ["filepath", "string"],
    enum: ["string"],
  };
  return {
    id: `arg:${arg.key}`,
    label: arg.label,
    types: typeMap[arg.type] ?? ["string"],
    implicit: true,
    argKey: arg.key,
  };
}
```

#### New helper: `getImplicitOutputs(): PortDef[]`

Returns the standard implicit output ports:

```ts
function getImplicitOutputs(): PortDef[] {
  return [
    { id: "implicit:stdout", label: "stdout", types: ["string"], implicit: true },
    { id: "implicit:stderr", label: "stderr", types: ["string"], implicit: true },
    { id: "implicit:exitcode", label: "exit code", types: ["number"], implicit: true },
  ];
}
```

#### New helper: `getEffectivePorts(stageDef: StageDef): { inputs: PortDef[]; outputs: PortDef[] }`

Returns the full port list for a node — explicit manifest ports + generated arg-ports + implicit outputs:

```ts
function getEffectivePorts(stageDef: StageDef): { inputs: PortDef[]; outputs: PortDef[] } {
  const argPorts = stageDef.args.map(argToPort);
  return {
    inputs: [...stageDef.inputs, ...argPorts],
    outputs: [...stageDef.outputs, ...getImplicitOutputs()],
  };
}
```

#### `ports.ts` — Update compatibility

`portsCompatible()` already works with type arrays, so no change needed. The new `"string"`, `"number"`, `"boolean"`, `"filepath"` types will match naturally. We may want to add `"string"` as a universal-ish match (a number can be coerced to string) — but that's optional and can come later.

#### `serializer.ts` — Handle wired args

When serializing a graph to a pipeline, if an arg-port has an incoming edge:
- Instead of putting the value in `args`, emit a reference like `$ref: "<sourceNodeId>.<sourcePortId>"` so the runtime knows to resolve it from the upstream output.
- Alternatively, keep it simple for now: if an arg has an incoming wire, omit it from `args` and add the dependency. The runtime already tracks `depends_on`. A future enhancement can pass the actual value.

### D. Editor UI Changes (`packages/editor/`)

#### `ZyraNode.tsx` — Render arg-ports and implicit outputs

1. Compute `effectivePorts = getEffectivePorts(stageDef)`
2. For each input port, determine visibility:
   - Explicit (non-implicit) ports: always visible
   - Arg-ports: visible if connected OR if `argValues[argKey]` is non-empty
   - If `expanded` state is true: show all
3. Render visible input ports on the left with React Flow `Handle` components
4. For arg-ports, show the value inline (as currently done) but with a small port dot on the left edge
5. Same logic for output ports: explicit always visible, implicit visible if connected or expanded
6. Add a subtle expand/collapse toggle: e.g. `"⋯ 22 more args"` / `"show less"`
7. Connected arg-ports show a "linked" indicator instead of the value

#### `NodeDetailPanel.tsx` — Inspector linked-arg state

In the Settings tab:
- For each arg, check if its arg-port has an incoming edge
- If wired: show a read-only "Linked to: [NodeName] → [PortLabel]" badge instead of the input field, with a small "unlink" button
- If not wired: show the normal editable field as today

#### `App.tsx` — Connection handling

1. Use `getEffectivePorts()` when building the `isValidConnection` callback so arg-ports and implicit outputs participate in connection validation
2. When an edge connects to an `arg:<key>` port, optionally clear the manual `argValues[key]` (or keep it as fallback — TBD)
3. Update `toGraph()` to include edges that reference arg-port IDs

#### `App.tsx` — Pass connection info to ZyraNode

ZyraNode needs to know which of its arg-ports are connected so it can show the linked state. Pass a `connectedArgPorts: Set<string>` via node data (derived from the edges array).

### E. Implementation Order

1. **Core: Add `argToPort`, `getImplicitOutputs`, `getEffectivePorts`** to `packages/core/src/manifest.ts` and export them. Add the `implicit` and `argKey` fields to `PortDef`. Update the barrel export.

2. **ZyraNode: Render arg-ports as handles** — Use `getEffectivePorts()` to get the full port list. Add expand/collapse state. Render Handle components for visible arg-ports with the `arg:<key>` ID.

3. **App.tsx: Update connection validation** — Use `getEffectivePorts()` in `isValidConnection` so connections to arg-ports are accepted. Pass `connectedArgPorts` set into ZyraNode data.

4. **ZyraNode: Linked state rendering** — When an arg-port is connected, show "linked" indicator instead of value. Style the port handle differently for connected vs. unconnected arg-ports.

5. **NodeDetailPanel: Read-only linked args** — In the Settings tab, show linked badge for wired args.

6. **Implicit output ports** — Add stdout/stderr/exitcode output ports to nodes. Show them in expand mode or when connected.

7. **Serialization update** — Update `graphToPipeline()` to handle arg-port edges (dependency tracking, arg references).

### F. What This Does NOT Change

- The manifest format from the server — no server changes needed (arg-ports are generated client-side)
- Existing explicit ports — they continue to work exactly as before
- Existing saved pipelines — backward compatible (no arg-port edges in old files)
- Execution flow — the runtime doesn't need changes initially (wired args are a visual/editing concept; values still get serialized into the `args` object)
