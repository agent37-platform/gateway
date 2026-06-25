# AGENTS.md

Guidance for AI coding agents working in this repo. `CLAUDE.md` imports this file via `@AGENTS.md`, so this is the single source of truth — edit here, not there.

## What this is

The Agent37 Gateway: the Responses-style HTTP API (`/v1`, port 3737) that runs inside each Agent37 instance and drives whichever harness a request targets through the `AgentAdapter` seam — Hermes (via a Python worker) and OpenClaw today, Claude Code next. A turn picks its harness with the `agent` field; `GATEWAY_DEFAULT_AGENT` sets the default when `agent` is omitted (a container only runs the backend(s) it was provisioned with, so targeting an unprovisioned harness fails at request time). `README.md` is the API contract (request shapes, SSE events, error codes); keep it exact when the surface changes — it feeds the hosted reference at `www.agent37.com/docs`.

Orientation (Node >= 24, TypeScript ESM):

- `server/routes/` — the `/v1` surface (responses, sessions, models, files)
- `server/adapters/` — the `AgentAdapter` seam (`types.ts`), the Hermes and OpenClaw adapters, and the JSONL worker protocol (`worker-protocol.ts`)
- `server/workers/hermes_worker.py` — the Python side; imports Hermes directly. `npm run selftest:worker` checks it can reach Hermes without booting the server
- `server/live-runs.ts` + `server/response-store.ts` — in-memory replayable event buffers for in-flight responses, and in-memory (TTL/count-bounded, lost on restart) response metadata; session metadata is never stored — session lists and transcripts project from the session's harness backend (Hermes' SessionDB, OpenClaw's history, ...)
- `shared/types.ts` — the public API types; `test/` — the integration suite; `bruno/` — hand-poke collection (see `bruno/README.md`)

## Engineering practices

We're a startup. You're probably used to writing enterprise code — code that tries to handle every possible edge case and has fallbacks for everything. That's not how we do things around here: our number one rule is to keep things simple. We handle ONLY the most important cases.

We try to only add new functionality that is small (that is, simple and few lines of code) or absolutely necessary. If a change is not small or absolutely necessary, don't make it.

## Before opening a pull request

The integration suite (`npm test`) is our only test gate, and it runs **locally** — it drives the real gateway against a live Hermes worker and LLM, so it is not run in CI. Before you create a PR, always run the type check and the suite:

```bash
npm run typecheck && npm test
```

Both must pass. Never open a PR on a red or un-run suite — fix the code (or the test) first.

The OpenClaw tests in the suite auto-skip when no local OpenClaw gateway is running. If your change touches the OpenClaw adapter or routing, start OpenClaw locally (`openclaw start`, port 18789) so those tests actually run. The adapter also needs two things set up from `~/.openclaw/openclaw.json`: the responses endpoint enabled (`gateway.http.endpoints.responses.enabled: true`) and that file's `gateway.auth.token` copied into `OPENCLAW_TOKEN` in your `.env`. See "Set up OpenClaw" in `README.md` for the exact steps.

## Releases

Versions are git tags: bump `version` in `package.json` and tag `vX.Y.Z` on main. Agent37 instance images install the gateway **by pinned release tag**, so a merged change reaches real instances only after a new tag ships and downstream images re-pin — until then, production runs the last tag, not `main`. If the change alters the public `/v1` surface, the hosted reference (`www.agent37.com/docs`, Agent API pages) must be updated to match.
