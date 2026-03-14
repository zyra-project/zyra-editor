"""
Unit tests for the run_history cache-key functionality.

Tests cover: cache_key migration, cache_key computation on save,
lookup_cache, and backfill of existing rows.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from run_history import init_db, save_run, lookup_cache, _compute_cache_key


@pytest.fixture()
def db(monkeypatch, tmp_path):
    """Provide a fresh SQLite database for each test."""
    monkeypatch.setenv("ZYRA_DATA_DIR", str(tmp_path))
    conn = init_db()
    yield conn
    conn.close()


def _make_run(run_id="run-1", status="succeeded", steps=None):
    """Build a minimal run dict for testing."""
    return {
        "id": run_id,
        "startedAt": "2026-03-12T10:00:00Z",
        "completedAt": "2026-03-12T10:01:00Z",
        "status": status,
        "durationMs": 60000,
        "mode": "pipeline",
        "nodeCount": 1,
        "summary": None,
        "graphSnapshot": None,
        "steps": steps or [
            {
                "nodeId": "step-a",
                "status": "succeeded",
                "exitCode": 0,
                "stdout": "hello world",
                "stderr": "",
                "startedAt": "2026-03-12T10:00:00Z",
                "completedAt": "2026-03-12T10:01:00Z",
                "durationMs": 60000,
                "request": {
                    "stage": "acquire",
                    "command": "http",
                    "args": {"url": "http://example.com"},
                    "mode": "async",
                },
                "events": [],
                "dryRunArgv": None,
            }
        ],
    }


# ── _compute_cache_key ────────────────────────────────────────────────

class TestComputeCacheKey:
    def test_deterministic(self):
        req = {"stage": "acquire", "command": "http", "args": {"url": "http://example.com"}}
        a = _compute_cache_key(req)
        b = _compute_cache_key(req)
        assert a == b

    def test_ignores_mode(self):
        req_a = {"stage": "acquire", "command": "http", "args": {}, "mode": "async"}
        req_b = {"stage": "acquire", "command": "http", "args": {}, "mode": "sync"}
        # mode is not included in canonical form
        assert _compute_cache_key(req_a) == _compute_cache_key(req_b)

    def test_different_stage_different_key(self):
        a = _compute_cache_key({"stage": "acquire", "command": "http", "args": {}})
        b = _compute_cache_key({"stage": "process", "command": "http", "args": {}})
        assert a != b

    def test_different_args_different_key(self):
        a = _compute_cache_key({"stage": "acquire", "command": "http", "args": {"url": "a"}})
        b = _compute_cache_key({"stage": "acquire", "command": "http", "args": {"url": "b"}})
        assert a != b

    def test_arg_order_independent(self):
        a = _compute_cache_key({"stage": "s", "command": "c", "args": {"x": 1, "y": 2}})
        b = _compute_cache_key({"stage": "s", "command": "c", "args": {"y": 2, "x": 1}})
        assert a == b

    def test_returns_64_hex_chars(self):
        key = _compute_cache_key({"stage": "s", "command": "c", "args": {}})
        assert len(key) == 64
        assert all(c in "0123456789abcdef" for c in key)


# ── cache_key stored on save ──────────────────────────────────────────

class TestCacheKeyOnSave:
    def test_cache_key_populated_on_insert(self, db):
        run = _make_run()
        save_run(db, run)

        cur = db.execute("SELECT cache_key FROM run_steps WHERE run_id = ?", (run["id"],))
        cache_key = cur.fetchone()[0]
        assert cache_key is not None
        assert len(cache_key) == 64

    def test_cache_key_matches_expected(self, db):
        run = _make_run()
        save_run(db, run)

        cur = db.execute("SELECT cache_key FROM run_steps WHERE run_id = ?", (run["id"],))
        stored = cur.fetchone()[0]
        expected = _compute_cache_key(run["steps"][0]["request"])
        assert stored == expected

    def test_null_request_gives_null_cache_key(self, db):
        run = _make_run()
        run["steps"][0]["request"] = None
        save_run(db, run)

        cur = db.execute("SELECT cache_key FROM run_steps WHERE run_id = ?", (run["id"],))
        assert cur.fetchone()[0] is None


# ── lookup_cache ──────────────────────────────────────────────────────

class TestLookupCache:
    def test_returns_none_on_miss(self, db):
        assert lookup_cache(db, "nonexistent") is None

    def test_returns_result_on_hit(self, db):
        run = _make_run()
        save_run(db, run)

        key = _compute_cache_key(run["steps"][0]["request"])
        result = lookup_cache(db, key)

        assert result is not None
        assert result["stdout"] == "hello world"
        assert result["stderr"] == ""
        assert result["exit_code"] == 0

    def test_only_matches_succeeded_steps(self, db):
        run = _make_run(status="failed")
        run["steps"][0]["status"] = "failed"
        save_run(db, run)

        key = _compute_cache_key(run["steps"][0]["request"])
        assert lookup_cache(db, key) is None

    def test_returns_most_recent_on_multiple_matches(self, db):
        # First run
        run1 = _make_run(run_id="run-1")
        run1["steps"][0]["stdout"] = "first"
        run1["steps"][0]["completedAt"] = "2026-03-12T10:00:00Z"
        save_run(db, run1)

        # Second run with same request but later timestamp
        run2 = _make_run(run_id="run-2")
        run2["steps"][0]["stdout"] = "second"
        run2["steps"][0]["completedAt"] = "2026-03-12T11:00:00Z"
        save_run(db, run2)

        key = _compute_cache_key(run1["steps"][0]["request"])
        result = lookup_cache(db, key)
        assert result["stdout"] == "second"


# ── backfill ──────────────────────────────────────────────────────────

class TestBackfill:
    def test_backfill_populates_null_cache_keys(self, db):
        """Insert a row with NULL cache_key, reinit, check it's filled."""
        run = _make_run()
        save_run(db, run)

        # Manually null out the cache_key
        db.execute("UPDATE run_steps SET cache_key = NULL WHERE run_id = ?", (run["id"],))
        db.commit()

        cur = db.execute("SELECT cache_key FROM run_steps WHERE run_id = ?", (run["id"],))
        assert cur.fetchone()[0] is None

        # Re-init triggers backfill
        from run_history import _backfill_cache_keys
        _backfill_cache_keys(db)

        cur = db.execute("SELECT cache_key FROM run_steps WHERE run_id = ?", (run["id"],))
        key = cur.fetchone()[0]
        assert key is not None
        assert len(key) == 64
