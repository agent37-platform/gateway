# AGENTS.md

Guidance for AI coding agents working in this repo. `CLAUDE.md` imports this file via `@AGENTS.md`, so this is the single source of truth — edit here, not there.

## What this is

The Agent37 Gateway: the Responses-style HTTP API (`/v1`, port 3737) that runs inside each Agent37 instance and drives the agent behind it — Hermes today via a Python worker; OpenClaw and Claude Code next, behind the same adapter seam. `README.md` is the API contract (request shapes, SSE events, error codes); keep it exact when the surface changes — it feeds the hosted reference at `www.agent37.com/docs`.

Orientation (Node >= 24, TypeScript ESM):

- `server/routes/` — the `/v1` surface (responses, sessions, models, files)
- `server/adapters/` — the `AgentAdapter` seam (`types.ts`), the Hermes adapter, and the JSONL worker protocol (`worker-protocol.ts`)
- `server/workers/hermes_worker.py` — the Python side; imports Hermes directly. `npm run selftest:worker` checks it can reach Hermes without booting the server
- `server/live-runs.ts` + `server/db/` — in-memory replayable event buffers for in-flight responses; SQLite for response/session metadata (transcripts are never duplicated — they're projected from Hermes' SessionDB)
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

The OpenClaw tests in the suite auto-skip when no local OpenClaw gateway is running. If your change touches the OpenClaw adapter or routing, start OpenClaw locally (`openclaw start`, port 3738) so those tests actually run.

## Releases

Versions are git tags: bump `version` in `package.json` and tag `vX.Y.Z` on main. Agent37 instance images install the gateway **by pinned release tag**, so a merged change reaches real instances only after a new tag ships and downstream images re-pin — until then, production runs the last tag, not `main`. If the change alters the public `/v1` surface, the hosted reference (`www.agent37.com/docs`, Agent API pages) must be updated to match.
