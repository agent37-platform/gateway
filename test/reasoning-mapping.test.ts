// The per-harness spellings of `reasoning_effort` — pure unit tests, no live
// harness. The public enum, the Claude Code query() options, and the OpenClaw
// thinking param must stay in lockstep as levels are added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONING_EFFORTS } from '../shared/types.js';
import { effortOptions } from '../server/adapters/claude-code-adapter.js';
import { THINKING_MAP } from '../server/adapters/openclaw-adapter.js';

test('the public enum runs none through ultra', () => {
  assert.deepEqual([...REASONING_EFFORTS], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('claude-code: none disables thinking, ultra is ultracode, the rest are effort levels', () => {
  assert.deepEqual(effortOptions(null), {});
  assert.deepEqual(effortOptions(undefined), {});
  assert.deepEqual(effortOptions('none'), { thinking: { type: 'disabled' } });
  assert.deepEqual(effortOptions('minimal'), { effort: 'low' });
  assert.deepEqual(effortOptions('low'), { effort: 'low' });
  assert.deepEqual(effortOptions('medium'), { effort: 'medium' });
  assert.deepEqual(effortOptions('high'), { effort: 'high' });
  assert.deepEqual(effortOptions('xhigh'), { effort: 'xhigh' });
  assert.deepEqual(effortOptions('max'), { effort: 'max' });
  assert.deepEqual(effortOptions('ultra'), { effort: 'xhigh', settings: { ultracode: true } });
});

test('openclaw: every effort has a thinking level', () => {
  for (const effort of REASONING_EFFORTS) assert.ok(THINKING_MAP[effort], `${effort} unmapped`);
  assert.equal(THINKING_MAP.none, 'off');
  assert.equal(THINKING_MAP.max, 'max');
  assert.equal(THINKING_MAP.ultra, 'ultra');
});
