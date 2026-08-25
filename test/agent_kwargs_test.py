#!/usr/bin/env python3
"""Regression tests for the AIAgent kwargs _create_agent hands to Hermes.

The gateway is a turn-based HTTP API: the caller reads the response and replies
on the same session. Hermes' interactive `clarify` tool (which blocks the agent
loop until a human answers in-turn) must therefore not be exposed at all, and
the model must be told to ask by ending its turn with the question. A canned
clarify callback that says "the user is unavailable, make an assumption" made
agents silently pick a branch and run on it.
"""

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_worker


class _RecordingAgent:
    calls: list[dict] = []

    def __init__(self, **kwargs):
        _RecordingAgent.calls.append(kwargs)


def _fake_runtime_provider_module() -> types.ModuleType:
    module = types.ModuleType("hermes_cli.runtime_provider")

    def resolve_runtime_provider(**_kwargs):
        return {"provider": "openrouter", "base_url": "https://example.invalid/v1", "api_key": "k"}

    module.resolve_runtime_provider = resolve_runtime_provider
    return module


class CreateAgentKwargsTest(unittest.TestCase):
    def setUp(self):
        _RecordingAgent.calls = []
        params = {
            "model", "provider", "base_url", "api_key", "quiet_mode", "verbose_logging",
            "platform", "session_id", "session_db", "enabled_toolsets", "disabled_toolsets",
            "fallback_model", "clarify_callback", "ephemeral_system_prompt",
        }
        fake_hermes_cli = types.ModuleType("hermes_cli")
        fake_hermes_cli.__path__ = []  # mark as package so submodule lookups work
        self._patches = [
            mock.patch.object(hermes_worker, "_ensure_imports", lambda: None),
            mock.patch.object(hermes_worker, "_AIAgent", _RecordingAgent),
            mock.patch.object(hermes_worker, "_AIAgent_PARAMS", params),
            mock.patch.object(hermes_worker, "_SessionDB", None),
            mock.patch.object(hermes_worker, "_load_config", lambda: {}),
            mock.patch.object(hermes_worker, "_resolve_toolsets", lambda cfg: ["hermes-cli"]),
            mock.patch.dict(sys.modules, {
                "hermes_cli": fake_hermes_cli,
                "hermes_cli.runtime_provider": _fake_runtime_provider_module(),
            }),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in reversed(self._patches)])

    def _kwargs(self) -> dict:
        hermes_worker._create_agent(
            session_id="s1", requested_model="test-model", reasoning_effort=None,
        )
        self.assertEqual(len(_RecordingAgent.calls), 1)
        return _RecordingAgent.calls[0]

    def test_clarify_toolset_is_disabled(self):
        kwargs = self._kwargs()
        self.assertEqual(kwargs.get("enabled_toolsets"), ["hermes-cli"])
        self.assertIn("clarify", kwargs.get("disabled_toolsets") or [])

    def test_no_clarify_callback_is_registered(self):
        self.assertNotIn("clarify_callback", self._kwargs())

    def test_platform_hint_tells_model_to_ask_by_ending_the_turn(self):
        hint = self._kwargs().get("ephemeral_system_prompt") or ""
        self.assertIn("end the turn", hint)
        self.assertIn("no interactive clarify tool", hint)

    def test_ultra_reasoning_reaches_the_agent(self):
        # The top rungs (max/ultra) must survive the worker's own gate and land
        # on AIAgent's reasoning_config.
        with mock.patch.object(
            hermes_worker, "_AIAgent_PARAMS", set(hermes_worker._AIAgent_PARAMS) | {"reasoning_config"}
        ):
            hermes_worker._create_agent(
                session_id="s2", requested_model="test-model", reasoning_effort="ultra",
            )
        kwargs = _RecordingAgent.calls[-1]
        self.assertEqual(kwargs.get("reasoning_config"), {"enabled": True, "effort": "ultra"})


if __name__ == "__main__":
    unittest.main()
