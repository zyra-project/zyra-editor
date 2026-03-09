"""
Tests for the manifest-building helpers in main.py.

These functions are pure Python — no zyra CLI required.
"""
import sys
import os

import pytest

# Make server/ importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import (
    _opt_to_arg,
    _positional_to_arg,
    _commands_to_manifest,
    _resolve_env_vars,
    _resolve_argv_env_vars,
    _apply_scope,
    STAGE_COLORS,
    DEFAULT_COLOR,
    PLAN_SCOPE,
)


# ── _opt_to_arg ──────────────────────────────────────────────────────────────

class TestOptToArg:
    def test_skips_help_flag(self):
        assert _opt_to_arg("--help", {}) is None

    def test_string_description_produces_basic_arg(self):
        arg = _opt_to_arg("--format", "Output format")
        assert arg is not None
        assert arg["key"] == "format"
        assert arg["flag"] == "--format"
        assert arg["type"] == "string"
        assert arg["description"] == "Output format"
        assert arg["required"] is False

    def test_flag_with_choices_maps_to_enum(self):
        arg = _opt_to_arg("--mode", {"choices": ["a", "b"], "help": "mode"})
        assert arg["type"] == "enum"
        assert arg["options"] == ["a", "b"]

    def test_flag_with_int_type_maps_to_number(self):
        arg = _opt_to_arg("--count", {"type": "int", "help": ""})
        assert arg["type"] == "number"

    def test_flag_with_float_type_maps_to_number(self):
        arg = _opt_to_arg("--threshold", {"type": "float", "help": ""})
        assert arg["type"] == "number"

    def test_flag_with_bool_type_maps_to_boolean(self):
        arg = _opt_to_arg("--verbose", {"type": "bool", "help": ""})
        assert arg["type"] == "boolean"

    def test_flag_with_path_arg_maps_to_filepath(self):
        arg = _opt_to_arg("--output", {"path_arg": True, "help": ""})
        assert arg["type"] == "filepath"

    def test_flag_with_path_type_maps_to_filepath(self):
        arg = _opt_to_arg("--output", {"type": "path", "help": ""})
        assert arg["type"] == "filepath"

    def test_default_is_preserved(self):
        arg = _opt_to_arg("--retries", {"type": "int", "default": 3, "help": ""})
        assert arg["default"] == 3

    def test_no_default_key_when_absent(self):
        arg = _opt_to_arg("--format", {"type": "str", "help": ""})
        assert "default" not in arg

    def test_key_derived_from_flag_strips_dashes(self):
        arg = _opt_to_arg("--since-period", {"type": "str", "help": ""})
        assert arg["key"] == "since_period"

    def test_label_title_cases_flag_name(self):
        arg = _opt_to_arg("--output-file", {"type": "str", "help": ""})
        assert arg["label"] == "Output File"

    def test_help_text_becomes_placeholder(self):
        arg = _opt_to_arg("--url", {"type": "str", "help": "URL to fetch"})
        assert arg["placeholder"] == "URL to fetch"

    def test_no_placeholder_when_no_help(self):
        arg = _opt_to_arg("--url", {"type": "str", "help": ""})
        assert "placeholder" not in arg


# ── _positional_to_arg ───────────────────────────────────────────────────────

class TestPositionalToArg:
    def test_returns_none_for_empty_name(self):
        assert _positional_to_arg({}) is None
        assert _positional_to_arg({"name": ""}) is None

    def test_basic_positional(self):
        arg = _positional_to_arg({"name": "input_file", "help": "Source file", "type": "str", "required": True})
        assert arg["key"] == "input_file"
        assert arg["label"] == "Input File"
        assert arg["type"] == "string"
        assert arg["required"] is True

    def test_positional_with_choices_is_enum(self):
        arg = _positional_to_arg({"name": "fmt", "choices": ["csv", "json"], "type": "str", "required": False})
        assert arg["type"] == "enum"
        assert arg["options"] == ["csv", "json"]

    def test_positional_int_type(self):
        arg = _positional_to_arg({"name": "limit", "type": "int", "required": False})
        assert arg["type"] == "number"

    def test_positional_path_type(self):
        arg = _positional_to_arg({"name": "dest", "type": "path", "required": False})
        assert arg["type"] == "filepath"

    def test_default_is_preserved(self):
        arg = _positional_to_arg({"name": "n", "type": "int", "default": 10, "required": False})
        assert arg["default"] == 10

    def test_help_becomes_placeholder(self):
        arg = _positional_to_arg({"name": "url", "type": "str", "help": "Target URL", "required": False})
        assert arg["placeholder"] == "Target URL"

    def test_label_replaces_underscores_and_hyphens(self):
        arg = _positional_to_arg({"name": "output-file", "type": "str", "required": False})
        assert arg["label"] == "Output File"


# ── _commands_to_manifest ────────────────────────────────────────────────────

class TestCommandsToManifest:
    def _simple_commands(self):
        return {
            "acquire http": {
                "description": "Fetch data over HTTP",
                "positionals": [],
                "options": {"--url": {"type": "str", "help": "URL"}},
            }
        }

    def test_version_is_1_0(self):
        result = _commands_to_manifest(self._simple_commands())
        assert result["version"] == "1.0"

    def test_stages_list_is_present(self):
        result = _commands_to_manifest(self._simple_commands())
        assert "stages" in result
        assert isinstance(result["stages"], list)

    def test_control_secret_node_is_always_first(self):
        result = _commands_to_manifest(self._simple_commands())
        assert result["stages"][0]["stage"] == "control"
        assert result["stages"][0]["command"] == "secret"

    def test_stage_command_extracted_from_key(self):
        result = _commands_to_manifest(self._simple_commands())
        stages = {f"{s['stage']}/{s['command']}": s for s in result["stages"]}
        assert "acquire/http" in stages

    def test_cli_field_is_zyra_prefix_plus_key(self):
        result = _commands_to_manifest(self._simple_commands())
        stages = {f"{s['stage']}/{s['command']}": s for s in result["stages"]}
        assert stages["acquire/http"]["cli"] == "zyra acquire http"

    def test_stage_color_assigned_correctly(self):
        result = _commands_to_manifest(self._simple_commands())
        stages = {f"{s['stage']}/{s['command']}": s for s in result["stages"]}
        assert stages["acquire/http"]["color"] == STAGE_COLORS["acquire"]

    def test_unknown_stage_gets_default_color(self):
        result = _commands_to_manifest({"mystery foo": {"positionals": [], "options": {}}})
        stages = {f"{s['stage']}/{s['command']}": s for s in result["stages"]}
        assert stages["mystery/foo"]["color"] == DEFAULT_COLOR

    def test_hidden_run_stage_is_excluded(self):
        cmds = {**self._simple_commands(), "run pipeline": {"positionals": [], "options": {}}}
        result = _commands_to_manifest(cmds)
        stage_keys = [f"{s['stage']}/{s['command']}" for s in result["stages"]]
        assert "run/pipeline" not in stage_keys

    def test_aliased_stage_is_remapped(self):
        result = _commands_to_manifest({"import ftp": {"positionals": [], "options": {}}})
        # "import" is aliased to "acquire", but since raw_stage != canonical stage it's skipped
        stage_keys = [f"{s['stage']}/{s['command']}" for s in result["stages"]]
        assert "import/ftp" not in stage_keys

    def test_sink_stage_has_no_output_ports(self):
        result = _commands_to_manifest({"export csv": {"positionals": [], "options": {}}})
        stages = {f"{s['stage']}/{s['command']}": s for s in result["stages"]}
        assert stages["export/csv"]["outputs"] == []

    def test_description_included_when_present(self):
        result = _commands_to_manifest(self._simple_commands())
        stages = {f"{s['stage']}/{s['command']}": s for s in result["stages"]}
        assert stages["acquire/http"]["description"] == "Fetch data over HTTP"

    def test_args_built_from_options(self):
        result = _commands_to_manifest(self._simple_commands())
        stages = {f"{s['stage']}/{s['command']}": s for s in result["stages"]}
        arg_keys = [a["key"] for a in stages["acquire/http"]["args"]]
        assert "url" in arg_keys

    def test_deduplication_of_same_stage_command(self):
        cmds = {
            "acquire http": {"positionals": [], "options": {}},
            # same key twice — shouldn't happen in practice but guard against it
        }
        result = _commands_to_manifest({**cmds, **cmds})
        stage_keys = [f"{s['stage']}/{s['command']}" for s in result["stages"]]
        assert stage_keys.count("acquire/http") == 1


# ── _resolve_env_vars ────────────────────────────────────────────────────────

class TestResolveEnvVars:
    def test_replaces_set_variable(self, monkeypatch):
        monkeypatch.setenv("MY_KEY", "secret123")
        assert _resolve_env_vars("${MY_KEY}") == "secret123"

    def test_leaves_unset_variable_as_is(self, monkeypatch):
        monkeypatch.delenv("UNSET_VAR", raising=False)
        assert _resolve_env_vars("${UNSET_VAR}") == "${UNSET_VAR}"

    def test_replaces_variable_embedded_in_string(self, monkeypatch):
        monkeypatch.setenv("HOST", "example.com")
        assert _resolve_env_vars("https://${HOST}/api") == "https://example.com/api"

    def test_no_substitution_when_no_placeholder(self):
        assert _resolve_env_vars("plain-value") == "plain-value"

    def test_multiple_placeholders_in_one_string(self, monkeypatch):
        monkeypatch.setenv("A", "foo")
        monkeypatch.setenv("B", "bar")
        assert _resolve_env_vars("${A}-${B}") == "foo-bar"


# ── _resolve_argv_env_vars ───────────────────────────────────────────────────

class TestResolveArgvEnvVars:
    def test_resolves_full_placeholder_argument(self, monkeypatch):
        monkeypatch.setenv("TOKEN", "abc123")
        result = _resolve_argv_env_vars(["zyra", "acquire", "http", "${TOKEN}"])
        assert result == ["zyra", "acquire", "http", "abc123"]

    def test_does_not_resolve_partial_placeholder(self, monkeypatch):
        monkeypatch.setenv("HOST", "example.com")
        result = _resolve_argv_env_vars(["https://${HOST}/api"])
        # partial match: the arg is NOT a fullmatch → left as-is
        assert result == ["https://${HOST}/api"]

    def test_passes_through_non_placeholder_args(self):
        result = _resolve_argv_env_vars(["--format", "json"])
        assert result == ["--format", "json"]

    def test_empty_argv(self):
        assert _resolve_argv_env_vars([]) == []


# ── _apply_scope ─────────────────────────────────────────────────────────────

class TestApplyScope:
    def test_appends_plan_scope_when_configured(self, monkeypatch):
        monkeypatch.setattr("main.PLAN_SCOPE", " [scope]")
        from main import _apply_scope as fresh_apply_scope
        # Re-import to pick up the monkeypatched value
        import importlib, main as main_mod
        main_mod.PLAN_SCOPE = " [scope]"
        result = main_mod._apply_scope("fetch data")
        assert result == "fetch data [scope]"

    def test_returns_intent_unchanged_when_scope_empty(self):
        import main as main_mod
        original = main_mod.PLAN_SCOPE
        main_mod.PLAN_SCOPE = ""
        try:
            result = main_mod._apply_scope("fetch data")
            assert result == "fetch data"
        finally:
            main_mod.PLAN_SCOPE = original
