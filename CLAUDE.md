# Project Guidelines

## DCO Sign-off

This project enforces DCO (Developer Certificate of Origin). All commits must be signed off with:

- **Name:** Eric Hackathorn
- **Email:** Eric.J.Hackathorn@noaa.gov

Use `--signoff` and `--author="Eric Hackathorn <Eric.J.Hackathorn@noaa.gov>"` on all commits.

## Project Overview

Zyra Editor is a manifest-driven visual node editor for orchestrating data processing pipelines. Users connect nodes representing CLI commands into a graph, then export it as a structured pipeline definition.

## Monorepo Structure

This is a pnpm workspace monorepo (`pnpm-workspace.yaml` → `packages/*`).

| Package | Path | Description |
|---------|------|-------------|
| `@zyra/core` | `packages/core/` | Zero-dependency TypeScript library — graph types, port compatibility, pipeline serialization |
| `@zyra/editor` | `packages/editor/` | React 18 + Vite visual editor UI using XYFlow (React Flow) |
| Server | `server/` | FastAPI (Python) backend — proxies `zyra manifest --json` CLI |

## Key Source Files

### @zyra/core (`packages/core/src/`)
- `types.ts` — Core interfaces: `Manifest`, `StageDef`, `PortDef`, `ArgDef`, `Graph`, `GraphNode`, `GraphEdge`
- `ports.ts` — `portsCompatible()` — validates type-compatible port connections
- `serialise.ts` — `graphToPipeline()` — topological sort → pipeline.yaml format

### @zyra/editor (`packages/editor/src/`)
- `App.tsx` — Main React Flow canvas; manages nodes, edges, selection state
- `ZyraNode.tsx` — Custom node component rendering input/output ports
- `NodePalette.tsx` — Left sidebar listing available stages grouped by category
- `ArgPanel.tsx` — Right sidebar for editing selected node's arguments
- `ManifestLoader.tsx` — React context provider; fetches manifest from `/api/manifest`
- `mock-manifest.ts` — Fallback manifest with 8 example stages (used when backend unavailable)

### Server (`server/`)
- `main.py` — FastAPI app with `GET /api/manifest`; serves static editor build in production

## Common Commands

```bash
# Install dependencies
pnpm install

# Development (editor on :5173, proxies /api → :8765)
pnpm dev

# Build all packages (@zyra/core first, then @zyra/editor)
pnpm build

# Type checking across all packages
pnpm typecheck

# Run backend server (optional)
cd server && uvicorn server.main:app --port 8765
```

## Tech Stack

- **Frontend:** React 18, TypeScript 5.4, Vite 5.4, @xyflow/react 12
- **Backend:** FastAPI, Uvicorn, Python 3
- **Monorepo:** pnpm workspaces, Node 18+
- **No test framework configured yet**

## Conventions

- ESM throughout (`"type": "module"` in all package.json files)
- TypeScript strict mode
- `@zyra/editor` depends on `@zyra/core` via `workspace:*`
- Inline React styles with dark theme (`#0d1117` background)
- Vite dev server proxies `/api` → `http://localhost:8765`
- `lint` and `typecheck` scripts both run `tsc --noEmit`
