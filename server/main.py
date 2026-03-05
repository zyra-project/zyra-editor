"""
zyra-editor server — mounts the Zyra API and serves the React editor.

Usage:
    uvicorn main:app --port 8765
"""

from pathlib import Path

import requests as http_requests
from fastapi import Request
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

# ── Stage colours (keyed by the first word of the command key) ───────
STAGE_COLORS: dict[str, str] = {
    "acquire": "#00529E",
    "import": "#00529E",
    "process": "#2C670C",
    "transform": "#2C670C",
    "visualize": "#7B2D8E",
    "render": "#7B2D8E",
    "narrate": "#7B2D8E",
    "disseminate": "#B8860B",
    "distribute": "#B8860B",
    "export": "#B8860B",
    "decimate": "#B8860B",
    "decide": "#C04000",
    "optimize": "#C04000",
    "simulate": "#C04000",
    "verify": "#555555",
    "search": "#1E90FF",
    "enrich": "#1E90FF",
}
DEFAULT_COLOR = "#666666"

# ── Infer ports from stage category ─────────────────────────────────
STAGE_INPUTS: dict[str, list[dict]] = {
    "acquire": [],
    "import": [],
    "search": [],
}
DEFAULT_INPUTS = [{"id": "file", "label": "Input File", "types": ["any"]}]
DEFAULT_OUTPUTS = [{"id": "file", "label": "Output File", "types": ["any"]}]
SINK_STAGES = {"disseminate", "distribute", "export", "decimate", "verify"}


def _opt_to_arg(flag: str, info) -> dict | None:
    """Convert a zyra CLI option to an ArgDef, or None to skip."""
    if flag == "--help":
        return None

    if isinstance(info, str):
        # Simple string description — no metadata
        return {
            "key": flag.lstrip("-").replace("-", "_"),
            "flag": flag,
            "label": flag.lstrip("-").replace("-", " ").title(),
            "type": "string",
            "required": False,
            "description": info,
        }

    help_text = info.get("help", "")
    choices = info.get("choices")
    typ = info.get("type", "str")
    default = info.get("default")
    path_arg = info.get("path_arg", False)

    if choices:
        arg_type = "enum"
    elif path_arg or typ == "path":
        arg_type = "filepath"
    elif typ in ("int", "float"):
        arg_type = "number"
    elif typ == "bool":
        arg_type = "boolean"
    else:
        arg_type = "string"

    arg: dict = {
        "key": flag.lstrip("-").replace("-", "_"),
        "flag": flag,
        "label": flag.lstrip("-").replace("-", " ").title(),
        "type": arg_type,
        "required": False,
        "description": help_text,
    }
    if default is not None:
        arg["default"] = default
    if choices:
        arg["options"] = choices
    return arg


def _commands_to_manifest(commands: dict) -> dict:
    """Transform /v1/commands response into the editor Manifest shape."""
    stages = []
    for cmd_key, cmd_info in commands.items():
        parts = cmd_key.split(" ", 1)
        stage = parts[0]
        command = parts[1] if len(parts) > 1 else stage

        args = []
        for flag, info in (cmd_info.get("options") or {}).items():
            arg = _opt_to_arg(flag, info)
            if arg:
                args.append(arg)

        inputs = STAGE_INPUTS.get(stage, DEFAULT_INPUTS)
        outputs = [] if stage in SINK_STAGES else DEFAULT_OUTPUTS

        stages.append({
            "stage": stage,
            "command": command,
            "label": cmd_key.replace("-", " ").title(),
            "cli": f"zyra {cmd_key}",
            "status": "implemented",
            "color": STAGE_COLORS.get(stage, DEFAULT_COLOR),
            "inputs": inputs,
            "outputs": outputs,
            "args": args,
        })

    return {"version": "1.0", "stages": stages}


@app.get("/v1/manifest")
def get_manifest(request: Request):
    """Adapt /v1/commands into the Manifest shape the editor expects."""
    # Call our own /v1/commands endpoint internally
    base = str(request.base_url).rstrip("/")
    resp = http_requests.get(f"{base}/v1/commands", timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return _commands_to_manifest(data.get("commands", {}))


# Serve the built React editor in production
STATIC_DIR = Path(__file__).parent.parent / "packages" / "editor" / "dist"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
