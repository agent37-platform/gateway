// Regression gate for the Python worker's _resolve_model_provider: catalog
// model ids must stay on a configured custom: provider (the managed starter
// proxy) instead of being re-routed to the credential-less openrouter builtin.
// Pure unit tests — no live Hermes/LLM needed. The real assertions live in
// test/resolve_model_provider_test.py; this wrapper runs them under npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('hermes worker _resolve_model_provider honors managed custom providers', () => {
  const result = spawnSync('python3', ['test/resolve_model_provider_test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `python unit tests failed:\n${result.stdout}\n${result.stderr}`);
});
