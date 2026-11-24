# Documentation

Start with the [README](../README.md) for installation and everyday use.

| Guide | What it covers |
| --- | --- |
| [Settings and commands](settings.md) | Dialog controls, defaults, settings files, history and skill allowlists |
| [Providers and credentials](providers.md) | Authentication, direct/native backends and the static OpenRouter catalog |
| [Skill picking](skill-picking.md) | Load order, additive advertisements, session branches, compaction and privacy |
| [Tool and MCP filtering](tool-filtering.md) | Modes, scoped allowlists, routing, metadata and limitations |
| [Library API](api.md) | Decision primitives, backend clients and the reusable skill picker |
| [Development](development.md) | Offline checks and opt-in live smoke tests |
| [Publishing](publishing.md) | Authorized releases, trusted publishing and changelog automation |

## Benchmarks

- [OpenRouter top-20 decision models: three-run skill-picking benchmark](benchmarks/decision-benchmark-report.md): 3 repeats per prompt; frozen spec in `benchmarks/decision-benchmark.json`, roster in `benchmarks/decision-models-top20.json`.
- [Per-skill choice vs. score](benchmarks/relevance-choice-vs-score.md): historical comparison of selection methods (October 13, 2026).
