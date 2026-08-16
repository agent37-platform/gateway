// Regression gate for the AIAgent kwargs the Python worker builds: the
// interactive `clarify` toolset must be disabled (the gateway is turn-based;
// the model asks by ending its turn with the question) and no canned clarify
// callback may be registered. Pure unit tests — no live Hermes/LLM needed.
// The real assertions live in test/agent_kwargs_test.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('hermes worker disables the clarify toolset and registers no clarify callback', () => {
  const result = spawnSync('python3', ['test/agent_kwargs_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `python unit tests failed:\n${result.stdout}\n${result.stderr}`);
});
