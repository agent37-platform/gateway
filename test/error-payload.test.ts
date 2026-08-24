// Regression gate for the Python worker's _error_payload classifier: managed
// refusals (empty wallet, spent instance budget) must surface as
// quota_exhausted from their message text alone. Pure unit tests — no live
// Hermes/LLM needed. The assertions live in test/error_payload_test.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('hermes worker _error_payload classifies managed refusals as quota_exhausted', () => {
  const result = spawnSync('python3', ['test/error_payload_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `python unit tests failed:\n${result.stdout}\n${result.stderr}`);
});
