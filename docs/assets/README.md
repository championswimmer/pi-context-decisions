# README diagram sources

The root [README](../../README.md#inside-the-agent-loop) embeds the PNGs here. They assume familiarity with a coding agent's task → model → tool → result loop, **not** Pi's internals. Main labels use plain English; hook names and edge cases live in the README's optional details and the implementation notes below. Their editable SVG originals include accessible titles/descriptions; color is reinforced by labels and arrows.

**Skill-selection diagrams predate native system-section delivery.** Their skill cadence and delivery labels may be stale; use [skill picking](../skill-picking.md) for current behavior until the diagrams are updated.

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

These anchors describe the extension against **Pi 1.1.0**, not a new host API or a permission system:

- [Runtime hooks](../../src/extension/runtime.ts): concurrent first-prompt passes, native system skills selection, and completed/continuing tool `turn_end` drafts.
- [Tool filter](../../src/extension/tool-filter.ts): declared-tool reconciliation, indirect notices, cadence/catch-up, lazy `tool_call`, and resource routing.
- [Skill state](../../src/extension/skill-state.ts) / [tool ledger](../../src/extension/tool-ledger.ts): active-branch advertisements and tool grants.
- [Tool inventory](../../src/apps/tool-inventory.ts) / [availability policy](../../src/apps/tool-policy.ts): provenance, candidate modes and scoped grants.
- [Real Pi session tests](../../test/extension-real-pi-session.test.ts) / [real Pi tool tests](../../test/extension-real-pi-tools.test.ts): commit order, declaration deltas, nested calls, late tools, branches and the first-prompt gap.
- Installed `@earendil-works/pi-coding-agent/docs/{how-pi-works,extensions,mcp,message-types,session-format,skills}.md`, its public `dist/core/extensions/types.d.ts`, `dist/core/agent-session.js`, and `@earendil-works/pi-agent-core/dist/agent-loop.js`: host lifecycle, exposure and context conversion contracts.

## Implementation notes behind the simplified labels

- **“Before the first model step”** means `before_agent_start`, before the submitted user message is persisted. Skill/tool passes run concurrently. It is not called again for each tool result.
- **“Before the next model step”** means tool filtering at a completed, continuing `turn_end`, after the assistant and all tool results are persisted. New queued user text triggers selection with `prompt`/`tool-round`; `initial` tools retain their first task. `tool-round` re-scores remaining candidates using bounded assistant text and tool calls since the latest prompt, never tool results or thinking. Late tools can also catch up here. The extension returns `[...event.entries, ...ourDrafts]`; Pi commits additions before queued user text enters. The normal loop owns continuation: the extension never sets `continue` or adds a coding-model turn.
- **“Keep the old”** is additive per active branch, not per process. Skills already advertised and tools already granted are not removed or re-scored. Always-allowed items bypass scoring/threshold/caps. New qualifying matches are ranked across all shards and capped per selection (defaults: 12 skills; 8 tools/groups). Unconfigured/below-minimum selection keeps everything available without calls. Active errors add nothing by default; previous availability survives.
- **“Brief summaries”** are bounded user-task text (the first task for `initial` tools, the latest otherwise) plus skill names/descriptions, or tool names/descriptions/server-or-extension labels. Group mode uses a group key/label, an MCP namespace description where present, and bounded tool names. Prompt-cadence decisions send the prior run's bounded final visible reply where available. Tool-filtering tool-round decisions instead send bounded recent assistant text and tool calls (including arguments), which can contain sensitive data; see [privacy](../skill-picking.md#privacy-and-scope). No tool-result bodies, thinking, skill bodies/locations, schemas, annotations, namespace instructions, provenance paths or configs reach the decider. The coding model does receive skill locations so it can load selected guidance.
- **“Skills stay listed”** describes advertisements, not full instruction loading. The coding model sees selected skills in Pi's native system skills section; advertised names are derived from committed system sections. An active `read` or `bash` reader is required. Pi's mid-conversation system support is provider/model dependent, so updates can invalidate a cached prefix and cache hits are not guaranteed.
- **“Listed directly”** is `setActiveTools` reconciliation for direct/model-only exposure; it restores only tools this extension withheld. **“Search or code”** is indirect codemode/deferred exposure: registration/discovery is unchanged, and a separate hidden names-only user-role notice identifies available indirect tools/groups without overriding direct declarations. Not every selection needs a notice.
- **“Every call is checked”** is `tool_call`, including nested calls inside codemode. Internal tools are recognised by Pi provenance, not names; built-in MCP server tools are still external. An eligible unscored tool can trigger one shared lazy decision round. MCP resource tools remain declared but route by the local `server` argument; unscoped resource listing is blocked while filtering is on. Resource-only servers require an applicable allowlist or previous branch grant.

The loop diagram shows the ordinary tool-result path and final answer without queued work. Queued user text can also continue an assistant-only turn; tool selection can still occur at the continuing boundary. It does not show every recovery event: Pi owns retries, compaction and final settlement. Late direct tools can appear in the first request, mid-session enabling preserves existing tools, and tool notices are not re-delivered after compaction. For the full cadence, group/scoping, bypass, fail-mode and ownership contracts, see [skill picking](../skill-picking.md) and [tool filtering](../tool-filtering.md).
