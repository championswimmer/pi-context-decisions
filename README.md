# pi-context-decisions

A [Pi](https://pi.dev) extension that uses **decision models** (classifier models) to decide which tools, skills, and MCP servers are exposed to the model context for a given prompt.

> **Status: bootstrap / pre-alpha.** Only the repository scaffolding exists today. Everything below marked *Planned* is design intent, not working code.

## Load-order requirement

This extension only works when it is **one of the first extensions loaded** in Pi's extension stack. It needs to see and rewrite the tool/skill/MCP surface before other extensions have added theirs. If it loads late, its decisions may be applied to an incomplete inventory. Keep it near the top of your Pi extension list.

## Layers

### 1. Core layer (Planned)

The core layer runs a decision/classifier model and returns a structured result. It has two backends:

- **Pi internal classifier pipeline (Planned).** Uses Pi's own classifier infrastructure. The model picker should list every OpenRouter decision model in addition to the models Pi already supports natively.
- **Direct decision API layer (Planned).** Calls decision endpoints directly over HTTP:
  - **TypeSafe JEV (Planned).** Typed direct calls authenticated with `TYPESAFE_API_KEY`.
  - **OpenAI (Planned).** Direct decision calls authenticated with `OPENAI_API_KEY`.
  - **OpenRouter (Planned).** Direct decision calls authenticated with `OPENROUTER_API_KEY`.

Credential resolution order for the direct providers (Planned):

1. Pi's stored credentials for that provider (first).
2. The matching environment variable (second).

### 2. Decision API (Planned)

A thin wrapper over the core layer. The application layer calls it for three decision types:

- `noul`: a probability-style decision (one yes/no-like score per item).
- `choice`: pick one option from a set.
- `score`: rate items on a rubric.

### 3. Application layer: relevance skills (Planned)

A "relevance" model maps a user prompt to one of three labels for each candidate skill:

- `directly relevant`
- `related`
- `irrelevant`

The labels are used to filter which skills are exposed to the context for that turn.

## Installation

Not yet published. For local development:

```bash
npm install
```

Build, test, and run commands will be added as the implementation lands.

## Configuration

No configuration is implemented yet. Planned secrets are read from Pi's credential store first, then from environment variables: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY`. Never commit keys.

## Reference

`../pi-skill-picker-jev` is the sibling reference extension used for inspiration on Pi extension structure, settings, and session-history patterns. It is not a dependency.

## Contributing

See [AGENTS.md](AGENTS.md) for contributor and agent instructions, and `.agents/plans/` for research and architecture handoffs.

## License

See [LICENSE](LICENSE).
