# AGENTS.md

## Engineering practices

We're a startup. You're probably used to writing enterprise code — code that tries to handle every possible edge case and has fallbacks for everything. That's not how we do things around here: our number one rule is to keep things simple. We handle ONLY the most important cases.

We try to only add new functionality that is small (that is, simple and few lines of code) or absolutely necessary. If a change is not small or absolutely necessary, don't make it.

## Before opening a pull request

The integration suite (`npm test`) is our only test gate, and it runs **locally** — it drives the real gateway against a live Hermes worker and LLM, so it is not run in CI. Before you create a PR, always run the type check and the suite:

```bash
npm run typecheck && npm test
```

Both must pass. Never open a PR on a red or un-run suite — fix the code (or the test) first.
