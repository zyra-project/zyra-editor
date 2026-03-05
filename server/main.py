"""
zyra-editor serve — lightweight bridge between the zyra CLI and the React editor.

Usage:
    uvicorn server.main:app --port 8765
    # or: zyra-editor serve (once packaged)
"""

import json
import shutil
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="zyra-editor")

STATIC_DIR = Path(__file__).parent.parent / "packages" / "editor" / "dist"


@app.get("/api/manifest")
def get_manifest():
    """
    Proxy `zyra manifest --json` from the locally installed zyra CLI.
    Falls back to a bundled example manifest if zyra is not on PATH.
    """
    zyra_bin = shutil.which("zyra")
    if zyra_bin is None:
        # Serve the bundled example so the editor still works without zyra
        example = Path(__file__).parent.parent / "manifest.example.json"
        if example.exists():
            return json.loads(example.read_text())
        raise HTTPException(
            status_code=503,
            detail="zyra CLI not found on PATH and no example manifest bundled",
        )

    try:
        result = subprocess.run(
            [zyra_bin, "manifest", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="zyra manifest timed out")

    if result.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=f"zyra manifest failed: {result.stderr.strip()}",
        )

    return json.loads(result.stdout)


# Serve the built React app (production mode)
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
