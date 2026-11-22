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

- [OpenRouter decision models vs. a manual skill baseline](benchmarks/decision-models-2026-11-22.md): coverage, latency, quality, threshold sweep, and raw scores (November 22, 2026).
- [Threshold comparison graphs: 0.30, 0.40, and 0.50](benchmarks/decision-thresholds-2026-11-22.md): off-topic picks, missed required skills, and picking quality vs. latency and cost.
- [Per-skill choice vs. score](benchmarks/relevance-choice-vs-score.md): historical comparison of selection methods (October 13, 2026).
