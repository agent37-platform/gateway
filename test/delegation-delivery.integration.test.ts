import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// A background delegate_task child must hand its result back to the parent
// session: the worker drains Hermes' completion queue at the start of the next
// turn (see _drain_async_completions in hermes_worker.py). Before that drain
// existed, completions parked at delivery_state='pending' forever and the
// parent never heard from its children.

let server: TestServer | undefined;
let base: string;

before(async () => {
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a background delegate_task result is delivered on the next turn', { timeout: 600_000 }, async () => {
  const outFile = join(process.env.AGENT37_GATEWAY_HOME!, `delegated-child-${Date.now()}.txt`);

  // Turn 1: dispatch a child that invents a secret the parent's own transcript
  // cannot contain, so quoting it later proves the child's report was
  // actually delivered (not reconstructed from the parent's history).
  const first = await postJson(base, {
    input:
      'Call the delegate_task tool exactly once, right now, with this goal: ' +
      '"Invent a random 8-character lowercase code. Write ONLY that code to ' +
      `${outFile} using the write tool, and end your reply with: the code is <code>". ` +
      'After dispatching, end your turn immediately with only the word DISPATCHED. ' +
      'Do not wait for the subagent, do not poll, do not read files.',
    reasoning_effort: 'low',
  });
  const created = (await first.json()) as { session_id: string; status: string; output_text: string };
  assert.equal(first.status, 200, JSON.stringify(created));
  assert.equal(created.status, 'completed', JSON.stringify(created));

  // Wait for the detached child to finish (it writes the file last).
  const deadline = Date.now() + 300_000;
  while (!existsSync(outFile)) {
    assert.ok(Date.now() < deadline, `child never wrote ${outFile}`);
    await sleep(2_000);
  }
  const secret = readFileSync(outFile, 'utf8').trim().toLowerCase();
  assert.ok(secret.length > 0, 'child wrote an empty file');
  // Let the batch finalize and enqueue its completion after the file write.
  await sleep(10_000);

  // Turn 2, streamed so tool use is observable: the completion block is
  // prepended to this turn, so the model can quote the secret without tools.
  const res = await postJson(base, {
    session_id: created.session_id,
    input:
      'Did your subagent report back to you in this conversation? Answer with ' +
      'YES or NO first. If YES, also quote the exact code from its report. ' +
      'Do not use any tools.',
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(res.status, 200);
  const events = await new SseReader(res).drain();
  const completedEvent = events.at(-1);
  assert.equal(completedEvent?.event, 'response.completed', JSON.stringify(events.at(-1)));
  const answer = String(completedEvent?.data.output_text ?? '');

  // No tool calls: the secret can only have come from the delivered report.
  const toolEvents = events.filter((event) => event.event.startsWith('response.tool_call.'));
  assert.deepEqual(toolEvents, [], 'turn 2 must not need tools to see the child result');
  assert.match(answer.trim(), /^\W*yes/i, `expected YES, got: ${answer}`);
  assert.ok(answer.toLowerCase().includes(secret), `answer does not quote the child's code (${secret}): ${answer}`);
});
