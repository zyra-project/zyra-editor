"""
zyra-editor server — mounts the Zyra API and serves the React editor.

Usage:
    uvicorn main:app --port 8765
"""

import asyncio
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Load .env file from the server directory (or project root) so that
# secret values can be configured without polluting the system env.
_env_file = Path(__file__).parent / ".env"
if not _env_file.exists():
    _env_file = Path(__file__).parent.parent / ".env"
if _env_file.exists():
    try:
        _env_content = _env_file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        _env_content = None
    if _env_content is not None:
        for line in _env_content.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # Allow optional leading 'export ' (must be followed by whitespace)
            if line.startswith("export ") or line.startswith("export\t"):
                line = line[6:].lstrip()
            if "=" not in line:
                continue
            key, _, raw_val = line.partition("=")
            key = key.strip()
            raw_val = raw_val.strip()
            # Strip inline comments when not inside quotes
            in_single = False
            in_double = False
            val_chars: list[str] = []
            for ch in raw_val:
                if ch == "'" and not in_double:
                    in_single = not in_single
                elif ch == '"' and not in_single:
                    in_double = not in_double
                if ch == "#" and not in_single and not in_double:
                    break
                val_chars.append(ch)
            val = "".join(val_chars).strip().strip("'\"")
            if key:
                os.environ.setdefault(key, val)

# Ensure a sane default logging verbosity for CLI jobs so the editor can
# still stream useful log messages through the WebSocket log panel, while
# allowing environments to opt into more verbose levels (e.g., debug).
os.environ.setdefault("ZYRA_VERBOSITY", "info")

import logging
import requests as http_requests
from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.cors import CORSMiddleware
from zyra.api.server import create_app
from zyra.api.workers import jobs as _jobs_mod

from run_history import init_db, save_run, list_runs, get_run, delete_run, lookup_cache

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


_ENV_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


_log = logging.getLogger("zyra-editor")


_warned_env_vars: set[str] = set()


def _resolve_env_vars(value: str) -> str:
    """Replace ${VAR_NAME} references with values from os.environ.

    Unresolved references are left as-is (the CLI will see the literal
    string, which is preferable to silently dropping the value).
    """
    def _replace(m: re.Match) -> str:
        name = m.group(1)
        resolved = os.environ.get(name)
        if resolved is None:
            if name not in _warned_env_vars:
                _warned_env_vars.add(name)
                _log.warning(
                    "Secret variable ${%s} is not set in the environment. "
                    "Add it to server/.env or export it before starting the server.",
                    name,
                )
            return m.group(0)
        return resolved
    return _ENV_VAR_RE.sub(_replace, value)


def _resolve_argv_env_vars(argv: list[str]) -> list[str]:
    """Resolve ${VAR} env-var references in argv entries.

    Only performs substitution when the entire argument is a single ${VAR}
    placeholder (full-string match).  This avoids rewriting arbitrary user
    arguments (e.g. shell templates) that merely contain a ${VAR} substring.
    """
    resolved: list[str] = []
    for a in argv:
        m = _ENV_VAR_RE.fullmatch(a)
        if m:
            resolved.append(_resolve_env_vars(a))
        else:
            resolved.append(a)
    return resolved


class _BytesBridge(io.RawIOBase):
    """Binary wrapper that encodes writes through a text-mode tee.

    zyra's ``_LocalPubTee`` replaces ``sys.stdout``/``sys.stderr`` with a
    ``StringIO``-based object that lacks the ``.buffer`` attribute real
    ``TextIOWrapper`` objects expose.  CLI commands that write binary data
    (e.g. ``process metadata``) access ``sys.stdout.buffer``, which fails
    with ``AttributeError`` on the tee.

    This bridge is attached as ``.buffer`` on each tee so those binary
    writes are decoded and forwarded through the tee's normal text path.
    """

    def __init__(self, text_tee):
        super().__init__()
        self._tee = text_tee

    def writable(self):
        return True

    def write(self, b):
        if not b:
            return 0
        text = b.decode("utf-8", errors="replace") if isinstance(b, (bytes, bytearray)) else str(b)
        self._tee.write(text)
        return len(b)


def _ensure_tee_has_buffer():
    """Patch ``sys.stdout``/``sys.stderr`` with a ``.buffer`` attribute
    if they are ``_LocalPubTee`` instances (``StringIO`` subclass) that
    lack one.  This is a no-op when stdout/stderr are normal streams."""
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        # Only patch StringIO-based tees that are missing .buffer
        if isinstance(stream, io.StringIO) and not hasattr(stream, "buffer"):
            stream.buffer = _BytesBridge(stream)


def _cli_main_with_logging_reset(argv):
    """
    Wrapper around zyra.cli.main that clears and restores logging handlers
    so that handlers created by the CLI write to the swapped stderr tee.
    Also resolves ${VAR_NAME} env-var references in argv so that secret
    variable nodes work without embedding plaintext in the pipeline YAML.
    """
    argv = _resolve_argv_env_vars(argv)
    # Ensure the _LocalPubTee streams have a .buffer for binary I/O
    _ensure_tee_has_buffer()
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

# Initialise the run-history SQLite database.
_history_db = init_db()

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
    if help_text:
        arg["placeholder"] = help_text
    if default is not None:
        arg["default"] = default
    if choices:
        arg["options"] = choices
    return arg


def _positional_to_arg(pos: dict) -> dict | None:
    """Convert a zyra CLI positional arg to an ArgDef."""
    name = pos.get("name", "")
    if not name:
        return None

    help_text = pos.get("help", "")
    typ = pos.get("type", "str")
    required = pos.get("required", False)
    default = pos.get("default")
    choices = pos.get("choices")

    if choices:
        arg_type = "enum"
    elif typ in ("int", "float"):
        arg_type = "number"
    elif typ == "bool":
        arg_type = "boolean"
    elif typ == "path":
        arg_type = "filepath"
    else:
        arg_type = "string"

    arg: dict = {
        "key": name,
        "label": name.replace("_", " ").replace("-", " ").title(),
        "type": arg_type,
        "required": bool(required),
        "description": help_text,
    }
    if default is not None:
        arg["default"] = default
    if help_text:
        arg["placeholder"] = help_text
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
        # Positional arguments (name, help, type, required)
        for pos in (cmd_info.get("positionals") or []):
            if isinstance(pos, dict):
                arg = _positional_to_arg(pos)
                if arg:
                    args.append(arg)
        # Named options / flags
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
        "command": "secret",
        "label": "Secret",
        "description": "A secret value (API key, password) stored as an environment variable",
        "cli": "",
        "status": "implemented",
        "color": STAGE_COLORS.get("control", DEFAULT_COLOR),
        "inputs": [],
        "outputs": [{"id": "value", "label": "Value", "types": ["string"]}],
        "args": [
            {
                "key": "name",
                "label": "Name",
                "type": "string",
                "required": True,
                "placeholder": "API_KEY",
                "description": "Environment variable name (used as ${NAME} in pipeline)",
            },
            {
                "key": "value",
                "label": "Value",
                "type": "string",
                "required": True,
                "placeholder": "••••••••",
                "description": "Secret value (never written to pipeline YAML)",
            },
            {
                "key": "description",
                "label": "Description",
                "type": "string",
                "required": False,
                "placeholder": "API key for external service",
                "description": "Optional description of what this secret is for",
            },
        ],
    })

    return {"version": "1.0", "stages": stages}


# ── AI Planner endpoint ──────────────────────────────────────────


class PlanRequest(BaseModel):
    intent: str
    guardrails: str = ""


logger = logging.getLogger("zyra-editor.plan")

# Scope instruction appended to the intent so the LLM generates only
# the steps the user actually asked for.  Override or disable via the
# ZYRA_PLAN_SCOPE env var (set to empty string to disable).
_DEFAULT_PLAN_SCOPE = (
    "\n\nIMPORTANT: Before generating agents, first identify which zyra "
    "stages (e.g. acquire, process, visualize, narrate, verify, compose) "
    "are actually required to fulfill this request. Then generate agents "
    "ONLY from those stages. Do NOT include agents from stages the user "
    "did not ask for. For example, if the user asks to download data, "
    "only use 'acquire' stage agents — do not add 'visualize', 'narrate', "
    "or 'compose' stages unless explicitly requested."
)
PLAN_SCOPE = os.environ.get("ZYRA_PLAN_SCOPE", _DEFAULT_PLAN_SCOPE)


def _apply_scope(intent: str) -> str:
    """Append the scope instruction to the intent if configured."""
    if PLAN_SCOPE:
        return intent + PLAN_SCOPE
    return intent


def _run_zyra_plan(intent: str, guardrails: str = "") -> dict:
    """Run ``zyra plan`` and return parsed JSON."""
    scoped_intent = _apply_scope(intent)
    cmd = ["zyra", "plan", "--intent", scoped_intent, "--no-clarify"]
    if guardrails:
        cmd += ["--guardrails", guardrails]

    # Log the env vars visible to the subprocess so we can diagnose
    # missing LLM configuration without leaking secrets.
    has_openai = bool(os.environ.get("OPENAI_API_KEY"))
    has_ollama = bool(os.environ.get("OLLAMA_HOST"))
    logger.info(
        "Running zyra plan — OPENAI_API_KEY=%s, OLLAMA_HOST=%s",
        "set" if has_openai else "MISSING",
        "set" if has_ollama else "MISSING",
    )
    logger.info("zyra plan intent: %.200s", intent)
    if guardrails:
        logger.info("zyra plan guardrails: %.200s", guardrails)
    logger.debug("zyra plan full command: %s", cmd)

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
        stderr_text = (result.stderr or "").strip()
        if len(stderr_text) > 1000:
            stderr_text = f"...(truncated)...\n{stderr_text[-1000:]}"
        raise HTTPException(status_code=400, detail=stderr_text)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=502,
            detail=f"zyra plan returned invalid JSON: {result.stdout[:500]}",
        )

    # Flag when no LLM backend is configured — the plan may be a template
    if not has_openai and not has_ollama:
        data["_warning"] = (
            "No LLM backend configured (OPENAI_API_KEY and OLLAMA_HOST are both missing). "
            "The plan may be a static template. Set one of these in your .env file."
        )

    return data


_DEBUG_ENABLED = os.environ.get("ZYRA_DEBUG_ENDPOINTS", "").lower() in ("1", "true", "yes")


@app.get("/v1/plan/debug")
async def plan_debug():
    """Diagnostic endpoint — reports zyra CLI version and LLM configuration.

    Gated behind ZYRA_DEBUG_ENDPOINTS=1 env var to prevent exposure of
    runtime configuration and costly LLM calls in production.
    """
    if not _DEBUG_ENABLED:
        raise HTTPException(status_code=404, detail="Debug endpoint disabled")

    def _collect_debug_info() -> dict:
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

    return await asyncio.to_thread(_collect_debug_info)


@app.post("/v1/plan")
async def generate_plan(body: PlanRequest):
    """Run ``zyra plan`` as a subprocess and return the structured plan JSON."""
    return await asyncio.to_thread(_run_zyra_plan, body.intent, body.guardrails)


class PlanRefineRequest(BaseModel):
    intent: str
    feedback: str
    current_plan: dict = Field(default_factory=dict)
    guardrails: str = ""


@app.post("/v1/plan/refine")
async def refine_plan(body: PlanRefineRequest):
    """Re-run ``zyra plan`` keeping --intent clean and passing feedback
    context via --guardrails so the CLI's prompt template handles it properly."""
    # Build a concise, updated intent that incorporates the feedback directly
    # rather than appending meta-instructions to the intent string.
    refined_intent = f"{body.intent.strip()}. {body.feedback.strip()}"

    # Use --guardrails to provide structural context about what was wrong
    # with the previous plan, so the LLM can avoid repeating mistakes.
    guardrail_parts = []
    if body.guardrails:
        guardrail_parts.append(body.guardrails)

    agents = body.current_plan.get("agents", [])
    if agents:
        prev_commands = [
            f"{a.get('stage', '?')}/{a.get('command', '?')}" for a in agents
        ]
        guardrail_parts.append(
            f"Previous plan had these steps: {', '.join(prev_commands)}. "
            f"The user wants changes: {body.feedback.strip()}"
        )

    guardrails = "; ".join(guardrail_parts)

    return await asyncio.to_thread(_run_zyra_plan, refined_intent, guardrails)



# ── Feedback endpoint ─────────────────────────────────────────────

FEEDBACK_DIR = Path(os.environ.get("ZYRA_FEEDBACK_DIR", "/data/feedback"))


class FeedbackPayload(BaseModel):
    name: str = ""
    email: str = ""
    type: str = "question"
    message: str
    timestamp: str = ""
    userAgent: str = ""


@app.post("/v1/feedback")
async def submit_feedback(body: FeedbackPayload):
    """Save user feedback as a JSON file in the feedback directory."""
    FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
    ts = body.timestamp or __import__("datetime").datetime.utcnow().isoformat()
    safe_ts = re.sub(r"[^a-zA-Z0-9_-]", "_", ts)
    uid = __import__("uuid").uuid4().hex[:8]
    path = FEEDBACK_DIR / f"feedback_{safe_ts}_{uid}.json"
    payload = body.model_dump()
    payload["timestamp"] = ts
    path.write_text(json.dumps(payload, indent=2))
    logger.info("Feedback saved to %s", path)
    return {"status": "ok", "file": str(path)}


# ── Interactive planner via WebSocket ─────────────────────────────

WS_PLAN_TIMEOUT = 120  # seconds
WS_KEEPALIVE_INTERVAL = 15  # seconds

# Heuristic: lines that look like a question from the CLI
_QUESTION_SUFFIXES = ("?", "> ", "[y/n]", "[Y/n]", "[y/N]", "]: ", "): ")
_QUESTION_PATTERNS = re.compile(
    r"(?:^(?:Q\d|Question|\d+[\.\)]))"  # "Q1:", "Question:", "1." or "1)"
    r"|(?:please\s+(?:provide|specify|enter|choose|select|confirm|set|indicate))"  # polite prompts
    r"|(?:could\s+you\s+(?:please\s+)?(?:provide|specify|enter|choose|select|confirm))"  # "could you ..."
    r"|(?:what\s+(?:is|should|would)\b)"  # "what is/should/would ..."
    r"|(?:which\s+\w+\s+(?:do|would|should)\b)"  # "which X do/would/should ..."
    r"|(?:(?:provide|enter|specify|set)\s+(?:a\s+)?value\s+for\b)",  # "Provide value for 'X':"
    re.IGNORECASE,
)
# Regex to detect input() prompts from the zyra CLI that end with ':'
# e.g. "[fetch_sst_data — acquire ftp] Provide value for 'path':"
_INPUT_PROMPT_RE = re.compile(
    r"\]\s*(?:Provide|Enter|Specify|Set)\s+.*?'[^']*'\s*:\s*$",
    re.IGNORECASE,
)


# Regex to extract structured info from "clarification needed:" lines
# Examples:
#   "Agent 'fetch_frames' is missing required argument 'path'"
#   "Agent 'pad_missing' currently plans to use fill_mode='basemap'. Enter a value to confirm or override."
_CLARIFICATION_RE = re.compile(
    r"Agent '(?P<agent>[^']+)' is missing (?P<importance>required|recommended) argument '(?P<arg>[^']+)'"
)
_CLARIFICATION_CONFIRM_RE = re.compile(
    r"Agent '(?P<agent>[^']+)' currently plans to use (?P<arg>[^=]+)='(?P<value>[^']*)'"
)


# Regex to extract arg key and agent/command from question text
# e.g. "Could you please provide the 'path' for the FTP command?"
# e.g. "[fetch_sst_data — acquire ftp] Provide value for 'path':"
_QUESTION_ARG_RE = re.compile(
    r"(?:the|for)\s+'(?P<arg>[^']+)'"  # 'arg' in single quotes after "the" or "for"
)
_QUESTION_AGENT_RE = re.compile(
    r"for\s+(?:the\s+)?(?P<agent>\w+)\s+(?:command|step|stage|agent)",
    re.IGNORECASE,
)
# Regex to extract agent_id and command from the bracketed prefix of
# input() prompts: "[fetch_sst_data — acquire ftp] Provide value for 'path':"
_INPUT_BRACKET_RE = re.compile(
    r"^\[(?P<agent_id>[^\]—]+?)(?:\s*[—–-]\s*(?P<command>[^\]]+))?\]",
)
# Regex to parse hint lines: "hint: description (default: value)"
_HINT_RE = re.compile(
    r"^hint:\s*(?P<hint>.+?)(?:\s*\(default:\s*(?P<default>[^)]*)\))?\s*$",
    re.IGNORECASE,
)


def _parse_clarification(detail: str) -> dict | None:
    """Parse a clarification detail string into structured data."""
    m = _CLARIFICATION_RE.search(detail)
    if m:
        return {
            "agent_id": m.group("agent"),
            "arg_key": m.group("arg"),
            "kind": "missing",
            "importance": m.group("importance"),
        }
    m = _CLARIFICATION_CONFIRM_RE.search(detail)
    if m:
        return {
            "agent_id": m.group("agent"),
            "arg_key": m.group("arg"),
            "kind": "confirm",
            "current_value": m.group("value"),
        }
    return None


def _get_cached_manifest_sync() -> dict:
    """Fetch the manifest (sync helper — must NOT be called from the event loop).

    Tries the local /v1/commands HTTP endpoint first, then the zyra CLI.
    """
    port = int(os.environ.get("PORT", "8765"))
    try:
        resp = http_requests.get(
            f"http://127.0.0.1:{port}/v1/commands",
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        manifest = _commands_to_manifest(data.get("commands", {}))
        if manifest.get("stages"):
            logger.debug("Manifest from /v1/commands (%d stages)",
                         len(manifest["stages"]))
            return manifest
    except Exception as exc:
        logger.debug("Failed to fetch /v1/commands: %s", exc)

    # Fallback: call zyra CLI directly
    try:
        result = subprocess.run(
            ["zyra", "commands", "--json"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            manifest = _commands_to_manifest(data.get("commands", {}))
            if manifest.get("stages"):
                logger.debug("Manifest from zyra CLI (%d stages)",
                             len(manifest["stages"]))
                return manifest
    except Exception as exc:
        logger.debug("Failed to run zyra commands --json: %s", exc)

    return {"version": "1.0", "stages": []}


async def _get_cached_manifest() -> dict:
    """Return the cached manifest, fetching it in a threadpool if needed.

    Uses asyncio.to_thread so the sync HTTP self-call doesn't deadlock
    the event loop that uvicorn is also using to serve /v1/commands.
    """
    if not hasattr(_get_cached_manifest, "_cache") or not _get_cached_manifest._cache.get("stages"):
        _get_cached_manifest._cache = await asyncio.to_thread(_get_cached_manifest_sync)
    return _get_cached_manifest._cache


def _lookup_arg_meta(manifest: dict, agent_id: str, arg_key: str) -> dict:
    """Look up ArgDef metadata from the manifest for a given arg key.

    agent_id comes from the plan (e.g. 'fetch_frames') and may not
    directly match manifest command names (e.g. 'ftp').  We try several
    strategies in order of specificity.
    """
    normalized = agent_id.lower().replace("-", "_")

    def _match_arg(stage_def: dict) -> dict | None:
        for arg in stage_def.get("args", []):
            if (arg.get("key") == arg_key
                    or arg.get("flag", "").lstrip("-").replace("-", "_") == arg_key):
                return arg
        return None

    # Pass 1: exact command match
    for stage_def in manifest.get("stages", []):
        cmd = stage_def.get("command", "").lower().replace("-", "_")
        if cmd and cmd == normalized:
            found = _match_arg(stage_def)
            if found:
                return found

    # Pass 2: agent_id contains the command name (e.g. "fetch_ftp_data" contains "ftp")
    # Only match command names of 3+ chars to avoid spurious hits
    for stage_def in manifest.get("stages", []):
        cmd = stage_def.get("command", "").lower().replace("-", "_")
        if cmd and len(cmd) >= 3 and cmd in normalized:
            found = _match_arg(stage_def)
            if found:
                return found

    # Pass 3: search all stages for the arg key (common args like "path")
    for stage_def in manifest.get("stages", []):
        for arg in stage_def.get("args", []):
            if arg.get("key") == arg_key:
                return arg
    return {}


def _enrich_question(
    question_text: str,
    hint_lines: list[str],
    manifest: dict,
) -> dict:
    """Convert a raw stdout/stderr question into a rich clarification item.

    Extracts arg key, agent name, default, and options from the question
    text, hint lines, and the manifest so the frontend can display a
    structured ClarificationCard (with dropdown for enums, etc.).
    """
    # Try to extract arg key from single-quoted names in the question
    arg_key = ""
    m = _QUESTION_ARG_RE.search(question_text)
    if m:
        arg_key = m.group("arg")

    # Try to extract agent/command name
    agent_id = ""
    # First try the bracketed prefix: [agent_id — command]
    m = _INPUT_BRACKET_RE.match(question_text.strip())
    if m:
        agent_id = m.group("agent_id").strip()
    if not agent_id:
        m = _QUESTION_AGENT_RE.search(question_text)
        if m:
            agent_id = m.group("agent").lower()

    # Parse hint lines for description and default value
    hint_desc = ""
    hint_default: str | None = None
    for h in hint_lines:
        hm = _HINT_RE.match(h)
        if hm:
            hint_desc = hm.group("hint") or ""
            hint_default = hm.group("default")

    # Look up manifest metadata
    meta: dict = {}
    if arg_key:
        meta = _lookup_arg_meta(manifest, agent_id, arg_key)
    if not meta and hint_desc:
        # Try to match hint description against manifest arg labels/keys
        hint_lower = hint_desc.lower().replace(" ", "_")
        for stage_def in manifest.get("stages", []):
            for arg in stage_def.get("args", []):
                key = arg.get("key", "")
                label = arg.get("label", "").lower().replace(" ", "_")
                if key and (key in hint_lower or hint_lower in key):
                    meta = arg
                    if not arg_key:
                        arg_key = key
                    break
                if label and (label in hint_lower or hint_lower in label):
                    meta = arg
                    if not arg_key:
                        arg_key = arg.get("key", "")
                    break
            if meta:
                break

    # Determine the arg type: enum (with choices) vs string/number/etc.
    arg_type = meta.get("type", "string")
    options = meta.get("choices") or meta.get("options")
    if options and isinstance(options, list) and len(options) > 0:
        arg_type = "enum"

    # Use hint default if manifest doesn't have one
    default = meta.get("default")
    if default is None and hint_default is not None:
        default = hint_default

    # Determine kind: "confirm" if the question mentions confirming
    kind = "missing"
    if "confirm" in question_text.lower():
        kind = "confirm"

    return {
        "agent_id": agent_id or meta.get("command", ""),
        "arg_key": arg_key or hint_desc,
        "kind": kind,
        "importance": "required" if kind == "missing" else "recommended",
        "label": meta.get("label") or arg_key or hint_desc or "Answer",
        "description": question_text,
        "type": arg_type,
        "placeholder": meta.get("placeholder", ""),
        "default": default,
        "options": options,
        "current_value": str(default) if kind == "confirm" and default is not None and default != "" else None,
    }


def _classify_stdout_line(line: str) -> tuple[str, str]:
    """Classify a stdout line as 'plan', 'question', or 'log'."""
    stripped = line.strip()
    if not stripped:
        return ("log", stripped)
    # Try to detect the final JSON plan
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
            if "agents" in data:
                return ("plan", stripped)
        except json.JSONDecodeError:
            pass
    # Detect clarification questions
    if any(stripped.endswith(s) for s in _QUESTION_SUFFIXES):
        return ("question", stripped)
    if _QUESTION_PATTERNS.search(stripped):
        return ("question", stripped)
    # Detect input() prompts like "[agent — command] Provide value for 'arg':"
    if _INPUT_PROMPT_RE.search(stripped):
        return ("question", stripped)
    # Lines containing '?' are likely questions even if the '?' is mid-sentence
    # (e.g. "Could you confirm X? This ensures Y.")
    if "?" in stripped and not stripped.startswith(("DEBUG", "INFO", "WARNING", "ERROR", "http")):
        return ("question", stripped)
    return ("log", stripped)


@app.websocket("/ws/plan")
async def ws_plan(websocket: WebSocket):
    """Interactive planning session over WebSocket.

    Protocol:
      Client sends: {"type": "start", "intent": "...", "guardrails": "..."}
      Server sends: {"type": "clarification"|"log"|"status"|"plan"|"error", ...}
                    Periodic keepalives: {"keepalive": true}
      Client sends: {"type": "answer", "text": "..."} or {"type": "cancel"}
    """
    await websocket.accept()

    # Serialize all outbound WebSocket sends to avoid interleaved frames
    # from concurrent tasks (_keepalive, _read_stdout, _read_stderr, main loop).
    _send_lock = asyncio.Lock()

    async def _safe_send(data: dict) -> None:
        """Send JSON over WebSocket, serialized via lock."""
        async with _send_lock:
            await websocket.send_json(data)

    async def _keepalive():
        """Send periodic keepalive pings."""
        try:
            while True:
                await asyncio.sleep(WS_KEEPALIVE_INTERVAL)
                await _safe_send({"keepalive": True})
        except Exception:
            pass

    # Shared state for clarification interception
    plan_sent = False  # Set to True once a plan message is sent to the client
    clarifications: list[str] = []
    clarification_event = asyncio.Event()
    # Signalled when an answer arrives (so the main loop can write it to
    # stdin even when no structured "clarification needed:" was detected).
    answer_ready_event = asyncio.Event()
    # Buffer for questions detected on stdout/stderr (enriched with
    # manifest metadata before being sent as clarification items).
    pending_questions: list[str] = []
    question_event = asyncio.Event()
    # Recent hint lines (associated with the next/previous question)
    recent_hints: list[str] = []

    # Collect the last N stdout/stderr lines for post-mortem diagnostics
    _stderr_tail: list[str] = []
    _stdout_lines: list[str] = []
    _STDERR_TAIL_SIZE = 30

    # Accumulate all clarification answers across rounds so we can
    # merge them into the final plan if the CLI omits them.
    # Defined at ws_plan scope so _read_stderr/_read_stdout can access it.
    collected_answers: list[dict] = []

    def _merge_answers_into_plan(plan_data: dict) -> dict:
        """Patch agent args with clarification answers the CLI missed."""
        if not collected_answers:
            return plan_data
        agents = plan_data.get("agents")
        if not agents or not isinstance(agents, list):
            return plan_data
        # Build lookup: agent_id -> {arg_key: value}
        answer_map: dict[str, dict[str, str]] = {}
        for a in collected_answers:
            aid = a.get("agent_id", "")
            key = a.get("arg_key", "")
            val = a.get("value", "")
            if aid and key and val:
                answer_map.setdefault(aid, {})[key] = val
        if not answer_map:
            return plan_data
        for agent in agents:
            aid = agent.get("id", "")
            cmd_name = agent.get("command", "")
            stage = agent.get("stage", "")
            args = agent.get("args", {})
            # Try matching by agent id, command name, or stage/command combo
            patches = (
                answer_map.get(aid)
                or answer_map.get(cmd_name)
                or answer_map.get(f"{stage}_{cmd_name}")
                or answer_map.get(cmd_name.lower())
                or answer_map.get(aid.lower())
            )
            if patches:
                for k, v in patches.items():
                    # Only fill in missing or empty args
                    if k not in args or not args[k]:
                        args[k] = v
                    # Also try matching by flag-style key (--key -> key)
                    bare_key = k.lstrip("-")
                    if bare_key != k and (bare_key not in args or not args[bare_key]):
                        args[bare_key] = v
                agent["args"] = args
        return plan_data

    async def _read_stderr(proc: asyncio.subprocess.Process):
        """Forward stderr lines as log messages, intercepting clarification notices."""
        nonlocal plan_sent
        assert proc.stderr is not None
        try:
            async for raw in proc.stderr:
                line = raw.decode("utf-8", errors="replace").rstrip("\n")
                if not line:
                    continue
                # Keep a rolling tail of stderr for diagnostics
                _stderr_tail.append(line)
                if len(_stderr_tail) > _STDERR_TAIL_SIZE:
                    _stderr_tail.pop(0)
                # Intercept "clarification needed:" lines from zyra CLI
                if line.strip().lower().startswith("clarification needed:"):
                    detail = line.strip().split(":", 1)[1].strip()
                    clarifications.append(detail)
                    await _safe_send({"type": "log", "text": line})
                    # Signal that we have clarifications; use a short delay
                    # so we can batch multiple lines that arrive together
                    if not clarification_event.is_set():
                        clarification_event.set()
                    continue
                # Detect hint lines and buffer them
                hint_m = _HINT_RE.match(line.strip())
                if hint_m:
                    recent_hints.append(line.strip())
                    await _safe_send({"type": "log", "text": line})
                    continue
                # Check if stderr contains a plan JSON (some CLIs output
                # the plan to stderr instead of stdout).
                stripped = line.strip()
                if stripped.startswith("{"):
                    try:
                        data = json.loads(stripped)
                        if "agents" in data:
                            logger.info("ws/plan: plan JSON found on stderr (unexpected)")
                            await _safe_send({"type": "plan", "data": _merge_answers_into_plan(data)})
                            plan_sent = True
                            continue
                    except json.JSONDecodeError:
                        pass
                kind, text = _classify_stdout_line(line)
                if kind == "question":
                    # Buffer the question for the main loop to enrich
                    # with manifest metadata and send as a structured
                    # clarification item.
                    pending_questions.append(text)
                    if not question_event.is_set():
                        question_event.set()
                    await _safe_send({"type": "log", "text": text})
                else:
                    await _safe_send({"type": "log", "text": text})
        except Exception:
            logger.debug("ws/plan: stderr reader stopped", exc_info=True)

    async def _read_stdout(proc: asyncio.subprocess.Process):
        """Read stdout, classify lines, and send appropriate messages.

        Uses a byte-level reader with a short timeout so that input()
        prompts (which lack a trailing newline) are detected promptly
        instead of waiting for the pipe to close.

        Buffers partial JSON across multiple lines so multi-line plan
        output is still detected.
        """
        nonlocal plan_sent
        assert proc.stdout is not None
        json_buffer = ""
        line_buffer = b""
        PARTIAL_TIMEOUT = 0.5  # seconds to wait before flushing a partial line

        async def _read_chunk() -> bytes:
            """Read available bytes from stdout."""
            assert proc.stdout is not None
            return await proc.stdout.read(8192)

        async def _next_lines() -> list[str]:
            """Yield complete lines, flushing partial lines after a timeout.

            Returns a list of lines (without trailing newline).
            An empty list means EOF.
            """
            nonlocal line_buffer
            while True:
                # Check if we already have complete lines buffered
                if b"\n" in line_buffer:
                    parts = line_buffer.split(b"\n")
                    # Last element is the remainder (possibly empty)
                    line_buffer = parts[-1]
                    return [p.decode("utf-8", errors="replace") for p in parts[:-1]]

                # If there's a partial line, wait briefly then flush it
                # (this catches input() prompts without trailing newlines)
                if line_buffer:
                    try:
                        chunk = await asyncio.wait_for(
                            _read_chunk(), timeout=PARTIAL_TIMEOUT
                        )
                    except asyncio.TimeoutError:
                        # Flush the partial line as-is
                        partial = line_buffer.decode("utf-8", errors="replace")
                        line_buffer = b""
                        return [partial]
                    if not chunk:
                        # EOF — flush remaining buffer
                        remaining = line_buffer.decode("utf-8", errors="replace")
                        line_buffer = b""
                        return [remaining] if remaining.strip() else []
                    line_buffer += chunk
                    continue

                # No buffered data — do a blocking read
                chunk = await _read_chunk()
                if not chunk:
                    return []  # EOF
                line_buffer += chunk

        try:
            while True:
                lines = await _next_lines()
                if not lines:
                    break  # EOF
                for line in lines:
                    stripped = line.strip()
                    if not stripped:
                        continue

                    # Track for diagnostics
                    _stdout_lines.append(stripped[:200])
                    if len(_stdout_lines) > 50:
                        _stdout_lines.pop(0)
                    logger.debug("ws/plan STDOUT: %s", stripped[:200])

                    # If we're buffering a multi-line JSON blob, keep accumulating
                    if json_buffer:
                        json_buffer += "\n" + line
                        try:
                            data = json.loads(json_buffer)
                            if "agents" in data:
                                await _safe_send({"type": "plan", "data": _merge_answers_into_plan(data)})
                                plan_sent = True
                                json_buffer = ""
                                continue
                        except json.JSONDecodeError:
                            # Still incomplete — keep buffering
                            continue

                    # The planner's input() prompts are written to stdout
                    # without a trailing newline.  When PYTHONUNBUFFERED=1 is
                    # set, the prompt text may be prepended to the next real
                    # output line (e.g. a JSON plan blob).  Extract any JSON
                    # that starts with '{' from the end of the line.
                    json_start = stripped.find("{")
                    if json_start > 0:
                        prefix = stripped[:json_start].strip()
                        maybe_json = stripped[json_start:]
                        try:
                            data = json.loads(maybe_json)
                            if "agents" in data:
                                if prefix:
                                    await _safe_send({"type": "log", "text": prefix})
                                await _safe_send({"type": "plan", "data": _merge_answers_into_plan(data)})
                                plan_sent = True
                                continue
                        except json.JSONDecodeError:
                            # Incomplete JSON (multi-line plan) — the prompt
                            # text (e.g. "Provide value for 'path': ") is
                            # glued to the start of the JSON blob because
                            # input() doesn't write a newline.  Start the
                            # json_buffer and skip question classification
                            # to avoid a spurious duplicate question.
                            if prefix:
                                await _safe_send({"type": "log", "text": prefix})
                            json_buffer = maybe_json
                            continue

                    # Detect hint lines and buffer them
                    hint_m = _HINT_RE.match(stripped)
                    if hint_m:
                        recent_hints.append(stripped)
                        await _safe_send({"type": "log", "text": stripped})
                        continue

                    kind, text = _classify_stdout_line(line)
                    if kind == "plan":
                        data = json.loads(text)
                        await _safe_send({"type": "plan", "data": _merge_answers_into_plan(data)})
                        plan_sent = True
                    elif kind == "question":
                        # Buffer for main loop to enrich with manifest metadata
                        pending_questions.append(text)
                        if not question_event.is_set():
                            question_event.set()
                        await _safe_send({"type": "log", "text": text})
                    else:
                        # Check if this starts a multi-line JSON blob
                        if stripped.startswith("{"):
                            json_buffer = line
                        else:
                            await _safe_send({"type": "log", "text": text})
        except Exception:
            logger.debug("ws/plan: stdout reader stopped", exc_info=True)

    keepalive_task: asyncio.Task | None = None
    stderr_task: asyncio.Task | None = None
    stdout_task: asyncio.Task | None = None
    proc: asyncio.subprocess.Process | None = None

    try:
        # Wait for the start message
        start_msg = await asyncio.wait_for(websocket.receive_json(), timeout=30)
        if start_msg.get("type") != "start" or not start_msg.get("intent"):
            await _safe_send({"type": "error", "text": "Expected {type: 'start', intent: '...'}"})
            await websocket.close()
            return

        intent = start_msg["intent"]
        guardrails = start_msg.get("guardrails", "")

        scoped_intent = _apply_scope(intent)
        cmd = ["zyra", "plan", "--intent", scoped_intent]
        if guardrails:
            cmd += ["--guardrails", guardrails]

        logger.info("ws/plan: starting interactive session — intent=%.200s", intent)

        MAX_CLARIFICATION_ROUNDS = 3

        async def _fallback_non_interactive(
            intent: str,
            guardrails: str,
            answers: list[dict],
            send_fn,
            merge_fn,
        ) -> None:
            """Retry plan generation in non-interactive mode.

            Bakes the collected answers into the intent string and runs
            ``zyra plan --no-clarify`` so the planner doesn't ask for input.
            """
            nonlocal plan_sent
            # Build an augmented intent with the user's answers
            answer_parts = []
            for a in answers:
                key = a.get("arg_key", "")
                val = a.get("value", "")
                aid = a.get("agent_id", "")
                if key and val:
                    if aid:
                        answer_parts.append(f"{aid}.{key}={val}")
                    else:
                        answer_parts.append(f"{key}={val}")
            if answer_parts:
                augmented = f"{intent} (use these values: {', '.join(answer_parts)})"
            else:
                augmented = intent
            scoped = _apply_scope(augmented)
            fallback_cmd = ["zyra", "plan", "--intent", scoped, "--no-clarify"]
            if guardrails:
                fallback_cmd += ["--guardrails", guardrails]
            logger.info(
                "ws/plan: fallback non-interactive — cmd=%s",
                fallback_cmd,
            )
            try:
                result = await asyncio.to_thread(
                    subprocess.run,
                    fallback_cmd,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                logger.info(
                    "ws/plan: fallback exit code=%d, stdout=%d bytes, "
                    "stderr=%d bytes",
                    result.returncode,
                    len(result.stdout),
                    len(result.stderr),
                )
                if result.returncode == 0 and result.stdout.strip():
                    try:
                        data = json.loads(result.stdout.strip())
                        if "agents" in data:
                            await send_fn({
                                "type": "plan",
                                "data": merge_fn(data),
                            })
                            plan_sent = True
                            return
                    except json.JSONDecodeError:
                        logger.warning(
                            "ws/plan: fallback stdout not valid JSON: %.500s",
                            result.stdout,
                        )
                # Fallback failed too
                stderr_hint = ""
                if result.stderr:
                    # Show last few non-DEBUG lines
                    lines = [
                        l for l in result.stderr.strip().split("\n")[-5:]
                        if not l.startswith("DEBUG")
                    ]
                    if lines:
                        stderr_hint = "\n\nPlanner output:\n" + "\n".join(
                            lines[-3:]
                        )
                await send_fn({
                    "type": "error",
                    "text": "The planner could not generate a plan."
                            + stderr_hint
                            + "\n\nTry rephrasing your intent or "
                              "providing more detail.",
                })
            except subprocess.TimeoutExpired:
                await send_fn({
                    "type": "error",
                    "text": "Planning timed out (fallback mode).",
                })
            except Exception as exc:
                logger.exception("ws/plan: fallback failed")
                await send_fn({
                    "type": "error",
                    "text": f"Planning failed: {exc}",
                })

        async def _run_plan_process(
            cmd: list[str],
            intent: str,
            guardrails: str,
        ) -> None:
            """Run a zyra plan subprocess, feeding clarification answers
            back into its stdin so the planner can update its session state.

            Flow:
            1. Launch ``zyra plan`` with stdin/stdout/stderr pipes.
            2. Read stderr — when "clarification needed:" lines appear,
               batch them, present rich questions to the user via
               WebSocket, then write each answer back to the process's
               stdin (one line per clarification, in the order they
               appeared).
            3. The planner reads the answers, updates its internal
               resolved_parameters, and continues planning.
            4. Repeat up to MAX_CLARIFICATION_ROUNDS times.
            5. stdout is watched for the final JSON plan output.
            """
            nonlocal proc, clarifications

            clarifications.clear()
            clarification_event.clear()
            collected_answers.clear()

            try:
                # ZYRA_FORCE_PLAN_PROMPT makes the planner use input()
                # even when stdin is a pipe (not a TTY).  This lets us
                # feed clarification answers via proc.stdin.
                # PYTHONUNBUFFERED ensures prompt text is flushed
                # immediately so we can read it on stdout.
                plan_env = {
                    **os.environ,
                    "ZYRA_FORCE_PLAN_PROMPT": "1",
                    "PYTHONUNBUFFERED": "1",
                }
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=plan_env,
                )
            except FileNotFoundError:
                await _safe_send({"type": "error", "text": "zyra CLI is not installed"})
                return

            # Launch background readers
            nonlocal keepalive_task, stderr_task, stdout_task
            if not keepalive_task:
                keepalive_task = asyncio.create_task(_keepalive())
            stderr_task = asyncio.create_task(_read_stderr(proc))
            stdout_task = asyncio.create_task(_read_stdout(proc))

            # Also listen for client cancel
            cancelled = False

            async def _listen_cancel():
                """Listen for cancel messages from the client.

                Only handles cancel — answer messages are handled in the
                main clarification loop below.
                """
                nonlocal cancelled
                try:
                    while True:
                        msg = await websocket.receive_json()
                        if msg.get("type") == "cancel":
                            cancelled = True
                            if proc.returncode is None:
                                proc.kill()
                            return
                        # Put answer messages back for the main loop to handle
                        # by storing them in a shared queue.
                        if msg.get("type") == "answer":
                            answer_queue.put_nowait(msg)
                            answer_ready_event.set()
                except (WebSocketDisconnect, Exception):
                    cancelled = True
                    if proc.returncode is None:
                        proc.kill()

            answer_queue: asyncio.Queue = asyncio.Queue()
            cancel_task = asyncio.create_task(_listen_cancel())

            rounds = 0
            try:
                while proc.returncode is None and not cancelled:
                    # Race: process finishes vs clarification detected vs
                    # question detected on stdout/stderr vs answer arrives.
                    proc_done = asyncio.ensure_future(proc.wait())
                    clarification_wait = asyncio.ensure_future(
                        clarification_event.wait()
                    )
                    question_wait = asyncio.ensure_future(
                        question_event.wait()
                    )
                    answer_wait = asyncio.ensure_future(
                        answer_ready_event.wait()
                    )

                    done, pending = await asyncio.wait(
                        [proc_done, clarification_wait, question_wait,
                         answer_wait, cancel_task],
                        timeout=WS_PLAN_TIMEOUT,
                        return_when=asyncio.FIRST_COMPLETED,
                    )

                    # Cancel pending futures and await them to avoid
                    # "Task was destroyed but it is pending" warnings.
                    to_cancel = [fut for fut in pending if fut is not cancel_task]
                    for fut in to_cancel:
                        fut.cancel()
                    if to_cancel:
                        await asyncio.gather(*to_cancel, return_exceptions=True)

                    if not done:
                        # Timeout
                        if proc.returncode is None:
                            proc.kill()
                        await _safe_send({"type": "error", "text": "Planning timed out"})
                        cancel_task.cancel()
                        await asyncio.gather(cancel_task, return_exceptions=True)
                        return

                    if cancelled:
                        cancel_task.cancel()
                        await asyncio.gather(cancel_task, return_exceptions=True)
                        return

                    # ── Priority: handle pending questions/clarifications
                    # BEFORE checking proc_done.  When the process emits a
                    # question on stderr and then exits almost immediately,
                    # both proc_done and question_wait fire in the same
                    # asyncio.wait call.  We must present the question to
                    # the user first; the answer can be merged into a
                    # re-run or the final plan.

                    # A question was detected on stdout/stderr (not via
                    # "clarification needed:" on stderr).  Enrich it
                    # with manifest metadata and present it as a
                    # structured clarification card.
                    if (question_wait in done
                            and clarification_wait not in done):
                        # Wait briefly for hint lines to arrive
                        await asyncio.sleep(0.3)

                        batch_q = list(pending_questions)
                        pending_questions.clear()
                        hints = list(recent_hints)
                        recent_hints.clear()
                        question_event.clear()
                        answer_ready_event.clear()

                        if not batch_q:
                            continue

                        manifest = await _get_cached_manifest()
                        items: list[dict] = []
                        for q_text in batch_q:
                            item = _enrich_question(
                                q_text, hints, manifest,
                            )
                            items.append(item)

                        # ── Auto-replay: if we already answered this
                        # exact question (same agent_id + arg_key),
                        # silently replay the previous answer instead
                        # of bothering the user again.  The planner
                        # often asks for the same arg twice (once in
                        # the clarification round, once via input()
                        # after FTP listing, etc.).
                        # Build lookup tables: exact (agent, key) and
                        # fallback by arg_key alone.  The planner may
                        # use different agent_ids across rounds (e.g.
                        # "acquire_ftp" vs "fetch_sst_data").
                        prev_exact: dict[tuple[str, str], str] = {}
                        prev_by_arg: dict[str, str] = {}
                        for a in collected_answers:
                            aid = a.get("agent_id", "")
                            akey = a.get("arg_key", "")
                            val = a.get("value", "")
                            if aid and akey:
                                prev_exact[(aid, akey)] = val
                            if akey:
                                prev_by_arg[akey] = val

                        auto_replayed: list[dict] = []
                        remaining_items: list[dict] = []
                        for item in items:
                            aid = item.get("agent_id", "")
                            akey = item.get("arg_key", "")
                            prev_val = (
                                prev_exact.get((aid, akey))
                                if aid and akey else None
                            ) or (
                                prev_by_arg.get(akey)
                                if akey else None
                            )
                            if prev_val:
                                logger.info(
                                    "ws/plan: auto-replaying answer for "
                                    "%s.%s = %s",
                                    aid, akey, prev_val,
                                )
                                auto_replayed.append({
                                    "agent_id": aid,
                                    "arg_key": akey,
                                    "value": prev_val,
                                })
                            else:
                                remaining_items.append(item)

                        # Write auto-replayed answers immediately
                        if auto_replayed:
                            if proc.stdin and proc.returncode is None:
                                for a in auto_replayed:
                                    proc.stdin.write(
                                        (a["value"] + "\n").encode("utf-8")
                                    )
                                try:
                                    await proc.stdin.drain()
                                except Exception:
                                    pass
                            collected_answers.extend(auto_replayed)
                            await _safe_send({
                                "type": "status",
                                "text": "Using your previous answer...",
                            })
                            if not remaining_items:
                                continue

                        # Send one clarification per remaining question
                        # and wait for answers, then write to stdin.
                        answers: list[dict] = []
                        for i, item in enumerate(remaining_items):
                            await _safe_send({
                                "type": "clarification",
                                "index": i,
                                "total": len(remaining_items),
                                "agent_id": item.get("agent_id", ""),
                                "arg_key": item.get("arg_key", ""),
                                "kind": item.get("kind", "missing"),
                                "label": item.get("label", ""),
                                "description": item.get(
                                    "description", ""),
                                "arg_type": item.get("type", "string"),
                                "placeholder": item.get(
                                    "placeholder", ""),
                                "default": item.get("default"),
                                "options": item.get("options"),
                                "current_value": item.get(
                                    "current_value"),
                                "importance": item.get(
                                    "importance", ""),
                            })
                            try:
                                while True:
                                    msg = await asyncio.wait_for(
                                        answer_queue.get(),
                                        timeout=WS_PLAN_TIMEOUT,
                                    )
                                    if msg.get("type") == "answer":
                                        answers.append({
                                            "agent_id": item.get(
                                                "agent_id", ""),
                                            "arg_key": item.get(
                                                "arg_key", ""),
                                            "value": msg.get(
                                                "text", ""),
                                        })
                                        break
                            except (asyncio.TimeoutError,
                                    asyncio.CancelledError):
                                return

                        collected_answers.extend(answers)
                        if proc.stdin and proc.returncode is None:
                            for a in answers:
                                value = a["value"]
                                logger.info(
                                    "ws/plan: writing enriched-question "
                                    "answer to stdin: %s=%s",
                                    a["arg_key"], value,
                                )
                                proc.stdin.write(
                                    (value + "\n").encode("utf-8")
                                )
                            try:
                                await proc.stdin.drain()
                            except Exception as exc:
                                logger.warning(
                                    "ws/plan: stdin drain failed: %s", exc)
                        else:
                            logger.warning(
                                "ws/plan: cannot write answers — "
                                "stdin=%s, returncode=%s",
                                proc.stdin, proc.returncode,
                            )

                        # Clear answer_ready so the next iteration doesn't
                        # spuriously enter the answer_wait branch.
                        answer_ready_event.clear()
                        await _safe_send({
                            "type": "status",
                            "text": "Continuing with your answers...",
                        })
                        continue

                    if clarification_wait in done:
                        # Also clear other events — the clarification
                        # loop below handles everything for this round.
                        answer_ready_event.clear()
                        question_event.clear()
                        pending_questions.clear()
                        rounds += 1
                        # Wait briefly for more clarification lines to arrive
                        await asyncio.sleep(0.5)

                        # Reset the event so we can detect the next round
                        batch = list(clarifications)
                        clarifications.clear()
                        clarification_event.clear()

                        if not batch:
                            continue

                        # Parse clarifications and enrich with manifest metadata
                        manifest = await _get_cached_manifest()
                        parsed_items: list[dict] = []
                        for detail in batch:
                            parsed = _parse_clarification(detail)
                            if parsed:
                                meta = _lookup_arg_meta(
                                    manifest,
                                    parsed["agent_id"],
                                    parsed["arg_key"],
                                )
                                parsed["label"] = meta.get("label", parsed["arg_key"])
                                parsed["description"] = meta.get("description", "")
                                parsed["type"] = meta.get("type", "string")
                                parsed["placeholder"] = meta.get("placeholder", "")
                                parsed["default"] = meta.get("default")
                                parsed["options"] = meta.get("options")
                            else:
                                parsed_items.append({
                                    "agent_id": "",
                                    "arg_key": "",
                                    "kind": "unknown",
                                    "label": detail,
                                    "description": "",
                                    "type": "string",
                                    "placeholder": "",
                                    "default": None,
                                    "options": None,
                                    "raw": detail,
                                })
                                continue
                            parsed_items.append(parsed)

                        # Ask one question at a time and collect answers
                        answers: list[dict] = []
                        for i, item in enumerate(parsed_items):
                            await _safe_send({
                                "type": "clarification",
                                "index": i,
                                "total": len(parsed_items),
                                "agent_id": item.get("agent_id", ""),
                                "arg_key": item.get("arg_key", ""),
                                "kind": item.get("kind", "missing"),
                                "label": item.get("label", ""),
                                "description": item.get("description", ""),
                                "arg_type": item.get("type", "string"),
                                "placeholder": item.get("placeholder", ""),
                                "default": item.get("default"),
                                "options": item.get("options"),
                                "current_value": item.get("current_value"),
                                "importance": item.get("importance", ""),
                            })

                            # Wait for answer (from the queue populated by _listen_cancel)
                            try:
                                while True:
                                    msg = await asyncio.wait_for(
                                        answer_queue.get(),
                                        timeout=WS_PLAN_TIMEOUT,
                                    )
                                    if msg.get("type") == "answer":
                                        answers.append({
                                            "agent_id": item.get("agent_id", ""),
                                            "arg_key": item.get("arg_key", ""),
                                            "value": msg.get("text", ""),
                                        })
                                        break
                            except (asyncio.TimeoutError, asyncio.CancelledError):
                                return

                        # Write answers to the process's stdin so the
                        # planner can update its session state.
                        collected_answers.extend(answers)
                        if proc.stdin and proc.returncode is None:
                            for a in answers:
                                value = a["value"]
                                logger.info(
                                    "ws/plan: writing clarification "
                                    "answer to stdin: %s=%s",
                                    a["arg_key"], value,
                                )
                                proc.stdin.write(
                                    (value + "\n").encode("utf-8")
                                )
                            try:
                                await proc.stdin.drain()
                            except Exception as exc:
                                logger.warning(
                                    "ws/plan: stdin drain failed: %s", exc)
                        else:
                            logger.warning(
                                "ws/plan: cannot write clarification answers — "
                                "stdin=%s, returncode=%s",
                                proc.stdin, proc.returncode,
                            )

                        # Clear answer_ready so the next iteration doesn't
                        # spuriously enter the answer_wait branch.
                        answer_ready_event.clear()
                        await _safe_send({
                            "type": "status",
                            "text": "Continuing with your answers...",
                        })

                        if rounds >= MAX_CLARIFICATION_ROUNDS:
                            logger.warning(
                                "ws/plan: hit max clarification rounds (%d)",
                                MAX_CLARIFICATION_ROUNDS,
                            )
                            # Close stdin to signal the planner to
                            # proceed with defaults for any remaining
                            # unresolved parameters.
                            if proc.stdin:
                                proc.stdin.close()
                            break

                    # ── Now check if the process finished ──
                    if proc_done in done:
                        # Process finished — break out of the loop to
                        # drain and deliver the final output.
                        break

                    # An answer arrived for a question that already had
                    # an input shown on the frontend (answer_ready but
                    # no clarification or question event triggered this
                    # iteration).  Write it directly to stdin.
                    if (answer_wait in done
                            and clarification_wait not in done
                            and question_wait not in done
                            and proc.returncode is None):
                        answer_ready_event.clear()
                        while not answer_queue.empty():
                            msg = answer_queue.get_nowait()
                            if msg.get("type") == "answer":
                                value = msg.get("text", "")
                                logger.debug(
                                    "ws/plan: writing stdout-question "
                                    "answer to stdin: %s",
                                    value,
                                )
                                if proc.stdin and proc.returncode is None:
                                    proc.stdin.write(
                                        (value + "\n").encode("utf-8")
                                    )
                        if proc.stdin and proc.returncode is None:
                            try:
                                await proc.stdin.drain()
                            except Exception:
                                pass
                        await _safe_send({
                            "type": "status",
                            "text": "Continuing with your answer...",
                        })
                        continue

                # Process finished — cancel the cancel listener
                logger.info(
                    "ws/plan: main loop exited — returncode=%s, "
                    "cancelled=%s, plan_sent=%s",
                    proc.returncode, cancelled, plan_sent,
                )
                cancel_task.cancel()
                await asyncio.gather(cancel_task, return_exceptions=True)

            except asyncio.CancelledError:
                cancel_task.cancel()
                await asyncio.gather(cancel_task, return_exceptions=True)
                return

            # Let stdout/stderr finish draining
            if stdout_task:
                try:
                    await asyncio.wait_for(stdout_task, timeout=5)
                except Exception:
                    pass
            if stderr_task:
                try:
                    await asyncio.wait_for(stderr_task, timeout=5)
                except Exception:
                    pass

            exit_code = proc.returncode

            # ── Post-mortem diagnostics ──
            # Log detailed info about what the process did so we can
            # debug failures.
            logger.info(
                "ws/plan: process exited — code=%s, plan_sent=%s, "
                "stdout_lines=%d, stderr_tail=%d, collected_answers=%d",
                exit_code, plan_sent,
                len(_stdout_lines), len(_stderr_tail),
                len(collected_answers),
            )
            diag_text = ""
            if not plan_sent:
                # Show the last few stdout lines so we know what the
                # planner was doing right before exit.
                if _stdout_lines:
                    logger.warning(
                        "ws/plan: last stdout lines:\n  %s",
                        "\n  ".join(_stdout_lines[-10:]),
                    )
                if _stderr_tail:
                    logger.warning(
                        "ws/plan: last stderr lines:\n  %s",
                        "\n  ".join(_stderr_tail[-10:]),
                    )

                # Send last few log lines as diagnostic info to the
                # client so the user can see what happened.
                diag_lines = _stderr_tail[-5:] if _stderr_tail else _stdout_lines[-5:]
                if diag_lines:
                    # Filter out DEBUG lines which are noisy
                    useful = [l for l in diag_lines if not l.startswith("DEBUG")]
                    if useful:
                        diag_text = "\n\nLast output:\n" + "\n".join(useful[-3:])

            if exit_code and exit_code != 0:
                logger.warning(
                    "ws/plan: process exited with code %s", exit_code)
                if not plan_sent and collected_answers:
                    # Try fallback non-interactive mode
                    await _fallback_non_interactive(
                        intent, guardrails, collected_answers,
                        _safe_send, _merge_answers_into_plan,
                    )
                elif not plan_sent:
                    await _safe_send({
                        "type": "error",
                        "text": f"zyra plan exited with code {exit_code}.{diag_text}",
                    })
            elif not plan_sent:
                # Process exited successfully but no plan JSON was detected
                # on stdout.
                if collected_answers:
                    # We have answers — try fallback non-interactive mode
                    # with answers baked into the intent.
                    logger.info(
                        "ws/plan: no plan from interactive mode, "
                        "retrying non-interactively with %d answers",
                        len(collected_answers),
                    )
                    await _safe_send({
                        "type": "status",
                        "text": "Retrying with your answers...",
                    })
                    await _fallback_non_interactive(
                        intent, guardrails, collected_answers,
                        _safe_send, _merge_answers_into_plan,
                    )
                else:
                    hint = ""
                    if pending_questions:
                        qs = "; ".join(pending_questions[:3])
                        hint = f" The planner was asking: {qs}"
                        pending_questions.clear()
                    await _safe_send({
                        "type": "error",
                        "text": "The planner finished without producing a plan."
                                + hint
                                + diag_text
                                + "\n\nTry rephrasing your intent or "
                                  "providing more detail.",
                    })

        await _run_plan_process(cmd, intent, guardrails)
        await websocket.close()

    except WebSocketDisconnect:
        logger.info("ws/plan: client disconnected")
    except asyncio.TimeoutError:
        try:
            await _safe_send({"type": "error", "text": "Timed out waiting for start message"})
            await websocket.close()
        except Exception:
            pass
    except Exception as exc:
        logger.exception("ws/plan: unexpected error")
        try:
            await _safe_send({"type": "error", "text": str(exc)})
            await websocket.close()
        except Exception:
            pass
    finally:
        if keepalive_task:
            keepalive_task.cancel()
        if stderr_task:
            stderr_task.cancel()
        if stdout_task:
            stdout_task.cancel()
        if proc and proc.returncode is None:
            try:
                proc.kill()
                await asyncio.wait_for(proc.wait(), timeout=5)
            except (asyncio.TimeoutError, ProcessLookupError, Exception):
                pass


@app.get("/v1/manifest")
def get_manifest(request: Request):
    """Adapt /v1/commands into the Manifest shape the editor expects."""
    # Call our own /v1/commands endpoint internally
    base = str(request.base_url).rstrip("/")
    resp = http_requests.get(f"{base}/v1/commands", timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return _commands_to_manifest(data.get("commands", {}))


# ── Run history endpoints ─────────────────────────────────────────


class RunStepPayload(BaseModel):
    nodeId: str
    status: str
    jobId: str | None = None
    exitCode: int | None = None
    stdout: str = ""
    stderr: str = ""
    startedAt: str | None = None
    completedAt: str | None = None
    durationMs: int | None = None
    request: dict | None = None
    events: list[dict] = Field(default_factory=list)
    dryRunArgv: str | None = None


class RunPayload(BaseModel):
    id: str
    startedAt: str
    completedAt: str | None = None
    status: str
    durationMs: int | None = None
    mode: str
    nodeCount: int
    summary: str | None = None
    graphSnapshot: dict | None = None
    steps: list[RunStepPayload] = Field(default_factory=list)


@app.post("/v1/runs")
async def save_run_endpoint(payload: RunPayload):
    """Persist a completed run record."""
    data = payload.model_dump()
    await asyncio.to_thread(save_run, _history_db, data)
    return {"id": data["id"]}


@app.get("/v1/runs")
async def list_runs_endpoint(limit: int = 50, offset: int = 0):
    """List recent run summaries (no step details)."""
    return await asyncio.to_thread(list_runs, _history_db, limit, offset)


@app.get("/v1/runs/{run_id}")
async def get_run_endpoint(run_id: str):
    """Get full run detail including all steps."""
    result = await asyncio.to_thread(get_run, _history_db, run_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return result


@app.delete("/v1/runs/{run_id}", status_code=204)
async def delete_run_endpoint(run_id: str):
    """Delete a run and its steps."""
    found = await asyncio.to_thread(delete_run, _history_db, run_id)
    if not found:
        raise HTTPException(status_code=404, detail="Run not found")


@app.get("/v1/cache/lookup")
async def cache_lookup_endpoint(key: str):
    """Look up a cached step result by cache key."""
    result = await asyncio.to_thread(lookup_cache, _history_db, key)
    if result:
        return {"hit": True, **result}
    return {"hit": False}


# Serve the built React editor in production
STATIC_DIR = Path(__file__).parent.parent / "packages" / "editor" / "dist"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
