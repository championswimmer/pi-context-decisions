# Agent guide

This is a Pi extension (`pi-context-decisions`) that uses decision/classifier models to choose which tools, skills, and MCP servers enter the model context. It must load early in Pi's extension stack.

Status: bootstrap. Most of the behavior described in the README is planned, not implemented. Do not describe planned features as working.

## Repository layout

- `README.md`: user-facing overview; keep planned vs implemented clearly marked.
- `AGENTS.md`: this file, the contributor and agent guide.
- `.agents/skills/`: project-local skills for agents (tracked; `.gitkeep` until populated).
- `.agents/plans/`: research and architecture handoffs to coder models (tracked; `.gitkeep` until populated).
- `../pi-skill-picker-jev`: sibling reference extension. Read it for patterns (entry point, settings, session history, tests). Do not copy it wholesale and do not add it as a dependency.

## Working rules

- **Ground Pi-specific claims in Pi docs.** Before writing code against Pi's extension, classifier, skill, or session APIs, read the installed Pi docs and the reference extension. Do not guess event names or signatures.
- **Plans go in `.agents/plans/`.** Researchers and architects write planned work there as uniquely named files (for example `<date>-<topic>.md`). Hand off implementation tasks by plan file, not by chat only. Never overwrite another agent's plan file; create a new uniquely named one instead.
- **Keep changes scoped.** Change only what the task requires. Leave unrelated files and other agents' in-progress edits alone.
- **Tests.** Every behavior change needs a test. Add tests alongside implementation; once a test runner exists, run the full suite before reporting completion. Do not claim tests pass if they were not run.
- **No secrets.** Never commit API keys, tokens, or `.env` contents, and never paste them into plans, docs, tests, or logs. Credentials come from Pi's credential store first, then from `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, and `TYPESAFE_API_KEY` environment variables. Redact keys in error messages and fixtures.
- **Privacy and size.** Decision calls send prompt or transcript text to a third-party model. Bound the text sent, and document what is sent.
- **Fail closed.** If a decision call fails, do not silently expose the full unfiltered inventory unless that is an explicitly documented fallback.

## Layers (planned)

1. Core: Pi internal classifier pipeline, plus direct TypeSafe JEV, OpenAI, and OpenRouter clients.
2. Decision API: wrapper exposing `noul`, `choice`, and `score` to the application layer.
3. Application: relevance model mapping prompts to `directly relevant` / `related` / `irrelevant` for skill filtering.

## Commands

No build, lint, or test commands exist yet. When `package.json` gains scripts, record them here and use them for verification.
