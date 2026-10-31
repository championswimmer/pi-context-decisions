# README diagram sources

The root [README](../../README.md#inside-the-agent-loop) embeds the PNGs here. They assume familiarity with a coding agent's task → model → tool → result loop, **not** Pi's internals. Main labels use plain English; hook names and edge cases live in the README's optional details and the implementation notes below. Their editable SVG originals include accessible titles/descriptions; color is reinforced by labels and arrows.

Each diagram answers one question:

1. **Agent loop:** when can context be selected?
2. **Picker:** what does it see, and what gets added?
3. **Tool checks:** why can a discoverable tool still be blocked?

Consistent colors: blue = agent/model flow, purple = context selection, green = available/kept, amber = call check, red = blocked call.

## Render offline

With an existing `rsvg-convert` (librsvg) installation:

```sh
sh scripts/render-diagrams.sh
```

Run from the repository root, or pass the script's absolute path from any directory. No network, inference calls or npm dependencies are needed. The script renders each SVG at **2×** its viewBox size:

| Source | PNG size |
| --- | --- |
| `agent-session-loop.svg` | 2400 × 2000 |
| `context-decider.svg` | 2400 × 1760 |
| `tool-availability-gates.svg` | 2400 × 2040 |

The checked-in PNGs were rendered with librsvg 2.61.3 and the locally available Lato font. SVGs fall back to DejaVu Sans / sans-serif; font or renderer differences can change wrapping/metrics, so inspect all three PNGs after regeneration. The root README has text summaries and links to these vector sources for zooming.

## Accuracy anchors

These diagrams describe the implemented extension against **Pi 1.1.0**, not a new host API or a permission system:

- [Runtime hooks](../../src/extension/runtime.ts): concurrent first-prompt passes; stable skill base; additive hidden skill deltas; completed/continuing `turn_end` drafts.
- [Tool filter](../../src/extension/tool-filter.ts): declared-tool reconciliation, indirect notices, cadence/catch-up, lazy `tool_call`, and resource routing.
- [Skill ledger](../../src/extension/skill-ledger.ts) / [tool ledger](../../src/extension/tool-ledger.ts): active-branch grants, model-visible messages and non-context records.
- [Tool inventory](../../src/apps/tool-inventory.ts) / [availability policy](../../src/apps/tool-policy.ts): provenance, candidate modes and scoped grants.
- [Real Pi session tests](../../test/extension-real-pi-session.test.ts) / [real Pi tool tests](../../test/extension-real-pi-tools.test.ts): commit order, declaration deltas, nested calls, late tools, branches and the first-prompt gap.
- Installed `@earendil-works/pi-coding-agent/docs/{how-pi-works,extensions,mcp,message-types,session-format,skills}.md`, its public `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`, and `@earendil-works/pi-agent-core/dist/agent-loop.js`: host lifecycle, exposure and context conversion contracts.

## Implementation notes behind the simplified labels

- **“Before the first model step”** means `before_agent_start`, before the submitted user message is persisted. Skill/tool passes run concurrently. It is not called again for each tool result.
- **“Before the next model step”** means a completed, continuing `turn_end`, after the assistant and all tool results are persisted. New queued user text triggers selection with `prompt`/`tool-round`; `initial` tools retain their first task. `tool-round` can add next-best candidates for the same task from cached scores, never from interpreting results. Late tools can also catch up here. The extension returns `[...event.entries, ...ourDrafts]`; Pi commits additions before queued user text enters. The normal loop owns continuation: the extension never sets `continue` or adds a coding-model turn.
- **“Keep the old”** is additive per active branch, not per process. Skills already advertised and tools already granted are not removed or re-scored. Always-allowed items bypass scoring/threshold/caps. New qualifying matches are ranked across all shards and capped per selection (defaults: 12 skills; 8 tools/groups). Unconfigured/below-minimum selection keeps everything available without calls. Active errors add nothing by default; previous availability survives.
- **“Brief summaries”** are bounded user-task text (the first task for `initial` tools, the latest otherwise) plus skill names/descriptions, or tool names/descriptions/server-or-extension labels. Group mode uses a group key/label, an MCP namespace description where present, and bounded tool names. No skill bodies/locations, schemas, annotations, namespace instructions, provenance paths, configs, arguments/results, assistant text or transcripts reach the decider. The coding model does receive skill locations so it can load selected guidance.
- **“Skills stay listed”** describes advertisements, not full instruction loading. The coding model sees a stable system skills base plus new skills as hidden **user-role** custom messages, not native system-prompt updates. Base/tool ledger records are not model context; skill additions are derived from committed delta messages. An active `read` or `bash` reader is required.
- **“Listed directly”** is `setActiveTools` reconciliation for direct/model-only exposure; it restores only tools this extension withheld. **“Search or code”** is indirect codemode/deferred exposure: registration/discovery is unchanged, and a separate hidden names-only user-role notice identifies available indirect tools/groups without overriding direct declarations. Not every selection needs a notice.
- **“Every call is checked”** is `tool_call`, including nested calls inside codemode. Internal tools are recognised by Pi provenance, not names; built-in MCP server tools are still external. An eligible unscored tool can trigger one shared lazy decision round. MCP resource tools remain declared but route by the local `server` argument; unscoped resource listing is blocked while filtering is on. Resource-only servers require an applicable allowlist or previous branch grant.

The loop diagram shows the ordinary tool-result path and final answer without queued work. Queued user text can also continue an assistant-only turn; selection still occurs at the continuing boundary. It does not show every recovery event: Pi owns retries, compaction and final settlement. Late direct tools can appear in the first request, mid-session enabling preserves existing tools, and compaction can temporarily hide skill additions (tool notices are not re-delivered). For the full cadence, group/scoping, bypass, fail-mode and ownership contracts, see [skill picking](../skill-picking.md) and [tool filtering](../tool-filtering.md).
