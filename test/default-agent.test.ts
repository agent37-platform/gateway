import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfiguredDefaultAgent, DEFAULT_AGENT } from '../shared/types.js';

test('GATEWAY_DEFAULT_AGENT resolution: unset falls back, known passes, garbage fails at boot', () => {
  assert.equal(resolveConfiguredDefaultAgent(undefined), DEFAULT_AGENT);
  assert.equal(resolveConfiguredDefaultAgent('  '), DEFAULT_AGENT);
  assert.equal(resolveConfiguredDefaultAgent('openclaw'), 'openclaw');
  assert.equal(resolveConfiguredDefaultAgent('claude-code'), 'claude-code');
  assert.equal(resolveConfiguredDefaultAgent('codex'), 'codex');
  assert.equal(resolveConfiguredDefaultAgent('opencode'), 'opencode');
  assert.throws(() => resolveConfiguredDefaultAgent('opencalw'), /must be one of: hermes, openclaw, claude-code, codex, opencode/);
});
