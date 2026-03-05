# Zyra Editor

A manifest-driven visual node editor for orchestrating data processing pipelines. Design computational workflows by connecting nodes that represent CLI commands, then export the graphs as structured pipeline definitions.

## Architecture

This is a TypeScript monorepo (pnpm workspaces) with three components:

| Component | Path | Description |
|-----------|------|-------------|
| **@zyra/core** | `packages/core` | Zero-dependency library for graph types, port compatibility checks, and pipeline serialization |
| **@zyra/editor** | `packages/editor` | React + Vite visual node editor UI built on [XYFlow](https://www.xyflow.com/) (React Flow) |
| **Server** | `server` | FastAPI backend that proxies the `zyra manifest --json` CLI command |

## Features

- **Drag-and-drop pipeline design** — add stages from the palette, connect typed ports, configure arguments
- **Type-safe connections** — output/input ports are validated by type; `any` acts as a wildcard
- **Pipeline export** — graphs are topologically sorted and serialized to a `pipeline.yaml` format
- **Manifest-driven** — available stages, ports, and arguments are defined in a JSON manifest loaded at runtime
- **Offline-capable** — falls back to a bundled mock manifest when the backend is unavailable

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, XYFlow (React Flow)
- **Backend:** FastAPI, Uvicorn, Python 3
- **Tooling:** pnpm, Node 18+

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm
- Python 3 (for the backend server)

### Install & Run

```bash
# Install JavaScript dependencies
pnpm install

# Start the editor dev server (Vite on port 5173)
pnpm dev
```

To run the backend (optional — the editor works with mock data without it):

```bash
cd server
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server.main:app --port 8765
```

The Vite dev server proxies `/api` requests to `localhost:8765`.

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
│   ├── core/           # Graph types, port compatibility, pipeline serialization
│   │   └── src/
│   │       ├── types.ts
│   │       ├── ports.ts
│   │       └── serialise.ts
│   └── editor/         # React visual editor
│       └── src/
│           ├── App.tsx            # Main canvas (React Flow)
│           ├── ZyraNode.tsx       # Custom node renderer
│           ├── NodePalette.tsx    # Left sidebar — available stages
│           ├── ArgPanel.tsx       # Right sidebar — argument editing
│           └── ManifestLoader.tsx # Manifest context provider
├── server/
│   └── main.py         # FastAPI proxy for zyra CLI
├── manifest.schema.json
└── pnpm-workspace.yaml
```
