#!/usr/bin/env python3
"""Regression tests for _resolve_model_provider (managed custom-provider routing).

Catalog model ids like "anthropic/claude-sonnet-5" must stay on a configured
custom: provider (the managed Agent37 starter proxy) instead of being re-routed
to the built-in openrouter provider, which holds no credentials on managed
instances (HTTP 401 "User not found").
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_worker

PROXY_URL = "https://www.agent37.com/api/openclaw/starter-proxy/v1"

MANAGED_CFG = {
    "model": {"default": "default", "provider": "custom:agent37"},
    "custom_providers": [
        {
            "name": "Agent37",
            "base_url": PROXY_URL,
            "api_key": "token",
            "api_mode": "chat_completions",
            "model": "default",
        }
    ],
}


class ResolveModelProviderTest(unittest.TestCase):
    def test_explicit_custom_provider_honored_for_catalog_model(self):
        result = hermes_worker._resolve_model_provider(
            "anthropic/claude-sonnet-5", MANAGED_CFG, requested_provider="custom:agent37"
        )
        self.assertEqual(result, ("anthropic/claude-sonnet-5", "custom:agent37", PROXY_URL))

    def test_config_custom_provider_honored_without_explicit_provider(self):
        result = hermes_worker._resolve_model_provider("openai/gpt-4o-mini", MANAGED_CFG)
        self.assertEqual(result, ("openai/gpt-4o-mini", "custom:agent37", PROXY_URL))

    def test_default_model_unchanged(self):
        result = hermes_worker._resolve_model_provider(
            "default", MANAGED_CFG, requested_provider="custom:agent37"
        )
        self.assertEqual(result, ("default", "custom:agent37", PROXY_URL))

    def test_explicit_openrouter_still_routes_to_openrouter(self):
        model, provider, _ = hermes_worker._resolve_model_provider(
            "anthropic/claude-sonnet-5", MANAGED_CFG, requested_provider="openrouter"
        )
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))

    def test_at_provider_syntax_still_overrides_config_provider(self):
        model, provider, _ = hermes_worker._resolve_model_provider(
            "@openrouter:anthropic/claude-sonnet-5", MANAGED_CFG
        )
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))

    def test_openrouter_config_provider_unchanged(self):
        cfg = {"model": {"default": "anthropic/claude-sonnet-5", "provider": "openrouter"}}
        model, provider, _ = hermes_worker._resolve_model_provider("anthropic/claude-sonnet-5", cfg)
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))


if __name__ == "__main__":
    unittest.main()
