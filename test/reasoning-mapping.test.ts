// The per-harness spellings of `reasoning_effort` — pure unit tests, no live
// harness. The public enum, the Claude Code query() options, and the OpenClaw
// thinking param must stay in lockstep as levels are added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONING_EFFORTS, publicReasoningEffort } from '../shared/types.js';
import { appliedEffort, effortOptions } from '../server/adapters/claude-code-adapter.js';
import { THINKING_MAP } from '../server/adapters/openclaw-adapter.js';
import { codexEffort } from '../server/adapters/codex-adapter.js';
import { opencodeVariant } from '../server/adapters/opencode-adapter.js';
import { grokEffort } from '../server/adapters/grok-adapter.js';
import { piThinking } from '../server/adapters/pi-adapter.js';

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

test('grok: levels map by name, ultra maps to max (grok has no ultra)', () => {
  assert.equal(grokEffort(null), undefined);
  assert.equal(grokEffort(undefined), undefined);
  assert.equal(grokEffort('none'), 'none');
  assert.equal(grokEffort('minimal'), 'minimal');
  assert.equal(grokEffort('low'), 'low');
  assert.equal(grokEffort('medium'), 'medium');
  assert.equal(grokEffort('high'), 'high');
  assert.equal(grokEffort('xhigh'), 'xhigh');
  assert.equal(grokEffort('max'), 'max');
  assert.equal(grokEffort('ultra'), 'max');
  for (const effort of REASONING_EFFORTS) assert.ok(grokEffort(effort), `${effort} unmapped`);
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

test('pi: none is off, the rest map by name, ultra floors to max', () => {
  assert.equal(piThinking(null), undefined);
  assert.equal(piThinking(undefined), undefined);
  assert.equal(piThinking('none'), 'off');
  assert.equal(piThinking('minimal'), 'minimal');
  assert.equal(piThinking('low'), 'low');
  assert.equal(piThinking('medium'), 'medium');
  assert.equal(piThinking('high'), 'high');
  assert.equal(piThinking('xhigh'), 'xhigh');
  assert.equal(piThinking('max'), 'max');
  assert.equal(piThinking('ultra'), 'max');
});

// --- What we report back: `reasoning_effort` on the response object ----------
// The turn runs at the level the harness accepted, which is not always the one
// that was asked for. Every harness's own spelling has to land back on the
// public ladder, or a caller reads a level we never ran.

test('publicReasoningEffort maps a harness spelling back to the public ladder', () => {
  assert.equal(publicReasoningEffort(null), null);
  assert.equal(publicReasoningEffort(undefined), null);
  assert.equal(publicReasoningEffort(''), null);
  // `off` is pi's and OpenClaw's spelling of thinking disabled.
  assert.equal(publicReasoningEffort('off'), 'none');
  for (const effort of REASONING_EFFORTS) assert.equal(publicReasoningEffort(effort), effort);
  // A level we don't publish is reported as none-set rather than invented.
  assert.equal(publicReasoningEffort('turbo'), null);
});

test('every harness spelling round-trips to a public level', () => {
  for (const effort of REASONING_EFFORTS) {
    assert.ok(publicReasoningEffort(codexEffort(effort)), `codex ${effort} does not round-trip`);
    assert.ok(publicReasoningEffort(grokEffort(effort)), `grok ${effort} does not round-trip`);
    assert.ok(publicReasoningEffort(THINKING_MAP[effort]), `openclaw ${effort} does not round-trip`);
    assert.ok(publicReasoningEffort(piThinking(effort)), `pi ${effort} does not round-trip`);
    assert.ok(appliedEffort(effort), `claude-code ${effort} does not round-trip`);
    // OpenCode's `none` is "send no variant", so it alone reports nothing.
    if (effort !== 'none') {
      assert.ok(publicReasoningEffort(opencodeVariant(effort)), `opencode ${effort} does not round-trip`);
    }
  }
  assert.equal(publicReasoningEffort(opencodeVariant('none')), null);
});

test('a level the harness cannot run is reported as the one it ran', () => {
  // The whole point of the field: these are the turns where what we report
  // differs from what was asked for.
  assert.equal(publicReasoningEffort(grokEffort('ultra')), 'max');
  assert.equal(publicReasoningEffort(piThinking('ultra')), 'max');
  assert.equal(publicReasoningEffort(opencodeVariant('ultra')), 'max');
  assert.equal(publicReasoningEffort(codexEffort('minimal')), 'low');
  assert.equal(appliedEffort('minimal'), 'low');
});

test('claude-code: appliedEffort matches the options effortOptions builds', () => {
  assert.equal(appliedEffort(null), null);
  assert.equal(appliedEffort(undefined), null);
  assert.equal(appliedEffort('none'), 'none');
  assert.equal(appliedEffort('minimal'), 'low');
  assert.equal(appliedEffort('low'), 'low');
  assert.equal(appliedEffort('medium'), 'medium');
  assert.equal(appliedEffort('high'), 'high');
  assert.equal(appliedEffort('xhigh'), 'xhigh');
  assert.equal(appliedEffort('max'), 'max');
  // ultra is xhigh + ultracode, which is our ultra, not a downgrade to xhigh.
  assert.equal(appliedEffort('ultra'), 'ultra');
});
