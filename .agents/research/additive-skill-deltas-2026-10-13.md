# Additive skill-description deltas through Pi 1.1.0

Research handoff, **2026-10-13 UTC**. Proposed integration, **not implemented**. No inference calls, installs, builds, tests, or production edits. External pages below were retrieved and inspected on this date; pages do not expose a publication date. Local evidence is the installed Pi 1.1.0 distribution and current working tree (baseline 9b1796c).

## Answer

**Yes, future requests can introduce new skill descriptions without changing earlier messages.** Distinguish three mechanisms:

1. Native mid-conversation operator instructions: Anthropic `role: system` and OpenAI developer/system input messages, subject to model/provider compatibility.
2. Portable conversation append: a new user-role metadata note. Pi publicly supports this as `custom_message` at a `turn_end` boundary; it does not require a new tool or provider payload rewrite.
3. Provider-native Skills attachment: Anthropic code-execution container skills and OpenAI shell environment skills. These are filesystem/runtime attachment APIs, not necessary for local Pi skill advertisement and not an instruction to upload the user's skill files.

**Recommended route:** preserve an additive branch-local ledger; at submitted-prompt boundaries return the union through `before_agent_start.systemPromptOptions.skills` and let Pi emit its own structured/native deltas. After a tool batch, append only newly selected metadata via a supported `turn_end` custom-message draft. This is user-role context, **not a native system delta**. Do not claim the extension itself uses Anthropic containers, OpenAI hosted shell, or OpenAI server-side response chaining.

## Provider evidence

### Anthropic

[Messages guide](https://platform.claude.com/docs/en/build-with-claude/working-with-messages), sections "Multiple conversational turns" and "System role in messages": Messages is stateless; callers send full history. New system instructions can be appended after a user turn on the documented supported models.

[Dedicated mid-conversation guide](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages), opening, "When to use", and "Limitations", fully retrieved through limitations:
- Appending `{"role":"system"}` leaves earlier prefix unchanged and applies system authority; changing top-level `system` invalidates cached prefix.
- Currently documented on Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5, Opus 4.8, Opus 5, Sonnet 5.5, Haiku 5.5; **not Sonnet 5**. No beta header required for the text-system feature. Tool changes are separate beta features; do not conflate them with skill descriptions.
- A content-carrying system message cannot be first. It must follow a user turn (including tool results) or assistant server-tool-result turn and precede an assistant turn/end of array. Never put it between `tool_use` and its `tool_result`.
- Never place retrieved/raw tool text in system authority. Skill metadata also deserves defensive treatment, not automatic elevation of untrusted instructions.

[Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), "How Skills work" and "Claude API": native Skills require `container` skill IDs plus code execution. Name/description metadata is initially advertised; full SKILL.md loads on demand. Native API containers are distinct from Pi's local filesystem tools.

### OpenAI

[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state), manually managed history and `previous_response_id` sections: append new input to complete prior output, or use a conversation/response chain. Preserve all output items, including reasoning and tool-call items. Prior input tokens in a response chain remain billed as input; server state does not mean free context.

[Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering), "Message roles and instruction following": Responses input accepts developer/user messages; multi-turn conversations may contain multiple such messages. `instructions` applies to the current request and does **not** automatically carry forward with `previous_response_id`.

[Skills](https://developers.openai.com/api/docs/guides/tools-skills), full inspected page including "Use skills with local shell mode" and "Skills in the user prompt":
- Hosted shell attaches uploaded `skill_reference` entries in `tools[].environment.skills`; local shell instead accepts `{name, description, path}` from the controlled local runtime.
- Native Responses shell Skills place name/description/path in **user prompt context**, and instructions have user priority, **not system priority**.
- Hence a Pi custom-message/user-role description delta is semantically reasonable for discoverability; native shell replacement or uploaded bundles are unnecessary for this extension.

[Streaming](https://developers.openai.com/api/docs/guides/streaming-responses): `response.output_text.delta` is incremental **model output**, not an input insertion point. Add descriptions in a subsequent request, not into an in-flight SSE response.

These are vendor-documented capabilities, not live-validated interoperability claims. No universal cache savings or guaranteed model uptake was measured.

## Installed Pi evidence

Paths below are relative to `P=/opt/homebrew/Cellar/pi-coding-agent/1.1.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent`; `A=P/node_modules/@earendil-works/pi-ai/dist`. Read **fully**: `docs/extensions.md`, `message-types.md`, `skills.md`, `how-pi-works.md`, `session-format.md`, `compaction.md`. Also inspected relevant exported declarations, host lifecycle, and provider conversion implementations.

- `P/docs/extensions.md:113-137`: structured prompt sections are preferred so Pi appends transcript deltas; `turn_end` is actionable and accepts entries. Context-with-system owns the whole transcript and is not a small settings mutation.
- `P/dist/core/extensions/types.d.ts:722-744`: public `before_agent_start` structured options; user/custom start distinction.
- `P/dist/core/extensions/types.d.ts:753-833`: boundary drafts accept custom, custom_message, context_edit, compaction, **not a system message draft**. `turn_end` has `toolResults`, `outcome`, message-entry IDs, and preview context.
- `P/dist/core/extensions/types.d.ts:1258-1276`: public `sendMessage` supports `triggerTurn` and delivery modes; `appendEntry` stores non-context data.
- `P/dist/core/agent-session.js:491-521`: turn-end handler runs after persisted assistant/results; Pi commits returned boundary drafts before next request.
- `P/dist/core/agent-session.js:540-565`: next tool turn rebuilds from `_runSystemPromptOptions`; no exported API setter to change its skills mid-run.
- `P/dist/core/agent-session.js:1298-1313`, `P/dist/core/system-prompt.js:136-151`: Pi diffs sections by name and appends a SystemMessage patch when changed. The **entire changed skills section** is transmitted, not necessarily only individual new skills.
- `P/dist/core/agent-session.js:1814-1868`: custom send while streaming with `triggerTurn:false` defers until tool results are complete; `nextTurn` uses a pending queue. Returned turn-end drafts are easier to reason about than racing this queue.
- `P/dist/core/messages.js:75-100`: custom content converts to **user**; custom `details` is not forwarded. Visibility does not alter model-context inclusion.
- `A/api/anthropic-messages.js:378`, `1046-1083`: model compatibility controls native system messages; pending system updates are held until valid wire placement after tool results/user input.
- `A/api/openai-responses.js:95`, `225-247`: compatibility resolves transcript; requests carry full `input`, `store:false`. This path does **not** use `previous_response_id` (none appears in this implementation).
- `A/api/openai-responses-shared.js:125-149`: system instructions convert to developer for supported reasoning models, otherwise system; user messages become input_text.
- `A/utils/transcript.js:57-104`: native-compatible models retain later system messages; incompatible models collapse them into a leading complete checkpoint. Let Pi decide compatibility, do not override catalog/provider flags.
- `A/utils/text.js:24-35`: section patches render as `Updated system prompt section "skills":...`. Existing section updates are **replacement semantics**, so preserving prior selected entries in the desired section is essential for additive policy.
- `P/docs/session-format.md`: custom_message participates in context; custom state entries do not. Compaction replaces earlier messages with a summary/checkpoint, so custom description text is not guaranteed verbatim retention.
- `P/examples/extensions/todo.ts:110-134`: reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` on session_start and session_tree, not all file entries.

Current project evidence: `src/extension/runtime.ts:116-181` currently filters fresh prompt skills and assigns `result.kept`. It has no advertisement ledger/tool-round hook. This describes existing behavior, not the future additive implementation.

## Actionable invariants / acceptance criteria

1. Ledger is **active-branch**, not global settings, whole session-file union, or model-specific cache. Persist safe skill identities/advertisement metadata through public entries/custom-message details. Reconstruct on reload/session_start/tree navigation; new empty sessions begin empty. Do not import skills from abandoned branches.
2. At every pass, candidate list = current invocable inventory minus already-advertised identities, **before** request building/sharding. Existing advertisements bypass relevance calls and are never re-thresholded. Add newly allowlisted entries locally without scoring. Per-pass max bounds **new scored additions** across all shards, not cumulative total or per-shard total.
3. Disabled/unconfigured/below-minimum/fail-open paths that advertise inventory must update the ledger too; otherwise later rounds pay to evaluate skills the model already received. Fail-closed and cancellation retain old ledger plus permitted pins, and do not mark uncommitted new additions as exposed.
4. Tool cadence uses `turn_end` after a completed batch with tool results, not each parallel `tool_result`; skip aborted/error/final/no-tool turns. Return custom_message entries for newly picked skills and **do not set `continue:true`** just to run the picker. No forced continuation loop.
5. Await scoring in the boundary; honor signal/generation/inventory/session changes. Reconcile actual committed active-branch entries rather than optimistically persisting ledger only before a draft is accepted. Guard duplicate concurrent passes.
6. Metadata delta should state these are **additional** available skills, all previously advertised skills stay available, and full instructions remain on-demand. Escape/sanitize descriptions; never copy skill bodies into the decision request or note. Local main-model lookup location may be necessary (Pi normally advertises paths), but **no paths are sent to the decision provider**. Any host-side path inclusion must be documented separately from bounded decision metadata.
7. Compaction may summarize old custom notes. Retain ledger without re-evaluation, then **re-advertise** already-added metadata if necessary (at next prompt through structured union, or a deterministic checkpoint note after compaction). Re-advertisement is not selecting/evaluating again. Do not assume a prose summary preserves exact descriptions. Model switches do not clear the ledger; Pi projects same branch to new provider.
8. Keep initial/pre-prompt structured section additive too: new desired list is retained advertised references plus new additions. Removing an allowlist setting affects only future automatic additions; it cannot retract historical context. Uninstalled skills cannot be read even if old descriptions survive—report this truthfully rather than claim removal.
9. No provider-specific payload editing, new native shell tool, native skill upload, private session mutation, or explicit transcript serialization. Public custom-message metadata is portable but lower authority than native system deltas; docs must say so.

## Remaining policy limitation

Current `AGENTS.md` requires decision requests to contain **only bounded prompt and name/description** (no transcript, tool results, bodies, paths, images). Tool-round scheduling therefore reevaluates only remaining candidates against the latest eligible user task. It can fill a per-round cap incrementally but **cannot infer a new subtask revealed solely by assistant/tool execution**. No new information is added by unchanged prompt. Do not silently send tool names/results/assistant summaries to improve relevance. Capture queued/steered user text if a supported host event exposes it and policy permits; otherwise disclose limitation. User's additive requirement authorizes description notes, not automatic widening of remote decision payloads.

## Unverified

No live Anthropic/OpenAI calls; no Pi end-to-end interactive run; compaction restoration and branch/abort races require focused mocked/public SDK tests by implementer. Provider documentation reflects access date rather than pinned publication/version. Exact proposed UI cadence, defaults, ledger serialization, and references identity belong to implementation design, not completed work in this handoff.
