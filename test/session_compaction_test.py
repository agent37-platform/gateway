#!/usr/bin/env python3
"""Regression tests for project_session_messages and mid-turn compaction.

Hermes records its own compaction summary as a `role=user` row. The projector
uses that row to gate output in a compression CHILD session (hold the transcript
back until the user speaks again), but the ROOT session already carries the
prompt — so gating there dropped the rest of a turn that compacted mid-flight.
An automated turn (scheduled task, cron prompt) never sends a second user
message, so its answer was lost for good.
"""

import itertools
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_sessions


class FakeSessionDB:
    """Minimal stand-in: no Hermes, no sqlite. Lineage is whatever we pass in."""

    db_path = None

    def __init__(self, rows_by_session):
        self._rows = rows_by_session

    def get_messages(self, session_id):
        return self._rows.get(session_id, [])


def project(rows_by_session, lineage):
    """Run project_session_messages over fake rows, bypassing Hermes/sqlite."""
    db = FakeSessionDB(rows_by_session)
    original_open = hermes_sessions.open_session
    original_lineage = hermes_sessions._session_lineage_ids
    hermes_sessions.open_session = lambda sid, **kw: (db, sid)
    hermes_sessions._session_lineage_ids = lambda _db, _root: lineage
    try:
        return hermes_sessions.project_session_messages(lineage[0])["messages"]
    finally:
        hermes_sessions.open_session = original_open
        hermes_sessions._session_lineage_ids = original_lineage


def msg(role, content, **extra):
    row = {"id": next(_ids), "role": role, "content": content, "timestamp": 1_700_000_000}
    row.update(extra)
    return row


_ids = itertools.count(1)

COMPACTION = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the "
    "summary below. This is a handoff from a previous context window."
)


class CompactedTurnTest(unittest.TestCase):
    def test_root_session_keeps_the_answer_after_a_mid_turn_compaction(self):
        """A scheduled task that compacts mid-turn still projects its answer."""
        rows = [
            msg("user", "[Scheduled task: Morning brief]\nPrepare my briefing."),
            msg("assistant", "", tool_calls=[{"id": "c1"}]),
            msg("tool", "<180 KB of tool output>"),
            msg("user", COMPACTION),
            msg("assistant", "", tool_calls=[{"id": "c2"}]),
            msg("tool", "<more tool output>"),
            msg("assistant", "Here is your briefing: ..."),
        ]
        projected = project({"root": rows}, ["root"])

        roles = [m["role"] for m in projected]
        self.assertEqual(roles, ["user", "system", "assistant"])
        self.assertEqual(projected[1]["content"], hermes_sessions.COMPACTION_MARKER_TEXT)
        self.assertEqual(projected[2]["content"], "Here is your briefing: ...")

    def test_compression_child_still_waits_for_the_next_user_message(self):
        """A child session's pre-handoff replay stays hidden; the new turn shows."""
        root = [
            msg("user", "first question"),
            msg("assistant", "first answer"),
        ]
        child = [
            msg("user", COMPACTION),
            msg("assistant", "replayed context the user never asked for"),
            msg("user", "second question"),
            msg("assistant", "second answer"),
        ]
        projected = project({"root": root, "child": child}, ["root", "child"])

        contents = [m["content"] for m in projected]
        self.assertNotIn("replayed context the user never asked for", contents)
        self.assertEqual(contents[-2:], ["second question", "second answer"])


if __name__ == "__main__":
    unittest.main()
