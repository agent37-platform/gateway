// Regression gate for the session projector and mid-turn compaction: a turn that
// compacts mid-flight must still project its final answer, while a compression
// child keeps holding its replay back until the user speaks again. Pure unit
// tests — no live Hermes/LLM needed. The assertions live in
// test/session_compaction_test.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('session projection keeps the final answer when a turn compacts mid-flight', () => {
  const result = spawnSync('python3', ['test/session_compaction_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `python unit tests failed:\n${result.stdout}\n${result.stderr}`);
});
