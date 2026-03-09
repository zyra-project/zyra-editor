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

from main import app

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
