"""
Lightweight SQLite-backed run history for the Zyra Editor.

Stores completed pipeline/node runs with per-step results, structured events,
and graph snapshots for replay.  Uses Python's built-in sqlite3 module — no
extra dependencies required.

The database file lives at ``$ZYRA_DATA_DIR/run_history.db`` (defaults to
``./run_history.db``), persisted via the existing ``_work:/data`` Docker mount.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from typing import Any

# ── Schema ────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    started_at      TEXT NOT NULL,
    completed_at    TEXT,
    status          TEXT NOT NULL,
    duration_ms     INTEGER,
    mode            TEXT NOT NULL,
    node_count      INTEGER NOT NULL,
    summary         TEXT,
    graph_snapshot  TEXT
);

CREATE TABLE IF NOT EXISTS run_steps (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id         TEXT NOT NULL,
    status          TEXT NOT NULL,
    job_id          TEXT,
    exit_code       INTEGER,
    stdout          TEXT DEFAULT '',
    stderr          TEXT DEFAULT '',
    started_at      TEXT,
    completed_at    TEXT,
    duration_ms     INTEGER,
    request         TEXT,
    events          TEXT,
    dry_run_argv    TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_started_at  ON runs(started_at);
"""

# ── Initialisation ────────────────────────────────────────────────────

def init_db() -> sqlite3.Connection:
    """Create (or open) the history database and return a connection."""
    data_dir = os.environ.get("ZYRA_DATA_DIR", ".")
    os.makedirs(data_dir, exist_ok=True)
    db_path = os.path.join(data_dir, "run_history.db")
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    conn.commit()
    _migrate_cache_key(conn)
    _backfill_cache_keys(conn)
    return conn


def _migrate_cache_key(conn: sqlite3.Connection) -> None:
    """Add cache_key column to run_steps if it doesn't exist yet."""
    cur = conn.execute("PRAGMA table_info(run_steps)")
    columns = {row[1] for row in cur.fetchall()}
    if "cache_key" not in columns:
        conn.execute("ALTER TABLE run_steps ADD COLUMN cache_key TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_run_steps_cache_key "
            "ON run_steps(cache_key)"
        )
        conn.commit()


def _compute_cache_key(request_dict: dict[str, Any]) -> str:
    """Compute a SHA-256 cache key from a request dict.

    Uses the same canonical form as the TypeScript ``canonicalizeRequest``:
    ``JSON.stringify({ stage, command, args })`` with sorted keys.
    """
    canonical = json.dumps(
        {
            "stage": request_dict.get("stage", ""),
            "command": request_dict.get("command", ""),
            "args": _sort_keys(request_dict.get("args", {})),
        },
        separators=(",", ":"),
        sort_keys=False,  # we sort manually for nested structures
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _sort_keys(obj: Any) -> Any:
    """Recursively sort dict keys for deterministic JSON output."""
    if isinstance(obj, dict):
        return {k: _sort_keys(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_sort_keys(item) for item in obj]
    return obj


def _backfill_cache_keys(conn: sqlite3.Connection) -> None:
    """One-time backfill of cache_key for existing rows."""
    cur = conn.execute(
        "SELECT id, request FROM run_steps "
        "WHERE cache_key IS NULL AND request IS NOT NULL"
    )
    rows = cur.fetchall()
    if not rows:
        return
    for row_id, request_json in rows:
        try:
            req = json.loads(request_json)
            key = _compute_cache_key(req)
            conn.execute(
                "UPDATE run_steps SET cache_key = ? WHERE id = ?",
                (key, row_id),
            )
        except (json.JSONDecodeError, TypeError):
            continue
    conn.commit()


# ── Write operations ──────────────────────────────────────────────────

def save_run(conn: sqlite3.Connection, run: dict[str, Any]) -> None:
    """Persist a completed run and its steps in a single transaction."""
    cur = conn.cursor()
    try:
        cur.execute(
            """
            INSERT OR REPLACE INTO runs
                (id, started_at, completed_at, status, duration_ms,
                 mode, node_count, summary, graph_snapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run["id"],
                run["startedAt"],
                run.get("completedAt"),
                run["status"],
                run.get("durationMs"),
                run["mode"],
                run["nodeCount"],
                run.get("summary"),
                json.dumps(run["graphSnapshot"]) if run.get("graphSnapshot") else None,
            ),
        )
        for step in run.get("steps", []):
            # Prefer client-provided cacheKey (computed from unredacted request)
            # over server-side recomputation (which would hash redacted args).
            cache_key = step.get("cacheKey")
            if not cache_key and step.get("request"):
                cache_key = _compute_cache_key(step["request"])
            cur.execute(
                """
                INSERT INTO run_steps
                    (run_id, node_id, status, job_id, exit_code,
                     stdout, stderr, started_at, completed_at, duration_ms,
                     request, events, dry_run_argv, cache_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run["id"],
                    step["nodeId"],
                    step["status"],
                    step.get("jobId"),
                    step.get("exitCode"),
                    step.get("stdout", ""),
                    step.get("stderr", ""),
                    step.get("startedAt"),
                    step.get("completedAt"),
                    step.get("durationMs"),
                    json.dumps(step["request"]) if step.get("request") else None,
                    json.dumps(step.get("events", [])),
                    step.get("dryRunArgv"),
                    cache_key,
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ── Read operations ───────────────────────────────────────────────────

def list_runs(
    conn: sqlite3.Connection,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Return paginated run summaries (no step data, no stdout/stderr)."""
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM runs")
    total = cur.fetchone()[0]

    cur.execute(
        """
        SELECT id, started_at, completed_at, status, duration_ms,
               mode, node_count, summary
        FROM runs
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    )
    runs = [
        {
            "id": row[0],
            "startedAt": row[1],
            "completedAt": row[2],
            "status": row[3],
            "durationMs": row[4],
            "mode": row[5],
            "nodeCount": row[6],
            "summary": row[7],
        }
        for row in cur.fetchall()
    ]
    return {"runs": runs, "total": total}


def get_run(conn: sqlite3.Connection, run_id: str) -> dict[str, Any] | None:
    """Return a full run record with all steps, or None if not found."""
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id, started_at, completed_at, status, duration_ms,
               mode, node_count, summary, graph_snapshot
        FROM runs WHERE id = ?
        """,
        (run_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None

    run: dict[str, Any] = {
        "id": row[0],
        "startedAt": row[1],
        "completedAt": row[2],
        "status": row[3],
        "durationMs": row[4],
        "mode": row[5],
        "nodeCount": row[6],
        "summary": row[7],
        "graphSnapshot": json.loads(row[8]) if row[8] else None,
    }

    cur.execute(
        """
        SELECT node_id, status, job_id, exit_code,
               stdout, stderr, started_at, completed_at, duration_ms,
               request, events, dry_run_argv
        FROM run_steps WHERE run_id = ?
        ORDER BY id
        """,
        (run_id,),
    )
    run["steps"] = [
        {
            "nodeId": r[0],
            "status": r[1],
            "jobId": r[2],
            "exitCode": r[3],
            "stdout": r[4],
            "stderr": r[5],
            "startedAt": r[6],
            "completedAt": r[7],
            "durationMs": r[8],
            "request": json.loads(r[9]) if r[9] else None,
            "events": json.loads(r[10]) if r[10] else [],
            "dryRunArgv": r[11],
        }
        for r in cur.fetchall()
    ]
    return run


# ── Cache operations ──────────────────────────────────────────────────

def lookup_cache(
    conn: sqlite3.Connection,
    cache_key: str,
) -> dict[str, Any] | None:
    """Find the most recent successful step matching *cache_key*.

    Returns ``{"stdout", "stderr", "exit_code", "completed_at"}`` or ``None``.
    """
    cur = conn.execute(
        """
        SELECT stdout, stderr, exit_code, completed_at
        FROM run_steps
        WHERE cache_key = ? AND status = 'succeeded'
        ORDER BY completed_at DESC
        LIMIT 1
        """,
        (cache_key,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {
        "stdout": row[0],
        "stderr": row[1],
        "exit_code": row[2],
        "completed_at": row[3],
    }


# ── Delete operations ─────────────────────────────────────────────────

def delete_run(conn: sqlite3.Connection, run_id: str) -> bool:
    """Delete a run and its steps.  Returns True if the run existed."""
    cur = conn.cursor()
    cur.execute("DELETE FROM runs WHERE id = ?", (run_id,))
    conn.commit()
    return cur.rowcount > 0


def delete_all_runs(conn: sqlite3.Connection) -> int:
    """Delete all runs.  Returns the number of runs removed."""
    cur = conn.cursor()
    cur.execute("DELETE FROM runs")
    conn.commit()
    return cur.rowcount
