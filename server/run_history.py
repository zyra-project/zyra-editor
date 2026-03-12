"""
Lightweight SQLite-backed run history for the Zyra Editor.

Stores completed pipeline/node runs with per-step results, structured events,
and graph snapshots for replay.  Uses Python's built-in sqlite3 module — no
extra dependencies required.

The database file lives at ``$ZYRA_DATA_DIR/run_history.db`` (defaults to
``./run_history.db``), persisted via the existing ``_work:/data`` Docker mount.
"""

from __future__ import annotations

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
    db_path = os.path.join(data_dir, "run_history.db")
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


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
            cur.execute(
                """
                INSERT INTO run_steps
                    (run_id, node_id, status, job_id, exit_code,
                     stdout, stderr, started_at, completed_at, duration_ms,
                     request, events, dry_run_argv)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
