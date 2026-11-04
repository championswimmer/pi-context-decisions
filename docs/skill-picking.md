[README](../README.md) · [Documentation](README.md)

# Skill picking

## Load early

```bash
pi install npm:pi-context-decisions
# Or, from a checkout
npm install
pi -e ./src/extension.ts -e ./other-extension.ts
```

Keep this extension first or near the start of your configured extensions/packages. Pi awaits handlers in load order. In `before_agent_start` the picker sets `systemPromptOptions.skills` to the cumulative selected inventory; later handlers see that array and can overwrite it. There is no extension-priority guarantee.

### How skills are added (additive picking)

Every picking round scores **only skills that have not been advertised on this session branch yet**, keeps up to *max added per round* of those at or above the threshold, and **adds** them. Skills already added are never re-scored, and nothing is removed later: not by a lower threshold, a settings change, an allowlist change, a failed round or a model switch.

- **Delivery.** Pi renders the selected skills in its native system `skills` section, with name, description and file location. Locations let the coding model load a skill; they are **never** sent to the decision model. Pi records prompt-section updates in the session transcript. On models that support mid-conversation system messages Pi can send the update in place; other providers may fold it into the leading prompt and invalidate the cached prefix. Cache hits are not guaranteed.
- **Always allowed and unfiltered.** Global/project allowlists and legacy pins bypass scoring. If filtering is disabled, no model is configured or the inventory is below *Minimum inventory*, every skill stays advertised. Enabling filtering later does not remove a skill already advertised on the branch.
- **Per branch.** Previously advertised names are derived from committed system skills sections on the active branch, so new sessions start empty, forks inherit and `/tree` navigation follows the active branch. Pi owns prompt persistence and compaction.
- **When it runs.** Skills are selected for submitted prompts at `before_agent_start`, using the previous run's final visible reply when available. Pi does not expose mutable skill options at tool-round boundaries, so queued updates and later tool rounds do not trigger skill picking. Tool filtering has its own independent cadence. Skills require an active `read` or `bash` reader for Pi to advertise them.
- **Pi owns the update.** The extension does not rewrite provider payloads or use `context`/`context_with_system`. A native skills-section patch carries the updated section, not just the new names.
- **Progress.** While a decision round is in flight, Pi's own working row (the animated braille spinner next to **Working**) reads **Deciding Context** with that same spinner, and reverts to Pi's default message when the round settles, fails or is cancelled. Rounds overlap — the skill pass and the tool pass run together, and a tool call can trigger a lazy score — so the label stays until the last in-flight round finishes. Terminal UI only: RPC and print/JSON make no UI calls. It only sets or restores the message and forces the row visible while it decides; because Pi exposes no getter for that visibility, a row you or another extension had hidden comes back and is not hidden again afterwards.

For a local package install, `pi install /absolute/path/to/pi-context-decisions` is supported; ensure package ordering remains appropriate. The package ships TypeScript sources that Pi loads directly; it requires Node >= 22.18 and the Pi peer packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`).

### Privacy and scope

Each eligible skill prompt sends bounded user text and skill names/descriptions to the selected endpoint. It can also send `state.previousReply: {"text":"..."}` containing up to 2,000 characters (and at most 3,000 serialized JSON characters) of visible text from the immediately preceding run's final assistant message, when present. This text can contain sensitive data or quote results and is sent to the selected provider. Earlier replies, private thinking, tool calls and tool-result bodies are not separately collected for skill picking. The task is treated as data, not instructions. [Tool/MCP filtering](tool-filtering.md) has its own cadence and candidate metadata payload; its tool-round mode can send bounded recent assistant activity, including tool-call arguments.

For tool-round decisions, the activity shape is `[{"type":"text","text":"..."}, {"type":"toolCall","name":"read","arguments":{"path":"..."}}]` in chronological order. Argument copying inspects at most 16 properties/elements per container, 32 values per call and 4 nested levels; strings are capped at 256 characters and keys at 80. A copied argument over 1,000 JSON characters becomes `"[truncated]"`; unsupported/cyclic values become `"[omitted]"`. Entries that do not fit the total budget are omitted, preferring the most recent.

This changes **advertisements, not permissions**: explicit `/skill:name`, reading skill files, and already loaded instructions remain possible. Skill filtering never touches tools or MCP servers; that is a [separate opt-in feature](tool-filtering.md). Cancellation/shutdown aborts in-flight filtering; subsequent prompts use Pi's fresh supplied inventory.
