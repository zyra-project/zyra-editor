"""
zyra-editor server — mounts the Zyra API and serves the React editor.

Usage:
    uvicorn server.main:app --port 8765
"""

from pathlib import Path

from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from zyra.api.server import create_app

app = create_app()

# Allow the Vite dev server during development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve the built React editor in production
STATIC_DIR = Path(__file__).parent.parent / "packages" / "editor" / "dist"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
