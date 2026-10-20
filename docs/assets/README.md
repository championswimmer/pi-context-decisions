# README diagram sources

The root [README](../../README.md#inside-the-agent-loop) embeds the PNGs here. Their editable SVG originals include accessible titles/descriptions; color is reinforced by labels and arrows.

## Render offline

With an existing `rsvg-convert` (librsvg) installation:

```sh
sh scripts/render-diagrams.sh
```

Run from the repository root, or pass the script's absolute path from any directory. No network, inference calls or npm dependencies are needed. The script renders each SVG at **2×** its viewBox size:

| Source | PNG size |
| --- | --- |
| `agent-session-loop.svg` | 2400 × 2260 |
| `context-decider.svg` | 2400 × 2260 |
| `tool-availability-gates.svg` | 2400 × 2160 |

The checked-in PNGs were rendered with librsvg 2.61.3 and the locally available Lato font. SVGs fall back to DejaVu Sans / sans-serif; font or renderer differences can change wrapping/metrics, so inspect all three PNGs after regeneration. The root README has text summaries and links to these vector sources for zooming.

## Accuracy anchors

These diagrams describe the implemented extension against **Pi 1.1.0**, not a new host API or a permission system:

- [Runtime hooks](../../src/extension/runtime.ts): concurrent first-prompt passes; stable skill base; additive hidden skill deltas; completed/continuing `turn_end` drafts.
- [Tool filter](../../src/extension/tool-filter.ts): declared-tool reconciliation, indirect notices, cadence/catch-up, lazy `tool_call`, and resource routing.
- [Skill ledger](../../src/extension/skill-ledger.ts) / [tool ledger](../../src/extension/tool-ledger.ts): active-branch grants, model-visible messages and non-context records.
- [Tool inventory](../../src/apps/tool-inventory.ts) / [availability policy](../../src/apps/tool-policy.ts): provenance, candidate modes and scoped grants.
- [Real Pi session tests](../../test/extension-real-pi-session.test.ts) / [real Pi tool tests](../../test/extension-real-pi-tools.test.ts): commit order, declaration deltas, nested calls, late tools, branches and the first-prompt gap.
- Installed `@earendil-works/pi-coding-agent/docs/{how-pi-works,extensions,mcp,message-types,session-format,skills}.md`, its public `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`, and `@earendil-works/pi-agent-core/dist/agent-loop.js`: host lifecycle, exposure and context conversion contracts.

The session diagram shows the normal request/continuation path, not every recovery event. Pi owns retries, compaction and final settlement. The extension never requests continuation. For bypasses, fail modes, compaction gaps, ownership conflicts and mid-session enabling, see [skill picking](../skill-picking.md) and [tool filtering](../tool-filtering.md).
