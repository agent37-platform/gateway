// The per-harness spellings of `reasoning_effort` — pure unit tests, no live
// harness. The public enum, the Claude Code query() options, and the OpenClaw
// thinking param must stay in lockstep as levels are added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONING_EFFORTS } from '../shared/types.js';
import { effortOptions } from '../server/adapters/claude-code-adapter.js';
import { THINKING_MAP } from '../server/adapters/openclaw-adapter.js';
import { codexEffort } from '../server/adapters/codex-adapter.js';
import { opencodeVariant } from '../server/adapters/opencode-adapter.js';

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

test('codex: none/minimal floor to low, the rest map by name, ultra stays ultra', () => {
  assert.equal(codexEffort(null), undefined);
  assert.equal(codexEffort(undefined), undefined);
  assert.equal(codexEffort('none'), 'low');
  assert.equal(codexEffort('minimal'), 'low');
  assert.equal(codexEffort('low'), 'low');
  assert.equal(codexEffort('medium'), 'medium');
  assert.equal(codexEffort('high'), 'high');
  assert.equal(codexEffort('xhigh'), 'xhigh');
  assert.equal(codexEffort('max'), 'max');
  assert.equal(codexEffort('ultra'), 'ultra');
  // Every public effort resolves to a Codex value (the turn/start effort is a
  // free-form string, but a mapping must exist for each level).
  for (const effort of REASONING_EFFORTS) assert.ok(codexEffort(effort), `${effort} unmapped`);
});

test('opencode: none omits the variant, max/ultra map to max, the rest map by name', () => {
  assert.equal(opencodeVariant(null), undefined);
  assert.equal(opencodeVariant(undefined), undefined);
  assert.equal(opencodeVariant('none'), undefined);
  assert.equal(opencodeVariant('minimal'), 'minimal');
  assert.equal(opencodeVariant('low'), 'low');
  assert.equal(opencodeVariant('medium'), 'medium');
  assert.equal(opencodeVariant('high'), 'high');
  assert.equal(opencodeVariant('xhigh'), 'xhigh');
  assert.equal(opencodeVariant('max'), 'max');
  assert.equal(opencodeVariant('ultra'), 'max');
  // Every reasoning level except `none` yields a variant (none is "omit").
  for (const effort of REASONING_EFFORTS) {
    if (effort === 'none') continue;
    assert.ok(opencodeVariant(effort), `${effort} unmapped`);
  }
});

test('openclaw: every effort has a thinking level', () => {
  for (const effort of REASONING_EFFORTS) assert.ok(THINKING_MAP[effort], `${effort} unmapped`);
  assert.equal(THINKING_MAP.none, 'off');
  assert.equal(THINKING_MAP.max, 'max');
  assert.equal(THINKING_MAP.ultra, 'ultra');
});
