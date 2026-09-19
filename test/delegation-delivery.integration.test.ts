import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, postJson, SseReader, type TestServer } from './test-helpers.js';

// A gateway turn is one request, one response, so nothing can start a
// follow-up turn when detached work finishes. The worker declares that to
// Hermes (async_delivery=False in hermes_worker.py), which makes delegate_task
// run its subagents inside the turn: the parent's final answer, child result
// included, arrives in the same response. Before that, the child was detached,
// the turn ended on "I'll report back", and the caller had to send another
// message to get the answer.

let server: TestServer | undefined;
let base: string;

before(async () => {
  server = await startTestServer();
  base = server.base;
});

after(async () => {
  await server?.close();
});

test('a delegate_task result arrives in the same turn', { timeout: 600_000 }, async () => {
  const outFile = join(process.env.AGENT37_GATEWAY_HOME!, `delegated-child-${Date.now()}.txt`);

  // The child invents a secret the parent cannot know, and the parent may use
  // no other tool, so quoting it proves the child's report came back in-turn.
  const res = await postJson(base, {
    input:
      'Call the delegate_task tool exactly once, right now, with this goal: ' +
      '"Invent a random 8-character lowercase code. Write ONLY that code to ' +
      `${outFile} using the write tool, and end your reply with: the code is <code>". ` +
      'Use no other tool and do not read files. Your final response must quote ' +
      "the exact code from the subagent's report.",
    reasoning_effort: 'low',
    stream: true,
  });
  assert.equal(res.status, 200);
  const events = await new SseReader(res).drain();
  const completedEvent = events.at(-1);
  assert.equal(completedEvent?.event, 'response.completed', JSON.stringify(events.at(-1)));

  const toolEvents = events.filter((event) => event.event.startsWith('response.tool_call.'));
  assert.deepEqual(
    [...new Set(toolEvents.map((event) => event.data.tool))],
    ['delegate_task'],
    'the parent must only delegate',
  );
  assert.ok(
    toolEvents.some((event) => event.event === 'response.tool_call.completed'),
    'delegate_task must complete inside the turn',
  );

  // The child writes the file last, so it has finished by the time the turn ends.
  assert.ok(existsSync(outFile), `child had not written ${outFile} when the turn ended`);
  const secret = readFileSync(outFile, 'utf8').trim().toLowerCase();
  assert.ok(secret.length > 0, 'child wrote an empty file');
  const answer = String(completedEvent?.data.output_text ?? '');
  assert.ok(answer.toLowerCase().includes(secret), `answer does not quote the child's code (${secret}): ${answer}`);
});
