"""
zyra-editor server — mounts the Zyra API and serves the React editor.

Usage:
    uvicorn main:app --port 8765
"""

import json
import os
import subprocess
from pathlib import Path

# Ensure a sane default logging verbosity for CLI jobs so the editor can
# still stream useful log messages through the WebSocket log panel, while
# allowing environments to opt into more verbose levels (e.g., debug).
os.environ.setdefault("ZYRA_VERBOSITY", "info")

import logging
import requests as http_requests
from fastapi import HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware
from zyra.api.server import create_app
from zyra.api.workers import jobs as _jobs_mod

# Monkey-patch start_job so that logging handlers are reset inside the
# captured-stdio context.  Without this, logging.basicConfig() (called
# during server startup) installs a StreamHandler that points to the
# *original* sys.stderr.  When start_job swaps stderr for _LocalPubTee,
# log messages still go to the original file descriptor and never reach
# the WebSocket.  By clearing handlers just before cli_main(), the CLI's
# configure_logging_from_env() call creates a fresh handler that writes
# to the tee.
_orig_start_job = _jobs_mod.start_job
_zyra_cli = None
_orig_cli_main = None


def _cli_main_with_logging_reset(argv):
    """
    Wrapper around zyra.cli.main that clears and restores logging handlers
    so that handlers created by the CLI write to the swapped stderr tee.
    """
    root = logging.getLogger()
    # Save existing handlers so we can restore them after the CLI run
    prev_handlers = list(root.handlers)
    try:
        # Clear existing handlers so basicConfig creates new ones on
        # the swapped sys.stderr (the _LocalPubTee)
        root.handlers.clear()
        return _orig_cli_main(argv)
    finally:
        # Close any handlers added during the CLI run, then restore
        # the original handler list
        for handler in root.handlers:
            if handler not in prev_handlers:
                try:
                    handler.close()
                except Exception:
                    pass
        root.handlers[:] = prev_handlers


def _ensure_cli_wrapper_installed():
    """
    Lazily install the logging-reset wrapper around zyra.cli.main once.

    This avoids per-call global swapping and does not serialize job starts.
    """
    global _zyra_cli, _orig_cli_main
    if _orig_cli_main is not None:
        return
    try:
        import zyra.cli as cli_mod
    except Exception:
        return
    main = getattr(cli_mod, "main", None)
    if main is None:
        return
    _zyra_cli = cli_mod
    _orig_cli_main = main
    cli_mod.main = _cli_main_with_logging_reset


def _patched_start_job(*args, **kwargs):
    """Wrap start_job to ensure zyra.cli.main uses the logging-reset wrapper."""
    _ensure_cli_wrapper_installed()
    return _orig_start_job(*args, **kwargs)


_jobs_mod.start_job = _patched_start_job

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
    "control": "#888888",
    "search": "#1E90FF",
    "acquire": "#00529E",
    "process": "#2C670C",
    "visualize": "#7B2D8E",
    "narrate": "#7B2D8E",
    "verify": "#555555",
    "export": "#B8860B",
    "decide": "#C04000",
    "simulate": "#C04000",
}
DEFAULT_COLOR = "#666666"

# ── Infer ports from stage category ─────────────────────────────────
STAGE_INPUTS: dict[str, list[dict]] = {
    "control": [],
    "acquire": [],
    "search": [],
}
DEFAULT_INPUTS = [{"id": "file", "label": "Input File", "types": ["any"]}]
DEFAULT_OUTPUTS = [{"id": "file", "label": "Output File", "types": ["any"]}]
SINK_STAGES = {"export", "verify"}


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


# Stages that should not appear as editor nodes (handled by the editor UI itself)
HIDDEN_STAGES: set[str] = {"run"}

# Stages still under development — shown in the palette but not usable
WIP_STAGES: set[str] = {"decide", "simulate"}

# Map deprecated / alias stage names to canonical stage names
STAGE_ALIASES: dict[str, str] = {
    "decimate": "export",
    "disseminate": "export",
    "distribute": "export",
    "import": "acquire",
    "transform": "process",
    "render": "visualize",
    "optimize": "decide",
    "enrich": "search",
}


def _commands_to_manifest(commands: dict) -> dict:
    """Transform /v1/commands response into the editor Manifest shape."""
    stages = []
    seen: set[tuple[str, str]] = set()
    for cmd_key, cmd_info in commands.items():
        parts = cmd_key.split(" ", 1)
        raw_stage = parts[0]
        stage = STAGE_ALIASES.get(raw_stage, raw_stage)
        command = parts[1] if len(parts) > 1 else raw_stage

        # Skip stages handled by the editor UI (e.g. "run" → toolbar button)
        if stage in HIDDEN_STAGES:
            continue

        # Only include commands whose raw name matches the canonical stage
        # (skip aliased duplicates like "import ftp" when "acquire ftp" exists)
        if raw_stage != stage:
            continue

        # Deduplicate by (stage, command)
        key = (stage, command)
        if key in seen:
            continue
        seen.add(key)

        args = []
        for flag, info in (cmd_info.get("options") or {}).items():
            arg = _opt_to_arg(flag, info)
            if arg:
                args.append(arg)

        inputs = STAGE_INPUTS.get(stage, DEFAULT_INPUTS)
        outputs = [] if stage in SINK_STAGES else DEFAULT_OUTPUTS

        # Extract command-level description (the CLI "help" text)
        description = ""
        if isinstance(cmd_info, dict):
            description = cmd_info.get("description", "") or cmd_info.get("help", "") or ""

        entry: dict = {
            "stage": stage,
            "command": command,
            "label": cmd_key.replace("-", " ").title(),
            "cli": f"zyra {cmd_key}",
            "status": "planned" if stage in WIP_STAGES else "implemented",
            "color": STAGE_COLORS.get(stage, DEFAULT_COLOR),
            "inputs": inputs,
            "outputs": outputs,
            "args": args,
        }
        if description:
            entry["description"] = description
        stages.append(entry)

    # Inject editor-only control nodes (not backed by CLI commands)
    stages.insert(0, {
        "stage": "control",
        "command": "variable",
        "label": "Variable",
        "description": "Define a named variable to pass values into the pipeline",
        "cli": "",
        "status": "implemented",
        "color": STAGE_COLORS.get("control", DEFAULT_COLOR),
        "inputs": [],
        "outputs": [{"id": "value", "label": "Value", "types": ["any"]}],
        "args": [
            {
                "key": "name",
                "label": "Name",
                "type": "string",
                "required": True,
                "placeholder": "my_var",
                "description": "Variable name",
            },
            {
                "key": "value",
                "label": "Value",
                "type": "string",
                "required": True,
                "placeholder": "...",
                "description": "The value to pass downstream",
            },
        ],
    })

    return {"version": "1.0", "stages": stages}


# ── AI Planner endpoint ──────────────────────────────────────────


class PlanRequest(BaseModel):
    intent: str
    guardrails: str = ""


logger = logging.getLogger("zyra-editor.plan")


def _run_zyra_plan(intent: str, guardrails: str = "") -> dict:
    """Run ``zyra plan`` and return parsed JSON."""
    cmd = ["zyra", "plan", "--intent", intent, "--no-clarify"]
    if guardrails:
        cmd += ["--guardrails", guardrails]

    # Log the env vars visible to the subprocess so we can diagnose
    # missing LLM configuration without leaking secrets.
    has_openai = bool(os.environ.get("OPENAI_API_KEY"))
    has_ollama = bool(os.environ.get("OLLAMA_HOST"))
    logger.info(
        "Running zyra plan — OPENAI_API_KEY=%s, OLLAMA_HOST=%s",
        "set" if has_openai else "MISSING",
        os.environ.get("OLLAMA_HOST", "MISSING"),
    )
    logger.debug("zyra plan command: %s", cmd)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail="zyra CLI is not installed in the server environment",
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="zyra plan timed out")

    logger.info("zyra plan exit code: %d", result.returncode)
    if result.stderr:
        logger.info("zyra plan stderr:\n%s", result.stderr[:2000])
    if result.stdout:
        logger.debug("zyra plan stdout:\n%s", result.stdout[:2000])

    if result.returncode != 0:
        raise HTTPException(status_code=400, detail=result.stderr.strip())
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=502,
            detail=f"zyra plan returned invalid JSON: {result.stdout[:500]}",
        )


@app.get("/v1/plan/debug")
async def plan_debug():
    """Diagnostic endpoint — reports zyra CLI version and LLM configuration."""
    info: dict = {
        "openai_api_key": "set" if os.environ.get("OPENAI_API_KEY") else "missing",
        "ollama_host": os.environ.get("OLLAMA_HOST", "not set"),
        "zyra_verbosity": os.environ.get("ZYRA_VERBOSITY", "default"),
    }

    # zyra version
    try:
        ver = subprocess.run(
            ["zyra", "--version"], capture_output=True, text=True, timeout=10
        )
        info["zyra_version"] = ver.stdout.strip() or ver.stderr.strip()
    except FileNotFoundError:
        info["zyra_version"] = "NOT INSTALLED"
    except Exception as exc:
        info["zyra_version"] = f"error: {exc}"

    # Quick dry-run: ask zyra plan for a trivial intent to see what happens
    try:
        test = subprocess.run(
            ["zyra", "plan", "--intent", "test", "--no-clarify"],
            capture_output=True, text=True, timeout=30,
        )
        info["test_plan"] = {
            "exit_code": test.returncode,
            "stdout_preview": test.stdout[:500],
            "stderr_preview": test.stderr[:500],
        }
    except Exception as exc:
        info["test_plan"] = {"error": str(exc)}

    return info


@app.post("/v1/plan")
async def generate_plan(body: PlanRequest):
    """Run ``zyra plan`` as a subprocess and return the structured plan JSON."""
    return _run_zyra_plan(body.intent, body.guardrails)


class PlanRefineRequest(BaseModel):
    intent: str
    feedback: str
    current_plan: dict = {}
    guardrails: str = ""


@app.post("/v1/plan/refine")
async def refine_plan(body: PlanRefineRequest):
    """Re-run ``zyra plan`` with the original intent augmented by user feedback
    and a summary of the current plan so the LLM can course-correct."""
    # Build a context-enriched intent that includes what was generated and
    # what the user wants changed.
    steps_summary = ""
    agents = body.current_plan.get("agents", [])
    if agents:
        lines = []
        for a in agents:
            lines.append(f"  - {a.get('id', '?')}: {a.get('stage', '?')}/{a.get('command', '?')}")
        steps_summary = "\nCurrent plan steps:\n" + "\n".join(lines)

    refined_intent = (
        f"{body.intent}\n\n"
        f"[User feedback on the previous plan: {body.feedback}]"
        f"{steps_summary}\n\n"
        f"Please regenerate the plan incorporating the feedback above."
    )

    return _run_zyra_plan(refined_intent, body.guardrails)



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
