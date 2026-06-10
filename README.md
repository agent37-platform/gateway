# Agent37 Gateway

**One API to talk to an agent on an instance.**

The Agent37 Gateway runs inside each agent instance and exposes a small,
Responses-style HTTP API. You send it a turn; it routes that turn to the
instance's agent, streams the work back, and keeps the conversation going. The
streaming contract and request shape are the same whatever agent is behind it —
so client code doesn't change when the agent does.

Today it routes to **Hermes**. The adapter seam is built so **OpenClaw** and
**Claude Code** slot in next.

> This is the per-instance request plane. Creating, sizing, and billing
> instances is the job of the Agent37 Cloud control plane, which routes a
> request to the right container and forwards it here. Inside the container
> there is exactly one gateway, and it has no concept of instances — it just
> answers.

MIT licensed.

## How it talks to Hermes

The gateway is a small TypeScript/Express server. It spawns a Python worker
(`server/workers/hermes_worker.py`) and speaks newline-delimited JSON to it over
stdin/stdout. The worker imports the Hermes `AIAgent` **directly** — there is no
Hermes HTTP gateway in the loop — which gives structured streaming events,
per-turn model and reasoning control, and direct access to Hermes' `SessionDB`
for transcript history and replay.

```
HTTP / SSE client
  ↕  HTTP + Server-Sent Events
Agent37 Gateway  (Express, :3737)
  ↕  JSONL over stdin/stdout
Python worker    (hermes_worker.py)
  ↕  direct Python import
Hermes AIAgent
```

State is split deliberately:

- **In-memory live registry** buffers the SSE events of each in-flight (and
  just-finished) response, so a dropped client can reconnect and replay.
- **SQLite** (`<home>/data/gateway.db`) holds response and session **metadata**
  — enough to fetch a response by id or list sessions after a restart.
- **Transcript history** is never duplicated; it's projected on demand from
  Hermes' `SessionDB`.

## Quickstart

**Prerequisites:** Node.js 24+ and a working [Hermes](https://hermes-agent.nousresearch.com)
install (the worker auto-detects `~/.hermes/hermes-agent`; override with
`HERMES_AGENT_DIR` / `HERMES_PYTHON`).

```bash
npm install
npm run dev          # tsx watch on http://localhost:3737
# or
npm run prod         # build + run the compiled server
```

Check the worker can reach Hermes without booting the server:

```bash
npm run selftest:worker
```

## API

Base path is `/v1`. There is no auth in the gateway — it's a localhost service
behind the host, which handles and forwards authentication.

### Send a turn — `POST /v1/responses`

| Field | Type | Notes |
| --- | --- | --- |
| `input` | string, required | The message or task. |
| `session_id` | string | Continue a conversation. Omit to start a new one. |
| `files` | string[] | Absolute paths of files to attach (from `POST /v1/files`). Appended to the message as an `[Attached files: …]` block; the agent reads them from disk. |
| `stream` | boolean | `true` for Server-Sent Events; default `false`. |
| `model` / `provider` | string | The LLM to run on. List options at `GET /v1/models`. |
| `reasoning_effort` | string | `none` … `xhigh`. |
| `mode` | string | `chat` (default). `goal` is reserved (returns `validation_error` for now). |
| `metadata` | object | Up to 16 key/value pairs, echoed back. |

Non-streaming returns the finished response object:

```jsonc
{
  "id": "…",
  "session_id": "…",
  "status": "completed",          // in_progress | completed | failed | cancelled
  "agent": "hermes",
  "model": null,
  "provider": null,
  "output_text": "…",
  "usage": { "input_tokens": 1840, "output_tokens": 920, "cost_usd": 0.0137 },
  "error": null,
  "metadata": null,
  "created": 1748400000000
}
```

With `stream: true` the body is a Server-Sent Events stream of named events:

| Event | Payload |
| --- | --- |
| `response.created` | `{ id, session_id }` |
| `response.reasoning.delta` | `{ text }` |
| `response.output_text.delta` | `{ text }` |
| `response.tool_call.started` | `{ tool, label }` |
| `response.tool_call.completed` | `{ tool, duration_ms }` |
| `response.tool_call.failed` | `{ tool, error }` |
| `response.completed` | `{ output_text, usage }` |
| `response.failed` | `{ error: { code, message } }` |

### Follow up on a response

| Action | Endpoint |
| --- | --- |
| Fetch by id | `GET /v1/responses/{id}` |
| Reconnect a dropped stream | `GET /v1/responses/{id}/stream` (replays a snapshot, then resumes live) |
| Cancel a running turn | `POST /v1/responses/{id}/cancel` |

### Sessions

| Action | Endpoint |
| --- | --- |
| List | `GET /v1/sessions` → `{ data: [...] }` |
| Retrieve, with history | `GET /v1/sessions/{id}` |
| Delete | `DELETE /v1/sessions/{id}` |

### Files

Files live on the instance's disk, in the agent's workspace
(`<home>/workspace`) — the worker's working directory. A path is the file's
identity; there are no file ids.

| Action | Endpoint |
| --- | --- |
| Upload (multipart, one file in a `file` field) | `POST /v1/files` → `{ path, filename, bytes }` |
| Download (e.g. a file the agent produced) | `GET /v1/files/content?path=…` |

The chat loop: upload, pass the returned `path` in `files` on
`POST /v1/responses`, and when the agent replies that it wrote a file, fetch
that path from `/v1/files/content`.

```bash
curl -F "file=@leads.csv" http://localhost:3737/v1/files
# → { "path": "/home/user/.agent37-gateway/workspace/uploads/3f2a1b9c-leads.csv", … }

curl http://localhost:3737/v1/responses -H 'content-type: application/json' -d '{
  "input": "Summarize the attached spreadsheet.",
  "files": ["/home/user/.agent37-gateway/workspace/uploads/3f2a1b9c-leads.csv"]
}'
```

Uploads are kept until you delete them from the workspace yourself (there is no
garbage collection), and stored paths assume the instance's home directory
stays stable.

### Models & health

| Action | Endpoint |
| --- | --- |
| Models the agent can run | `GET /v1/models` |
| Liveness + worker reachability | `GET /v1/health` |
| Version | `GET /v1/version` |

### Errors

Every error returns a stable, machine-readable body. Branch on `code`, show
`message`:

```json
{ "error": { "code": "validation_error", "message": "input is required…", "param": "input" } }
```

| Code | HTTP | When |
| --- | --- | --- |
| `validation_error` | 400 | A request field was invalid (see `param`). |
| `session_not_found` | 404 | No session with that id. |
| `response_not_found` | 404 | No response with that id. |
| `file_not_found` | 404 | No file at that path. |
| `not_found` | 404 | Unknown route. |
| `session_busy` | 409 | A response is already running on the session. |
| `payload_too_large` | 413 | Request body exceeded the size limit. |
| `rate_limited` | 429 | The upstream agent/provider was rate-limited. |
| `agent_error` | 502 | The agent backend failed (auth, model, provider, etc.). |
| `internal_error` | 500 | An unexpected gateway error. |

Agent/worker failures surface their own `code` and `hint` where available (e.g.
`auth_error`, `quota_exhausted`, `model_error`). One response runs at a time per
session; sending a new turn while one is in flight returns `409 session_busy`.

## Testing

```bash
npm test          # integration suite against the real local Hermes worker/LLM
```

`npm test` drives the real Express app over HTTP/SSE against a throwaway gateway
state dir. Response tests call the local Hermes worker and configured LLM; the
suite also covers replay, `session_busy`, cancel, persistence, history, and
error bodies.

### Poke it by hand (Bruno)

A [Bruno](https://www.usebruno.com/) collection lives in [`bruno/`](bruno/) —
open that folder in Bruno, pick the **local** environment (`baseUrl`
`http://localhost:3737`), and run the requests top to bottom. *Create Response*
saves the `session_id` and response id into the environment, so *Continue
Session*, *Get Response*, *Cancel*, and *Delete Session* just work. For
*Upload File*, pick any local file first; it saves the uploaded path for
*Download File*.

## Configuration

All optional — see [`.env.example`](.env.example). Highlights: `PORT` (3737),
`HOST` (0.0.0.0), `AGENT37_GATEWAY_HOME` (`~/.agent37-gateway`), and the
`HERMES_*` variables that locate the Hermes install.

## Roadmap

- **`goal` mode** — autonomous, multi-turn runs (the worker primitives are in place).
- **More adapters** — OpenClaw and Claude Code, behind the same `AgentAdapter` seam.

## License

[MIT](LICENSE).
