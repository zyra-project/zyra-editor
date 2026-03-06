# Zyra Editor

A manifest-driven visual node editor for orchestrating data processing pipelines. Design computational workflows by connecting nodes that represent CLI commands, then export the graphs as structured pipeline definitions.

## Architecture

This is a TypeScript monorepo (pnpm workspaces) with three components:

| Component | Path | Description |
|-----------|------|-------------|
| **@zyra/core** | `packages/core` | Zero-dependency library for graph types, port compatibility checks, and pipeline serialization |
| **@zyra/editor** | `packages/editor` | React + Vite visual node editor UI built on [XYFlow](https://www.xyflow.com/) (React Flow) |
| **Server** | `server` | FastAPI backend that mounts the Zyra API (manifest, CLI execution, job tracking, WebSocket log streaming) |

## Features

- **Drag-and-drop pipeline design** — add stages from the palette, connect typed ports, configure arguments
- **Type-safe connections** — output/input ports are validated by type; `any` acts as a wildcard
- **Pipeline execution** — run the full pipeline via Zyra's async job API with dependency-aware scheduling
- **Dry-run preview** — validate each stage without executing; shows resolved CLI commands per node
- **Real-time log streaming** — per-node stdout/stderr streamed via WebSocket with polling fallback
- **Execution status badges** — each node shows queued/running/succeeded/failed/canceled state
- **Pipeline export** — graphs are topologically sorted and serialized to a `pipeline.yaml` format
- **Manifest-driven** — available stages, ports, and arguments are defined in a JSON manifest loaded at runtime
- **Offline-capable** — falls back to a bundled mock manifest when the backend is unavailable

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, XYFlow (React Flow)
- **Backend:** FastAPI, Uvicorn, Python 3.11
- **Containers:** Docker Compose (two-service stack)
- **Tooling:** pnpm, Node 18+

## Getting Started

### Docker (recommended)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine with Compose.

```bash
docker compose up --build
```

| Service | URL | Description |
|---------|-----|-------------|
| Editor | http://localhost:5173 | Vite dev server (React UI) |
| Server | http://localhost:8765 | FastAPI backend (API, WebSocket, jobs) |

The `_work/` directory is mounted into the server container at `/data` for persistent job data (downloads, outputs).

> **Why Docker?** The server container uses Linux ffmpeg, which supports glob patterns required for video composition. Windows ffmpeg does not include glob support.

### Local Development

Requires Node.js 18+, pnpm, and Python 3.11+.

```bash
# Install JavaScript dependencies
pnpm install

# Build @zyra/core (required before first run)
pnpm build

# Start the editor dev server (Vite on port 5173)
pnpm dev
```

To run the backend (optional — the editor works with mock data without it):

```bash
cd server
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8765
```

The Vite dev server proxies `/v1` and `/ws` requests to `localhost:8765`. Set `VITE_BACKEND_URL` to override the backend target (e.g., `http://zyra-server:8765` in Docker).

### Build

```bash
pnpm build
```

This compiles `@zyra/core` (tsc) then builds `@zyra/editor` (Vite). Output goes to `packages/editor/dist/`, which the FastAPI server can serve as static files.

### Type Checking

```bash
pnpm typecheck
```

## Project Structure

```
zyra-editor/
├── packages/
│   ├── core/           # Graph types, port compatibility, pipeline serialization, execution types
│   │   └── src/
│   │       ├── types.ts
│   │       ├── ports.ts
│   │       ├── serializer.ts
│   │       ├── execution.ts    # Run/job types, NodeRunState, STATUS_COLORS
│   │       └── pipeline.ts     # graphToRunRequests() — graph → API requests
│   └── editor/         # React visual editor
│       └── src/
│           ├── App.tsx            # Main canvas (React Flow) + execution wiring
│           ├── ZyraNode.tsx       # Custom node renderer with status badges
│           ├── NodePalette.tsx    # Left sidebar — available stages
│           ├── ArgPanel.tsx       # Right sidebar — argument editing
│           ├── ManifestLoader.tsx # Manifest context provider
│           ├── Toolbar.tsx        # Dry Run / Run / Cancel / Clear buttons
│           ├── LogPanel.tsx       # Bottom panel — per-node log tabs
│           ├── useExecution.ts    # Execution orchestration hook
│           └── api.ts             # Zyra API client (fetch + WebSocket)
├── server/
│   ├── main.py          # Mounts zyra.api.server; serves editor build
│   ├── Dockerfile       # Python 3.11 + Linux ffmpeg
│   └── requirements.txt
├── docker-compose.yml   # Editor + server containers
├── Dockerfile.editor    # Node 20 + pnpm + Vite dev server
├── manifest.schema.json
└── pnpm-workspace.yaml
```

## License

This project is licensed under the [Apache License 2.0](LICENSE).
