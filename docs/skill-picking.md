[README](../README.md) · [Documentation](README.md)

# Skill picking

## Load early

```bash
pi install npm:pi-context-decisions
# Or, from a checkout
npm install
pi -e ./src/extension.ts -e ./other-extension.ts
```

Keep this extension first or near the start of your configured extensions/packages. Pi awaits handlers in load order. In `before_agent_start` we set `systemPromptOptions.skills` to a **stable base** (always-allowed skills, or the whole inventory once filtering was off on this branch) and return new skills as a hidden custom message; later handlers see that base array and can overwrite it. There is no extension-priority guarantee.

### How skills are added (additive picking)

Every picking round scores **only skills that have not been advertised on this session branch yet**, keeps up to *max added per round* of those at or above the threshold, and **adds** them. Skills already added are never re-scored, and nothing is removed later: not by a lower threshold, a settings change, an allowlist change, a failed round or a model switch.

- **Delivery.** New skills are appended as an **append-only custom message** (`context-decisions-skills`, hidden from the transcript) built with Pi's public `formatSkillsForPrompt`, so the chat model sees Pi's own `<available_skills>` block (name, description and file location) for just the new skills, introduced by one line saying previously listed skills remain available. Locations are needed by the chat model to load a skill; they are **never** sent to the decision model. Pi converts custom messages to **user-role** context. These additions are user-role context, not native system-prompt updates; appending them avoids rewriting the earlier skills context.
- **Stable base.** Always-allowed skills (global/project allowlists and legacy pins) are the only skills in `systemPromptOptions.skills`, identical on every prompt, so Pi emits no prompt-section patch. If filtering is disabled, no model is configured or the inventory is below *Minimum inventory*, **every** skill stays advertised, and the branch remembers it: enabling filtering later never removes a skill the model already saw.
- **Per-branch ledger.** What was advertised is derived from the active session branch (base records plus the delta messages Pi actually persisted), so new sessions start empty, forks inherit, `/tree` navigation follows the active branch and `/resume` or `/reload` rebuild it. A model switch changes nothing.
- **Compaction.** Compaction can summarize a delta message away. Skills whose text is no longer in model-visible context are **re-delivered** (names and descriptions only, no decision call, never re-scored) at the next prompt, or at the next `turn_end` if compaction happened inside a run. Known limitations: the request issued immediately after a mid-run compaction, including overflow recovery's retry, can lack those skills until then; a skill deleted by `/reload` stays mentioned in older messages; with neither `read` nor `bash` active nothing can be delivered, so nothing is scored or recorded.
- **When it runs.** *Run picker* **prompt** (default): on every submitted prompt and queued user update, considering the previous run's final visible reply when available. **tool-round** (opt-in): also after each completed, continuing tool round; remaining candidates are re-scored when recent activity changes. Only candidates above the threshold are added, up to the per-round cap. Neither cadence sets `continue`.
- **Pi cannot** change the system prompt's skills between tool rounds through a public API, and the extension does not rewrite provider payloads or use `context`/`context_with_system`; that is why deltas are custom messages.
- **Progress.** While a decision round is in flight, Pi's own working row (the animated braille spinner next to **Working**) reads **Deciding Context** with that same spinner, and reverts to Pi's default message when the round settles, fails or is cancelled. Rounds overlap — the skill pass and the tool pass run together, and a tool call can trigger a lazy score — so the label stays until the last in-flight round finishes. Terminal UI only: RPC and print/JSON make no UI calls. It only sets or restores the message and forces the row visible while it decides; because Pi exposes no getter for that visibility, a row you or another extension had hidden comes back and is not hidden again afterwards.

For a local package install, `pi install /absolute/path/to/pi-context-decisions` is supported; ensure package ordering remains appropriate. The package ships TypeScript sources that Pi loads directly; it requires Node >= 22.18 and the Pi peer packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`).

### Privacy and scope

Each eligible prompt sends bounded user text and skill names/descriptions to the selected endpoint. Prompt-cadence decisions also send `state.previousReply: {"text":"..."}` containing up to 2,000 characters (and at most 3,000 serialized JSON characters) of visible text from the immediately preceding run's final assistant message, when present. They do not send earlier replies, private thinking, tool calls or tool results from that run. A queued prompt uses the prior run's final, not the current run's intermediate reply. This visible text can contain sensitive data or quote results and is sent to the selected provider. Tool-round decisions instead send `state.activity`, an array of recent assistant text blocks and direct tool-call names and arguments since the latest user prompt. It is bounded to 3,000 JSON characters, favoring recent blocks; text is capped at 600 characters, names at 128, and nested arguments are bounded in depth, count and string length (large arguments may be replaced by `[truncated]`). This can disclose sensitive project data, including paths or secrets present in arguments or assistant text, to the decision provider. Tool-result bodies, private thinking, images, skill bodies and earlier conversation are not separately collected. Assistant text and call arguments can themselves quote results or skill bodies. The task and activity are treated as data, not instructions. [Tool/MCP filtering](tool-filtering.md) has its own candidate metadata payload.

The activity shape is `[{"type":"text","text":"..."}, {"type":"toolCall","name":"read","arguments":{"path":"..."}}]` in chronological order. Argument copying inspects at most 16 properties/elements per container, 32 values per call and 4 nested levels; strings are capped at 256 characters and keys at 80. A copied argument over 1,000 JSON characters becomes `"[truncated]"`; unsupported/cyclic values become `"[omitted]"`. Entries that do not fit the total budget are omitted, preferring the most recent.

This changes **advertisements, not permissions**: explicit `/skill:name`, reading skill files, and already loaded instructions remain possible. Skill filtering never touches tools or MCP servers; that is a [separate opt-in feature](tool-filtering.md). Cancellation/shutdown aborts in-flight filtering; subsequent prompts use Pi's fresh supplied inventory.
