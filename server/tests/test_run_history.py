"""
Unit tests for the run_history SQLite module.

Tests use an in-memory database (via monkeypatch) to avoid filesystem side-effects.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from run_history import init_db, save_run, list_runs, get_run, delete_run, delete_all_runs


@pytest.fixture()
def db(monkeypatch, tmp_path):
    """Provide a fresh SQLite database for each test."""
    monkeypatch.setenv("ZYRA_DATA_DIR", str(tmp_path))
    conn = init_db()
    yield conn
    conn.close()


def _make_run(run_id="run-1", status="succeeded", mode="pipeline", steps=None):
    """Build a minimal run dict for testing."""
    return {
        "id": run_id,
        "startedAt": "2026-03-12T10:00:00Z",
        "completedAt": "2026-03-12T10:01:00Z",
        "status": status,
        "durationMs": 60000,
        "mode": mode,
        "nodeCount": len(steps) if steps else 1,
        "summary": None,
        "graphSnapshot": {"nodes": [{"id": "n1"}], "edges": []},
        "steps": steps or [
            {
                "nodeId": "step-a",
                "status": "succeeded",
                "jobId": "job-abc",
                "exitCode": 0,
                "stdout": "hello world",
                "stderr": "",
                "startedAt": "2026-03-12T10:00:00Z",
                "completedAt": "2026-03-12T10:01:00Z",
                "durationMs": 60000,
                "request": {"stage": "acquire", "command": "http", "args": {"url": "http://example.com"}, "mode": "async"},
                "events": [
                    {"type": "submitted", "timestamp": 1710230400000, "message": "Submitted"},
                    {"type": "completed", "timestamp": 1710230460000, "message": "Done"},
                ],
                "dryRunArgv": None,
            }
        ],
    }


# ── init_db ──────────────────────────────────────────────────────────

class TestInitDb:
    def test_creates_tables(self, db):
        cur = db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        tables = [row[0] for row in cur.fetchall()]
        assert "runs" in tables
        assert "run_steps" in tables

    def test_wal_mode_enabled(self, db):
        cur = db.execute("PRAGMA journal_mode")
        mode = cur.fetchone()[0]
        assert mode == "wal"

    def test_foreign_keys_enabled(self, db):
        cur = db.execute("PRAGMA foreign_keys")
        assert cur.fetchone()[0] == 1


# ── save_run ─────────────────────────────────────────────────────────

class TestSaveRun:
    def test_inserts_run_and_steps(self, db):
        run = _make_run()
        save_run(db, run)

        cur = db.execute("SELECT COUNT(*) FROM runs")
        assert cur.fetchone()[0] == 1

        cur = db.execute("SELECT COUNT(*) FROM run_steps")
        assert cur.fetchone()[0] == 1

    def test_stores_graph_snapshot_as_json(self, db):
        run = _make_run()
        save_run(db, run)

        cur = db.execute("SELECT graph_snapshot FROM runs WHERE id = ?", (run["id"],))
        raw = cur.fetchone()[0]
        snapshot = json.loads(raw)
        assert snapshot["nodes"] == [{"id": "n1"}]
        assert snapshot["edges"] == []

    def test_stores_events_as_json(self, db):
        run = _make_run()
        save_run(db, run)

        cur = db.execute("SELECT events FROM run_steps WHERE run_id = ?", (run["id"],))
        events = json.loads(cur.fetchone()[0])
        assert len(events) == 2
        assert events[0]["type"] == "submitted"

    def test_stores_request_as_json(self, db):
        run = _make_run()
        save_run(db, run)

        cur = db.execute("SELECT request FROM run_steps WHERE run_id = ?", (run["id"],))
        req = json.loads(cur.fetchone()[0])
        assert req["stage"] == "acquire"
        assert req["command"] == "http"

    def test_multiple_steps(self, db):
        steps = [
            {
                "nodeId": f"step-{i}",
                "status": "succeeded",
                "stdout": f"output-{i}",
                "stderr": "",
                "events": [],
            }
            for i in range(3)
        ]
        run = _make_run(steps=steps)
        save_run(db, run)

        cur = db.execute("SELECT COUNT(*) FROM run_steps WHERE run_id = ?", (run["id"],))
        assert cur.fetchone()[0] == 3

    def test_replace_on_duplicate_id(self, db):
        run = _make_run(status="failed")
        save_run(db, run)

        run["status"] = "succeeded"
        save_run(db, run)

        cur = db.execute("SELECT status FROM runs WHERE id = ?", (run["id"],))
        assert cur.fetchone()[0] == "succeeded"

    def test_null_graph_snapshot(self, db):
        run = _make_run()
        run["graphSnapshot"] = None
        save_run(db, run)

        cur = db.execute("SELECT graph_snapshot FROM runs WHERE id = ?", (run["id"],))
        assert cur.fetchone()[0] is None


# ── list_runs ────────────────────────────────────────────────────────

class TestListRuns:
    def test_empty_database(self, db):
        result = list_runs(db)
        assert result["runs"] == []
        assert result["total"] == 0

    def test_returns_summaries_ordered_by_started_at_desc(self, db):
        for i in range(3):
            run = _make_run(run_id=f"run-{i}")
            run["startedAt"] = f"2026-03-12T1{i}:00:00Z"
            save_run(db, run)

        result = list_runs(db)
        assert result["total"] == 3
        ids = [r["id"] for r in result["runs"]]
        assert ids == ["run-2", "run-1", "run-0"]

    def test_does_not_include_graph_snapshot(self, db):
        save_run(db, _make_run())
        result = list_runs(db)
        assert "graphSnapshot" not in result["runs"][0]

    def test_pagination_with_limit_and_offset(self, db):
        for i in range(5):
            run = _make_run(run_id=f"run-{i}")
            run["startedAt"] = f"2026-03-12T1{i}:00:00Z"
            save_run(db, run)

        result = list_runs(db, limit=2, offset=0)
        assert len(result["runs"]) == 2
        assert result["total"] == 5
        assert result["runs"][0]["id"] == "run-4"

        result2 = list_runs(db, limit=2, offset=2)
        assert len(result2["runs"]) == 2
        assert result2["runs"][0]["id"] == "run-2"


# ── get_run ──────────────────────────────────────────────────────────

class TestGetRun:
    def test_returns_none_for_missing_run(self, db):
        assert get_run(db, "nonexistent") is None

    def test_returns_full_run_with_steps(self, db):
        save_run(db, _make_run())
        result = get_run(db, "run-1")

        assert result is not None
        assert result["id"] == "run-1"
        assert result["status"] == "succeeded"
        assert len(result["steps"]) == 1
        assert result["steps"][0]["nodeId"] == "step-a"
        assert result["steps"][0]["stdout"] == "hello world"

    def test_returns_parsed_graph_snapshot(self, db):
        save_run(db, _make_run())
        result = get_run(db, "run-1")
        assert result["graphSnapshot"]["nodes"] == [{"id": "n1"}]

    def test_returns_parsed_events(self, db):
        save_run(db, _make_run())
        result = get_run(db, "run-1")
        events = result["steps"][0]["events"]
        assert len(events) == 2
        assert events[0]["type"] == "submitted"

    def test_returns_parsed_request(self, db):
        save_run(db, _make_run())
        result = get_run(db, "run-1")
        req = result["steps"][0]["request"]
        assert req["stage"] == "acquire"


# ── delete_run ───────────────────────────────────────────────────────

class TestDeleteRun:
    def test_deletes_run_and_steps(self, db):
        save_run(db, _make_run())
        assert delete_run(db, "run-1") is True

        assert get_run(db, "run-1") is None
        cur = db.execute("SELECT COUNT(*) FROM run_steps WHERE run_id = 'run-1'")
        assert cur.fetchone()[0] == 0

    def test_returns_false_for_missing_run(self, db):
        assert delete_run(db, "nonexistent") is False


# ── delete_all_runs ──────────────────────────────────────────────────

class TestDeleteAllRuns:
    def test_clears_all_runs(self, db):
        for i in range(3):
            save_run(db, _make_run(run_id=f"run-{i}"))

        count = delete_all_runs(db)
        assert count == 3

        result = list_runs(db)
        assert result["total"] == 0

    def test_returns_zero_on_empty_database(self, db):
        assert delete_all_runs(db) == 0
