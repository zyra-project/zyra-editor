"""
HTTP endpoint tests for the zyra-editor FastAPI server.

Uses FastAPI's TestClient (synchronous httpx wrapper) so no running
server is needed.  Endpoints that invoke the zyra CLI subprocess are
tested with subprocess.run mocked out.
"""
import json
import sys
import os
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set ZYRA_DATA_DIR to a temp dir before importing app so startup doesn't
# create a run_history.db in the working directory.
import atexit as _atexit
import shutil as _shutil
_test_data_dir = tempfile.mkdtemp(prefix="zyra-test-")
os.environ["ZYRA_DATA_DIR"] = _test_data_dir
_atexit.register(lambda: _shutil.rmtree(_test_data_dir, ignore_errors=True))

from main import app
from run_history import init_db

client = TestClient(app, raise_server_exceptions=False)


# ── /health ──────────────────────────────────────────────────────────────────

class TestHealthEndpoint:
    def test_returns_200(self):
        response = client.get("/health")
        assert response.status_code == 200

    def test_returns_ok_status(self):
        response = client.get("/health")
        data = response.json()
        assert data.get("status") == "ok"


# ── /ready ───────────────────────────────────────────────────────────────────

class TestReadyEndpoint:
    def test_returns_200_or_503(self):
        response = client.get("/ready")
        assert response.status_code in (200, 503)

    def test_returns_json_with_status_key(self):
        response = client.get("/ready")
        data = response.json()
        assert "status" in data


# ── /v1/manifest ─────────────────────────────────────────────────────────────

class TestManifestEndpoint:
    def setup_method(self):
        """Clear the manifest cache so each test gets a fresh fetch."""
        import main as main_mod
        if hasattr(main_mod._get_cached_manifest, "_cache"):
            del main_mod._get_cached_manifest._cache

    def _mock_commands_response(self):
        """Minimal /v1/commands payload that exercises the manifest builder.

        The server wraps the commands dict under a 'commands' key when it
        calls _commands_to_manifest(data.get('commands', {})).
        """
        commands = {
            "acquire http": {
                "description": "Fetch data over HTTP",
                "positionals": [],
                "options": {
                    "--url": {"type": "str", "help": "Target URL"},
                    "--retries": {"type": "int", "help": "Retry count", "default": 3},
                },
            },
            "export csv": {
                "description": "Export to CSV",
                "positionals": [],
                "options": {
                    "--output": {"type": "path", "help": "Output file"},
                },
            },
        }
        return {"commands": commands}

    def _make_mock_get(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = self._mock_commands_response()
        mock_get = MagicMock(return_value=mock_resp)
        return mock_get

    def test_manifest_has_version(self):
        with patch("main.http_requests.get", self._make_mock_get()):
            response = client.get("/v1/manifest")
            assert response.status_code == 200
            assert "version" in response.json()

    def test_manifest_has_stages_list(self):
        with patch("main.http_requests.get", self._make_mock_get()):
            data = client.get("/v1/manifest").json()
            assert "stages" in data
            assert isinstance(data["stages"], list)

    def test_manifest_always_includes_control_secret(self):
        with patch("main.http_requests.get", self._make_mock_get()):
            data = client.get("/v1/manifest").json()
            first = data["stages"][0]
            assert first["stage"] == "control"
            assert first["command"] == "secret"

    def test_manifest_contains_acquire_http(self):
        with patch("main.http_requests.get", self._make_mock_get()):
            data = client.get("/v1/manifest").json()
            keys = [f"{s['stage']}/{s['command']}" for s in data["stages"]]
            assert "acquire/http" in keys

    def test_export_stage_has_no_output_ports(self):
        with patch("main.http_requests.get", self._make_mock_get()):
            data = client.get("/v1/manifest").json()
            stages = {f"{s['stage']}/{s['command']}": s for s in data["stages"]}
            assert stages["export/csv"]["outputs"] == []


# ── /v1/plan/debug ───────────────────────────────────────────────────────────

class TestPlanDebugEndpoint:
    def test_returns_404_when_debug_disabled(self):
        import main as main_mod
        original = main_mod._DEBUG_ENABLED
        main_mod._DEBUG_ENABLED = False
        try:
            response = client.get("/v1/plan/debug")
            assert response.status_code == 404
        finally:
            main_mod._DEBUG_ENABLED = original

    def test_returns_200_when_debug_enabled(self):
        import main as main_mod
        original = main_mod._DEBUG_ENABLED
        main_mod._DEBUG_ENABLED = True
        try:
            with patch("subprocess.run") as mock_run:
                mock_result = MagicMock()
                mock_result.returncode = 0
                mock_result.stdout = "zyra 1.0.0"
                mock_result.stderr = ""
                mock_run.return_value = mock_result

                response = client.get("/v1/plan/debug")
                assert response.status_code == 200
                data = response.json()
                assert "openai_api_key" in data
        finally:
            main_mod._DEBUG_ENABLED = original


# ── /v1/plan ─────────────────────────────────────────────────────────────────

class TestPlanEndpoint:
    def test_returns_plan_json_on_success(self):
        plan_output = json.dumps({"agents": [{"stage": "acquire", "command": "http"}]})
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = plan_output
        mock_result.stderr = ""

        with patch("subprocess.run", return_value=mock_result):
            response = client.post("/v1/plan", json={"intent": "fetch SST data"})
            assert response.status_code == 200
            data = response.json()
            assert "agents" in data

    def test_returns_400_when_zyra_exits_nonzero(self):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "Error: no LLM configured"

        with patch("subprocess.run", return_value=mock_result):
            response = client.post("/v1/plan", json={"intent": "fetch data"})
            assert response.status_code == 400

    def test_returns_503_when_zyra_not_installed(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            response = client.post("/v1/plan", json={"intent": "fetch data"})
            assert response.status_code == 503

    def test_adds_warning_when_no_llm_configured(self, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("OLLAMA_HOST", raising=False)
        plan_output = json.dumps({"agents": []})
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = plan_output
        mock_result.stderr = ""

        with patch("subprocess.run", return_value=mock_result):
            response = client.post("/v1/plan", json={"intent": "test"})
            assert response.status_code == 200
            data = response.json()
            assert "_warning" in data


# ── /v1/plan/refine ──────────────────────────────────────────────────────────

class TestPlanRefineEndpoint:
    def test_returns_refined_plan(self):
        plan_output = json.dumps({"agents": [{"stage": "acquire", "command": "http"}]})
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = plan_output
        mock_result.stderr = ""

        with patch("subprocess.run", return_value=mock_result):
            response = client.post("/v1/plan/refine", json={
                "intent": "fetch data",
                "feedback": "add a filter step",
                "current_plan": {"agents": [{"stage": "acquire", "command": "http"}]},
                "guardrails": "",
            })
            assert response.status_code == 200

    def test_incorporates_feedback_into_intent(self):
        """The refined intent should combine original intent + feedback."""
        captured_cmd = []
        plan_output = json.dumps({"agents": []})
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = plan_output
        mock_result.stderr = ""

        def capture_run(cmd, **kwargs):
            captured_cmd.extend(cmd)
            return mock_result

        with patch("subprocess.run", side_effect=capture_run):
            client.post("/v1/plan/refine", json={
                "intent": "fetch data",
                "feedback": "add filtering",
                "current_plan": {},
                "guardrails": "",
            })

        intent_idx = captured_cmd.index("--intent")
        combined = captured_cmd[intent_idx + 1]
        assert "fetch data" in combined
        assert "add filtering" in combined


# ── /v1/feedback ─────────────────────────────────────────────────────────────

class TestFeedbackEndpoint:
    def test_saves_feedback_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            import main as main_mod
            original = main_mod.FEEDBACK_DIR
            main_mod.FEEDBACK_DIR = Path(tmpdir)
            try:
                response = client.post("/v1/feedback", json={
                    "name": "Test User",
                    "email": "test@example.com",
                    "type": "bug",
                    "message": "Something is broken",
                    "timestamp": "2026-01-01T00:00:00",
                    "userAgent": "TestClient/1.0",
                })
                assert response.status_code == 200
                data = response.json()
                assert data["status"] == "ok"

                # Verify the file was written
                files = list(Path(tmpdir).glob("feedback_*.json"))
                assert len(files) == 1
                saved = json.loads(files[0].read_text())
                assert saved["message"] == "Something is broken"
                assert saved["type"] == "bug"
            finally:
                main_mod.FEEDBACK_DIR = original

    def test_feedback_requires_message(self):
        response = client.post("/v1/feedback", json={})
        # FastAPI returns 422 when required fields are missing
        assert response.status_code == 422

    def test_feedback_file_contains_timestamp(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            import main as main_mod
            original = main_mod.FEEDBACK_DIR
            main_mod.FEEDBACK_DIR = Path(tmpdir)
            try:
                response = client.post("/v1/feedback", json={
                    "message": "feedback without timestamp",
                })
                assert response.status_code == 200
                files = list(Path(tmpdir).glob("feedback_*.json"))
                saved = json.loads(files[0].read_text())
                assert saved["timestamp"]  # auto-generated when not provided
            finally:
                main_mod.FEEDBACK_DIR = original


# ── /v1/runs ────────────────────────────────────────────────────────────────


def _make_run_payload(run_id="run-test-1", status="succeeded"):
    """Build a minimal run payload for endpoint tests."""
    return {
        "id": run_id,
        "startedAt": "2026-03-12T10:00:00Z",
        "completedAt": "2026-03-12T10:01:00Z",
        "status": status,
        "durationMs": 60000,
        "mode": "pipeline",
        "nodeCount": 1,
        "summary": None,
        "graphSnapshot": {"nodes": [{"id": "n1"}], "edges": []},
        "steps": [
            {
                "nodeId": "step-a",
                "status": status,
                "jobId": "job-abc",
                "exitCode": 0,
                "stdout": "output",
                "stderr": "",
                "startedAt": "2026-03-12T10:00:00Z",
                "completedAt": "2026-03-12T10:01:00Z",
                "durationMs": 60000,
                "request": {"stage": "acquire", "command": "http", "args": {"url": "http://example.com"}, "mode": "async"},
                "events": [],
                "dryRunArgv": None,
            }
        ],
    }


class TestRunHistoryEndpoints:
    """Tests for create/list/get/delete run history via HTTP endpoints."""

    @pytest.fixture(autouse=True)
    def _history_db(self, monkeypatch, tmp_path):
        """Provide a fresh temp DB, closed automatically after the test."""
        import main as main_mod
        monkeypatch.setenv("ZYRA_DATA_DIR", str(tmp_path))
        self._db = init_db()
        monkeypatch.setattr(main_mod, "_history_db", self._db)
        yield self._db
        self._db.close()

    def test_create_run(self):
        response = client.post("/v1/runs", json=_make_run_payload())
        assert response.status_code == 200
        assert response.json()["id"] == "run-test-1"

    def test_list_runs_empty(self):
        response = client.get("/v1/runs")
        assert response.status_code == 200
        data = response.json()
        assert data["runs"] == []
        assert data["total"] == 0

    def test_list_runs_returns_saved(self):
        client.post("/v1/runs", json=_make_run_payload("r1"))
        client.post("/v1/runs", json=_make_run_payload("r2"))
        response = client.get("/v1/runs")
        assert response.status_code == 200
        data = response.json()
        assert len(data["runs"]) == 2
        assert data["total"] == 2

    def test_list_runs_pagination(self):
        for i in range(5):
            client.post("/v1/runs", json=_make_run_payload(f"r{i}"))
        response = client.get("/v1/runs?limit=2&offset=0")
        assert len(response.json()["runs"]) == 2
        response2 = client.get("/v1/runs?limit=2&offset=2")
        assert len(response2.json()["runs"]) == 2

    def test_get_run(self):
        client.post("/v1/runs", json=_make_run_payload("r1"))
        response = client.get("/v1/runs/r1")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "r1"
        assert "steps" in data

    def test_get_run_not_found(self):
        response = client.get("/v1/runs/nonexistent")
        assert response.status_code == 404

    def test_delete_run(self):
        client.post("/v1/runs", json=_make_run_payload("r1"))
        response = client.delete("/v1/runs/r1")
        assert response.status_code == 204
        # Verify it's gone
        response2 = client.get("/v1/runs/r1")
        assert response2.status_code == 404

    def test_delete_run_not_found(self):
        response = client.delete("/v1/runs/nonexistent")
        assert response.status_code == 404


# ── /v1/cache/lookup ────────────────────────────────────────────────────────


class TestCacheLookupEndpoint:
    @pytest.fixture(autouse=True)
    def _history_db(self, monkeypatch, tmp_path):
        """Provide a fresh temp DB, closed automatically after the test."""
        import main as main_mod
        monkeypatch.setenv("ZYRA_DATA_DIR", str(tmp_path))
        self._db = init_db()
        monkeypatch.setattr(main_mod, "_history_db", self._db)
        yield self._db
        self._db.close()

    def test_cache_miss(self):
        response = client.get("/v1/cache/lookup?key=nonexistent")
        assert response.status_code == 200
        assert response.json()["hit"] is False

    def test_cache_hit_after_run(self):
        # Save a run so its cache key is populated
        client.post("/v1/runs", json=_make_run_payload("r1"))
        # Look up the cache key for step-a's request
        cur = self._db.execute("SELECT cache_key FROM run_steps WHERE node_id = 'step-a'")
        row = cur.fetchone()
        assert row is not None, "run_steps row for step-a should exist"
        assert row[0], "cache_key should be non-empty"
        response = client.get(f"/v1/cache/lookup?key={row[0]}")
        assert response.status_code == 200
        data = response.json()
        assert data["hit"] is True
