import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, postJson } from './test-helpers.js';

// The non-streaming branch must send its headers immediately and tick a whitespace
// heartbeat while the turn runs — Cloudflare's edge kills connections that stay
// header-silent for ~100s, which used to 502 every stream:false turn longer than that.
// The final body must still parse as the normal response JSON despite the padding.
// Uses a fake adapter (setAdapter), so this file needs no live Hermes worker or LLM.
test('non-stream turns send first bytes immediately and stay valid JSON', async () => {
  process.env.GATEWAY_NONSTREAM_HEARTBEAT_MS = '300'; // read at route-module load, before startTestServer imports it
  const server = await startTestServer();
  const { setAdapter } = await import('../server/agent.js');
  setAdapter({
    // eslint-disable-next-line require-yield
    async *chatStream() {
      yield { type: 'text_delta', content: 'hello from the fake adapter' };
      await new Promise((resolve) => setTimeout(resolve, 1400));
      yield { type: 'done', sessionId: 'fake', usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 } };
    },
  } as never);

  try {
    const started = Date.now();
    const res = await postJson(server.base, { input: 'hi', stream: false });
    const headersAfterMs = Date.now() - started;
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    // Headers must arrive while the turn is still running, not when it finishes.
    assert.ok(headersAfterMs < 900, `headers took ${headersAfterMs}ms`);

    const text = await res.text();
    assert.ok(Date.now() - started >= 1400, 'body should settle only when the turn ends');
    const padding = text.match(/^ */)?.[0] ?? '';
    assert.ok(padding.length >= 2, `expected >=2 heartbeat spaces before the JSON, got ${padding.length}`);
    const body = JSON.parse(text);
    assert.equal(body.status, 'completed');
    assert.equal(body.output_text, 'hello from the fake adapter');
    assert.ok(body.usage, 'usage from the done event should persist');

    // A client that aborts mid-turn must not crash the route; the turn still finalizes
    // server-side and releases the one-turn-per-session lock.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await fetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'aborted turn', stream: false, session_id: body.session_id }),
      signal: controller.signal,
    })
      .then((r) => r.text())
      .catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1700)); // the aborted turn finishes server-side
    const after = await postJson(server.base, { input: 'still alive?', stream: false, session_id: body.session_id });
    assert.equal(after.status, 200);
    assert.equal(JSON.parse(await after.text()).status, 'completed');
  } finally {
    await server.close();
  }
});
