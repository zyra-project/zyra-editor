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
| Server | `server/` | FastAPI (Python) backend — proxies the `zyra` CLI, runs async jobs, streams logs via WebSocket |

## Key Source Files

### @zyra/core (`packages/core/src/`)
- `types.ts` — Core interfaces: `Manifest`, `StageDef`, `PortDef`, `ArgDef`, `Graph`, `GraphNode`, `GraphEdge`
- `ports.ts` — `portsCompatible()` — validates type-compatible port connections
- `serialise.ts` — `graphToPipeline()` — topological sort → pipeline.yaml format

### @zyra/editor (`packages/editor/src/`)
- `App.tsx` — Main React Flow canvas; manages nodes, edges, selection state
- `ZyraNode.tsx` — Custom node component rendering input/output ports (resizable via NodeResizer)
- `NodePalette.tsx` — Left sidebar listing available stages grouped by category
- `ArgPanel.tsx` — Right sidebar for editing selected node's arguments
- `ManifestLoader.tsx` — React context provider; fetches manifest from `/v1/manifest`
- `LogPanel.tsx` — Bottom panel showing per-node execution logs with running indicators
- `useExecution.ts` — Hook managing async job execution and WebSocket log streaming
- `mock-manifest.ts` — Fallback manifest (used when backend unavailable)

### Server (`server/`)
- `main.py` — FastAPI app with manifest, CLI execution, and WebSocket endpoints
- `Dockerfile` — Python 3.11 + Linux ffmpeg (required for glob pattern support)
- `requirements.txt` — FastAPI, Uvicorn, zyra[api], python-dateutil

### Docker
- `docker-compose.yml` — Root-level compose file running both services
- `Dockerfile.editor` — Node 20 + pnpm, builds @zyra/core, runs Vite dev server
- `server/Dockerfile` — Python 3.11-slim + ffmpeg
- `server/docker-compose.yml` — Server-only compose (for running server without editor container)

## Running the Project

### Docker (recommended)

```bash
# Start both editor and server containers
docker compose up --build

# Editor: http://localhost:5173
# Server: http://localhost:8765
```

The editor container proxies `/v1`, `/ws`, and `/health` to the server container via Docker networking (`zyra-server:8765`). The `_work/` directory is mounted into the server at `/data` for persistent job outputs.

To run only the server container:
```bash
cd server && docker compose up --build
```

### Local Development

```bash
# Install dependencies
pnpm install

# Start editor dev server (proxies to localhost:8765)
pnpm dev

# In another terminal, start the backend
cd server && uvicorn main:app --port 8765

# Build all packages (@zyra/core first, then @zyra/editor)
pnpm build

# Type checking across all packages
pnpm typecheck
```

## Tech Stack

- **Frontend:** React 18, TypeScript 5.4, Vite 5.4, @xyflow/react 12
- **Backend:** FastAPI, Uvicorn, Python 3.11
- **Containerization:** Docker (Linux ffmpeg for glob support, which Windows ffmpeg lacks)
- **Monorepo:** pnpm workspaces, Node 18+
- **No test framework configured yet**

## Conventions

- ESM throughout (`"type": "module"` in all package.json files)
- TypeScript strict mode
- `@zyra/editor` depends on `@zyra/core` via `workspace:*`
- Inline React styles with dark theme (`#0d1117` background)
- Vite dev server proxies `/v1` → backend, `/ws` → backend (WebSocket), `/health` → backend
- `VITE_BACKEND_URL` env var overrides backend target (defaults to `http://localhost:8765`)
- `lint` and `typecheck` scripts both run `tsc --noEmit`
