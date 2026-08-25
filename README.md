# Agent37 Gateway

**One API for Agent37 agents.**

The Agent37 Gateway exposes a small, Responses-style HTTP API for talking to an
Agent37 agent. You send it a turn; it routes that turn to the agent, streams the
work back, and keeps the conversation going. The streaming contract and request
shape are the same whatever agent is behind it — so client code doesn't change
when the agent does.

Today it routes to **Hermes** (the default), **OpenClaw**, and **Claude Code**:
pick per request with the `agent` field.

> Want the hosted API? Use [Agent37 Cloud](https://www.agent37.com/cloud). This
> repo is the gateway service that powers an Agent37 agent.

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
- **In-memory response store** holds each turn's receipt (status, usage, error,
  echoed metadata), bounded by a TTL and a count cap and lost on restart — just
  enough to replay a dropped stream after its live buffer expires.
- **Transcript history and the session list** are never duplicated; they're
  projected on demand from the session's harness backend (Hermes' `SessionDB`,
  OpenClaw's history, …). The gateway keeps no session index.

## How it talks to OpenClaw

The OpenClaw adapter speaks OpenClaw's WebSocket gateway RPC — OpenClaw's
native API, the one its own UI and CLI use — at `OPENCLAW_BASE_URL` (defaults
to a local OpenClaw, `http://localhost:18789`, when unset; the adapter derives
`ws://` from it), authenticated with `OPENCLAW_TOKEN`.

Turns go through `chat.send` and stream back over OpenClaw's `chat`/`agent`
events, so the gateway relays text deltas, thinking, and tool activity, and
cancel is real (`chat.abort` stops the run inside OpenClaw). Each session is
keyed `openresponses-user:{user}` under OpenClaw's default agent, where `user`
is the gateway session id. `GET /v1/sessions/{id}` projects the transcript
(`sessions.get`), the session list projects OpenClaw's own (`sessions.list`;
`label`/`updatedAt` become the shared `title`/`last_active`),
`DELETE /v1/sessions/{id}` removes the session (`sessions.delete`; OpenClaw
archives the transcript off its active path), and `PATCH /v1/sessions/{id}`
(rename) writes the session's label (`sessions.patch`).

`GET /v1/models` lists OpenClaw's configured LLM catalog (`models.list`) as
`provider/model` ids. A turn that names a `model` applies it to the session
(`sessions.patch`) — set when chosen, never cleared, so a model picked through
OpenClaw's own surfaces isn't clobbered by turns that don't choose — and
`reasoning_effort` maps onto OpenClaw's per-turn thinking level
(`none` → `off`, the rest pass through; OpenClaw's `ultra` is provider `max`
plus proactive subagent orchestration).

### Set up OpenClaw

One step: copy `gateway.auth.token` from `~/.openclaw/openclaw.json` into
`OPENCLAW_TOKEN` in your `.env`:

```bash
OPENCLAW_TOKEN=<gateway.auth.token from openclaw.json>
```

Then route any turn to it with `"agent": "openclaw"`. If OpenClaw runs somewhere
other than `http://localhost:18789`, set `OPENCLAW_BASE_URL` too. No OpenClaw
config changes are needed — the WebSocket gateway is OpenClaw's always-on
native surface.

## How it talks to Claude Code

The Claude Code adapter drives the Claude Code CLI through the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk):
one `query()` (one `claude` process) per turn, resumed by session id, in
`bypassPermissions` mode so tools run unprompted (the instance is the customer's
own box, as with the other harnesses). Text and thinking deltas, tool calls and
tool results stream back as the same SSE events, and cancel is real
(`interrupt()` stops the run inside Claude Code).

Transcripts live where Claude Code keeps them (`~/.claude/projects/<cwd>/<id>.jsonl`,
keyed by the gateway's workspace directory) and the gateway keeps no index:
`GET /v1/sessions?agent=claude-code` lists that store (Claude Code's own title,
custom or auto-generated, as `title`; the first prompt as `preview`),
`GET /v1/sessions/{id}` projects the transcript, `PATCH /v1/sessions/{id}`
(rename) writes Claude Code's custom title (its `/rename`), and
`DELETE /v1/sessions/{id}` removes the transcript. A gateway session id is the
Claude Code session UUID with the dashes removed, so a session started from a
terminal in the workspace directory shows up in the list too.

The gateway passes no credential: Claude Code runs on its own login. Until one
exists, a turn fails with `auth_error` (and a hint to log in) and
`GET /v1/health?agent=claude-code` reports `healthy: false`.

`GET /v1/models?agent=claude-code` lists Claude Code's model aliases (`sonnet`,
`opus`, `fable`, `haiku`, each the latest of its family); a turn's `model` is
passed through as is, and `reasoning_effort` maps onto Claude Code's dials
(`none` → thinking disabled, `minimal|low` → effort `low`,
`medium|high|xhigh|max` → the same effort, `ultra` → ultracode: `xhigh` effort
plus standing multi-agent workflow orchestration). `usage`
(cost included) and `context` come from Claude Code's own per-turn result.

### Set up Claude Code

Install Claude Code on the machine the gateway runs on and log in:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Then route any turn to it with `"agent": "claude-code"`. The adapter runs the
`claude` on `PATH`; set `CLAUDE_CODE_BIN` to pin a specific binary. An
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (what `claude setup-token`
prints) in the gateway's environment works instead of the interactive login.

## Quickstart

**Prerequisites:**

- Node.js 24+
- A working [Hermes](https://hermes-agent.nousresearch.com) install with a
  configured model/provider

The server itself is Node, but useful agent calls need Hermes. The worker
auto-detects `~/.hermes/hermes-agent` or the `hermes` CLI install; override with
`HERMES_AGENT_DIR` / `HERMES_PYTHON` when Hermes lives somewhere else.

```bash
npm install
npm run selftest:worker
npm run dev              # tsx watch on http://localhost:3737
```

Expected self-test output includes `"ok": true`. If it reports `import_error`,
set `HERMES_PYTHON` to the Python inside the Hermes virtualenv, for example:

```bash
HERMES_PYTHON=~/.hermes/hermes-agent/venv/bin/python npm run selftest:worker
```

Then sanity-check the HTTP server:

```bash
curl http://localhost:3737/v1/health
curl http://localhost:3737/v1/responses \
  -H 'content-type: application/json' \
  -d '{"input":"hello"}'
```

For a production-style local run:

```bash
npm run prod             # build + run the compiled server
```

## API

Base path is `/v1`. There is no auth in the gateway — it's a localhost service
behind the host, which handles and forwards authentication.

### Send a turn — `POST /v1/responses`

| Field | Type | Notes |
| --- | --- | --- |
| `input` | string, required | The message or task. |
| `agent` | string | `hermes`, `openclaw`, or `claude-code`. Defaults to the gateway's configured default (`GATEWAY_DEFAULT_AGENT`, `hermes` out of the box). Routing is per request, so include it on every turn of a non-default session. |
| `session_id` | string | Continue a conversation. Omit to start a new one. |
| `files` | string[] | Absolute paths of files to attach (write them first with `PUT /v1/files/content`). Appended to the message as an `[Attached files: …]` block; the agent reads them from disk. |
| `stream` | boolean | `true` for Server-Sent Events; default `false`. |
| `model` / `provider` | string | The LLM to run on. List options at `GET /v1/models`. |
| `reasoning_effort` | string | `none` … `ultra` (`max` = top plain thinking; `ultra` = top thinking plus the harness's orchestration mode). |
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
  "context": { "used_tokens": 22600, "window_tokens": 256000 }, // tokens occupying the model's context window; null when the harness can't measure it
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
| `response.completed` | `{ output_text, usage, context }` |
| `response.failed` | `{ error: { code, message } }` |

### Follow up on a response

| Action | Endpoint |
| --- | --- |
| Reconnect a dropped stream | `GET /v1/responses/{id}/stream` (replays a snapshot, then resumes live) |
| Cancel a running turn | `POST /v1/responses/{id}/cancel` |

Lost the id (page reload, new device)? `GET /v1/sessions/{id}` returns the
running response as `active_response_id`.

### Sessions

| Action | Endpoint |
| --- | --- |
| List | `GET /v1/sessions` → `{ agent, data: [...] }` (select the harness with `?agent=hermes\|openclaw\|claude-code`). Every row is the same shape regardless of harness: `{ id, title, last_active, message_count, preview }` — `title` is the harness's own editable title (what rename writes), `last_active` is epoch ms, and fields a harness doesn't track are `null`. |
| Retrieve, with history | `GET /v1/sessions/{id}` → `{ id, agent, active_response_id, history, context }` (`?agent=` to pick the harness; `context` is the session's last reported context window, null until a turn reports one) |
| Rename | `PATCH /v1/sessions/{id}` with `{ "title": "…" }` → `{ id, agent, renamed }`. Writes the title straight into the harness's own store (Hermes titles are length-capped and must be unique — a clash is `409 title_conflict`; OpenClaw stores it as the session label; Claude Code stores it as its custom session title). A harness without an editable title answers `405 rename_unsupported`. |
| Delete | `DELETE /v1/sessions/{id}` |

`active_response_id` is the id of the `in_progress` response on the session, or
null when it is idle. Harnesses persist a turn's messages at turn end, so while
`active_response_id` is set the running turn is normally **not** in `history`
yet — follow it live with `GET /v1/responses/{id}/stream`. This is how a client
that lost its state (page reload, new device) rediscovers and reattaches to a
running turn.

### Files

Files live on the instance's disk — the `sk_live_` key is the instance root, so
a path can name anything on it (there's no jail). A path (resolved, absolute) is
the file's identity; there are no file ids. The listing defaults to the agent's
workspace (`<home>/workspace`, the worker's working directory), so files written
there are the files the agent reads from disk.

Every entry — in a listing and returned by every write — is a `FileEntry`:

```jsonc
{
  "name": "leads.csv",            // basename
  "path": "/home/user/leads.csv", // resolved absolute path (the identity)
  "type": "file",                 // file | directory | symlink | other
  "size": 1024,                   // bytes; null for directories
  "modified": 1719500000123,      // mtime, epoch milliseconds
  "hidden": false                 // name starts with "."
}
```

| Action | Endpoint |
| --- | --- |
| List one directory level | `GET /v1/files?path=<dir>` (defaults to the workspace) |
| Read / preview / download | `GET /v1/files/content?path=<file>&disposition=inline\|attachment` |
| Download a folder as `.tar.gz` | `GET /v1/files/archive?path=<dir>` (defaults to the workspace) |
| Write raw bytes (create/overwrite/edit/upload) | `PUT /v1/files/content?path=<file>&overwrite=true\|false` |
| Delete (recursive, force) | `DELETE /v1/files?path=<path>` → `{ ok: true }` |
| Rename / move | `PATCH /v1/files` body `{ from, to }` |
| Create a directory (mkdir -p) | `POST /v1/files/dir?path=<dir>` |

`GET /v1/files` returns `{ path, parentPath, entries, truncated }` — one level,
directories first then name (case-insensitive), capped at 1000 entries
(`truncated: true` past that). `parentPath` is null at the filesystem root.

`GET /v1/files/content` sets `Content-Type` from the extension and streams at any
size; `disposition` defaults to `attachment` (download), `inline` lets a browser
render it.

`GET /v1/files/archive` streams a directory as a gzipped tar (`.tar.gz`), produced
by piping the system `tar` — any size, flat memory, and it unpacks to one
top-level folder named after the directory (`application/gzip`,
`Content-Disposition: attachment`). Symlinks are stored as links, not followed.
There is no folder-upload counterpart — recreate a tree with per-file
`PUT /v1/files/content` calls (each `mkdir -p`s its parents).

`PUT /v1/files/content` writes the **raw request body** (not multipart) to the
path, creating parent directories as needed, and returns the new `FileEntry`.
`overwrite` defaults to true; with `overwrite=false` an existing file is a
`409 file_exists`. Pass an `X-Expected-Mtime` header (epoch ms) for optimistic
concurrency — if the file changed since you read it, the write is a `412 modified`.

The chat loop: write a file with `PUT /v1/files/content`, pass its `path` in
`files` on `POST /v1/responses`, and when the agent replies that it wrote a file,
fetch it from `GET /v1/files/content`.

```bash
curl -X PUT --data-binary @leads.csv \
  'http://localhost:3737/v1/files/content?path=/home/user/leads.csv'
# → { "path": "/home/user/leads.csv", "type": "file", "size": 1024, … }

curl http://localhost:3737/v1/responses -H 'content-type: application/json' -d '{
  "input": "Summarize the attached spreadsheet.",
  "files": ["/home/user/leads.csv"]
}'
```

Files are kept until you delete them yourself (there is no garbage collection),
and stored paths assume the instance's home directory stays stable.

### Models & health

| Action | Endpoint |
| --- | --- |
| Models a harness can run | `GET /v1/models` (configured default; add `?agent=hermes\|openclaw\|claude-code` to target one) |
| Liveness + harness reachability | `GET /v1/health` (configured default; add `?agent=hermes\|openclaw\|claude-code` to target one) |
| Version | `GET /v1/version` |

`GET /v1/health` reports on the gateway's configured default harness, or the
one named by an optional `?agent=` query param. It returns `{ ok, agent,
healthy }`, plus a legacy `hermes` field when Hermes is probed. For Claude Code,
`healthy` also means it is logged in.

`GET /v1/models` returns the OpenAI list shape, so any OpenAI-compatible client
works. It lists the models of one harness — the configured default, or the one
named by an optional `?agent=` query param (e.g. `?agent=openclaw`) — and the
response echoes which `agent` answered. Each entry carries the upstream provider
in `owned_by` plus `label`, `source`, and `is_default`, so a UI can group models
by provider and preselect the default:

```jsonc
{
  "object": "list",
  "agent": "hermes",             // which harness this list is for
  "default_model": "hermes-4-405b",
  "default_provider": "nous",
  "data": [
    {
      "id": "hermes-4-405b",
      "object": "model",
      "created": 0,                  // we don't track per-model creation time
      "owned_by": "nous",            // upstream provider
      "label": "Hermes 4 405B",
      "source": "catalog",           // current | catalog | custom | alias
      "is_default": true
    }
  ]
}
```

### Errors

Every error returns a stable, machine-readable body. Branch on `code`, show
`message`:

```json
{ "error": { "code": "validation_error", "message": "input is required…", "param": "input" } }
```

| Code | HTTP | When |
| --- | --- | --- |
| `validation_error` | 400 | A request field was invalid (see `param`). |
| `not_a_directory` | 400 | `GET /v1/files` or `GET /v1/files/archive` was given a path that isn't a directory. |
| `response_not_found` | 404 | No response with that id. |
| `file_not_found` | 404 | No file at that path. |
| `not_found` | 404 | Unknown route. |
| `session_busy` | 409 | A response is already running on the session. `error.response_id` names it — reattach via `GET /v1/responses/{id}/stream` or cancel it. |
| `title_conflict` | 409 | The requested session title is already in use by another session. |
| `file_exists` | 409 | `PUT /v1/files/content?overwrite=false` and the file already exists. |
| `modified` | 412 | `PUT /v1/files/content`'s `X-Expected-Mtime` no longer matches the file. |
| `rename_unsupported` | 405 | The targeted harness can't rename sessions (no native editable title). |
| `payload_too_large` | 413 | Request body exceeded the size limit. |
| `rate_limited` | 429 | The upstream agent/provider was rate-limited. |
| `agent_error` | 502 | The agent backend failed (auth, model, provider, etc.). |
| `agent_unavailable` | 503 | The targeted harness backend isn't available on this instance — never provisioned here (including an image with no Hermes install), or down. |
| `internal_error` | 500 | An unexpected gateway error. |

Agent/worker failures surface their own `code` and `hint` where available (e.g.
`auth_error`, `quota_exhausted`, `model_error`). One response runs at a time per
session; sending a new turn while one is in flight returns `409 session_busy`,
with the running response's id in `error.response_id`.

## Testing

```bash
npm test          # integration suite against the real local Hermes worker/LLM
```

`npm test` drives the real Express app over HTTP/SSE against a throwaway gateway
state dir. Response tests call the local Hermes worker and configured LLM; the
suite also covers replay, `session_busy`, cancel, history, and
error bodies. The OpenClaw tests run against a local OpenClaw gateway and are
skipped automatically when none is running; the Claude Code tests run the
Claude Code CLI installed on this machine, on its own login, and are skipped
when it isn't installed or logged in.

### Poke it by hand (Bruno)

A [Bruno](https://www.usebruno.com/) collection lives in [`bruno/`](bruno/) —
open that folder in Bruno, pick the **local** environment (`baseUrl`
`http://localhost:3737`), and run the requests top to bottom. *Create Response*
saves the `session_id` and response id into the environment, so *Continue
Session*, *Cancel*, and *Delete Session* just work. The
*(openclaw)* requests do the same for OpenClaw (start `openclaw` locally first),
and the *(claude-code)* requests for Claude Code (installed and logged in).
*Upload File* writes a file via `PUT /v1/files/content` and saves its path for
*Download File*.

## Configuration

All optional — see [`.env.example`](.env.example). Highlights: `PORT` (3737),
`HOST` (0.0.0.0), `GATEWAY_DEFAULT_AGENT` (the harness a turn routes to when the
request omits `agent`; `hermes` by default), `AGENT37_GATEWAY_HOME`
(`~/.agent37-gateway`), the `HERMES_*` variables that locate the Hermes install,
`OPENCLAW_BASE_URL` / `OPENCLAW_TOKEN` for the OpenClaw route, and
`CLAUDE_CODE_BIN` for the Claude Code route.

## Roadmap

- **`goal` mode** — autonomous, multi-turn runs (the worker primitives are in place).
- **More adapters**, behind the same `AgentAdapter` seam.

## License

[MIT](LICENSE).
