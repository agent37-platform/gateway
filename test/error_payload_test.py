#!/usr/bin/env python3
"""Regression tests for _error_payload: the failure-text classifier that turns a
provider/agent exception into the worker's {code, message, hint} payload.

Hermes summarizes an HTTP 402 body down to its `message` (the `type` field is
dropped), so both managed refusals must classify by their message text alone.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_worker


class ErrorPayloadTest(unittest.TestCase):
    def test_wallet_empty_refusal_is_quota_exhausted(self):
        payload = hermes_worker._error_payload(
            Exception("HTTP 402: Workspace balance exhausted. Top up the workspace wallet to continue.")
        )
        self.assertEqual(payload["code"], "quota_exhausted")
        self.assertIn("workspace balance", payload["hint"])

    def test_instance_budget_refusal_is_quota_exhausted(self):
        payload = hermes_worker._error_payload(
            Exception("HTTP 402: Instance budget exhausted. Raise the monthly cap or top up this instance to continue.")
        )
        self.assertEqual(payload["code"], "quota_exhausted")

    def test_retry_wrapped_budget_refusal_beats_rate_limit(self):
        payload = hermes_worker._error_payload(
            Exception("Rate limited after 3 retries — HTTP 402: Instance budget exhausted.")
        )
        self.assertEqual(payload["code"], "quota_exhausted")

    def test_unrelated_failure_stays_generic(self):
        payload = hermes_worker._error_payload(Exception("upstream connect error"))
        self.assertEqual(payload["code"], "worker_error")
        self.assertNotIn("hint", payload)


if __name__ == "__main__":
    unittest.main()
