# Score-only, additive skill picker: design handoff (2026-10-13, rev. 2)

> **Status: PROPOSED. Nothing here is implemented.** This is an architect's design, based on read-only inspection of baseline `9b1796c` (v0.2.0) and the installed `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` **1.1.0** docs, declarations and dist code. AGENTS.md routes pending handoffs through `.agents/plans/`. This file sits under `.agents/research/` because the requesting thread asked for that. Move it when implementation is scheduled.
>
> Rev. 2 replaces rev. 1's "reuse once per session" cadence with an **additive advertisement ledger**, following new user requirements. Provider-native API claims below are marked **[verify]**. They come from Pi's adapter code, not provider primary docs; a researcher is checking those separately.

## User requirements (latest wins)

1. **Drop choice from skill picking.** Score-only. The general decision `choice` primitive, the codecs and `scripts/live-smoke.ts` stay.
2. **Advanced screen:**
   - threshold (0–1)
   - shard size per batch
   - maximum skills **added** per picking round
   - how often the picker runs (user prompts, after tool-call rounds, …)
3. **All picking is additive.** Already-added skills are never re-evaluated and never removed (no unsupported removal).
4. **Future-turn deltas** carry newly added skill names and descriptions through supported Pi custom-message or context hooks.
5. **Decision payload** is the current user prompt plus bounded skill metadata only, unless an explicit policy extension is approved. Never skill bodies, transcripts or tool results without approval.

Historical evidence stays unedited: `docs/benchmarks/relevance-choice-vs-score.md`, `docs/benchmarks/relevance-methods-raw.json` and `.agents/research/choice-score-skill-selection-2026-10-13.md`. Their "choice is a valid alternative" conclusion is superseded by requirement 1.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Method | Score only. Remove `mode`, `minLabel`, `relatedThreshold`, `directThreshold`, `RelevanceItem.label` and per-skill choice from the picker. |
| Threshold | `relevance.threshold` ∈ [0, 1], inclusive. A skill is eligible when `score >= 2 * threshold`. Default **0.375**, identical to today's raw 0.75. |
| Shard size | Existing `relevance.chunkSize` (1–50), relabelled. |
| Max per round | Existing `relevance.maxSkills` (0–1000), redefined as **maximum newly added per picking round**, ranked globally across all shards. It is not per shard. |
| Additivity | Per-branch **advertisement ledger**. Each round scores only `inventory − pins − ledger − disableModelInvocation`. Additions are never re-scored or removed. |
| Delivery of additions | **Append-only custom messages**: `before_agent_start` result `message` at prompt start, `turn_end` `custom_message` entries between turns. Content is built with Pi's **public** `formatSkillsForPrompt`. |
| Base skills section | `systemPromptOptions.skills` = **base set** (pins, plus anything previously in the base on this branch), set identically every prompt so Pi emits no patch. |
| Cadence | `"prompt"` (default): submitted prompts plus queued steer/follow-up user text seen at turn boundaries. `"tool-round"`: also after tool batches, **only with an approved payload extension** (Q1). |

## Host evidence (Pi 1.1.0, installed)

### Where skills can change, and how they reach providers

- **`before_agent_start`** fires once per idle submitted prompt (`AgentSession.prompt()` → `emitBeforeAgentStart`, `dist/core/agent-session.js` ≈ line 1591).
  - It exposes mutable `systemPromptOptions` (types ≈ line 708).
  - Its result may include **`message`** (`BeforeAgentStartEventResult`, types ≈ line 1101), a custom message pushed after the user message and persisted.
- **System-section deltas (Route A).** After hooks run, Pi diffs prompt sections (`_preparePromptAndToolLoadout` → `diffSystemPromptSections`) and prepends a `SystemMessage { sections: { skills: … } }` patch. The patch carries the **entire** new skills section.
  - pi-ai `resolveTranscript(context, compat.supportsMidConvoSystemMessages)` (`dist/utils/transcript.js` ≈ line 102) keeps the patch mid-conversation only for flagged models.
    - Anthropic Messages sends `{ role: "system", content: [text, tool_addition/tool_removal] }` inside `messages` (`dist/api/anthropic-messages.js` ≈ line 1020).
    - OpenAI Responses sends a `developer` or `system` input item (`dist/api/openai-responses-shared.js` ≈ line 130).
    - Both render `Updated system prompt section "skills": …` (`renderSystemMessageUpdate`). **[verify]** that both are documented provider features.
  - Every other model goes through `collapseSystemMessages`: the head system prompt is rewritten, which invalidates the cached prefix. The extensions doc says so too: "Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix."
  - Installed catalog flags: anthropic/anthropic-messages 7/17, openai/openai-responses 11/44, openrouter/anthropic-messages 0/16, openrouter/openai-completions 11/385.
  - Mid-run, Pi rebuilds turns from run-scoped options (`prepareNextTurnWithContext` ≈ line 544). There is **no public setter**, so Route A works only at prompt start.
- **Custom messages (Route B).** `CustomMessage { customType, content, display, details }`: "Pi converts its content to a user message for model requests … `details` is not sent to the model" (`docs/message-types.md`).
  - Sources:
    - the `before_agent_start` `message` result;
    - `turn_end` / `agent_before_settle` boundary `entries: [{ type: "custom_message", … }]` (`BoundaryResult`), committed by `_commitBoundaryDrafts` → `_refreshFinalizedContext`, so the next request includes them;
    - `pi.sendMessage(…, { deliverAs })`.
  - They are append-only, so the earlier prefix is unchanged on every provider. **[verify]** provider prefix-cache semantics.
- **Queued user text at turn boundaries.** `BoundaryState.context.pendingMessages = agent.peekQueuedMessages() + pending custom messages` (`_getPendingBoundaryMessages`, ≈ line 613). Steering and follow-up messages do not fire `before_agent_start` (`_queueSteer`/`_queueFollowUp`), but `turn_end` can see their text.
- **Public formatter.** `formatSkillsForPrompt(skills, fileReadTool)` is exported from `@earendil-works/pi-coding-agent` (`dist/index.d.ts` line 23). It produces Pi's own `<available_skills>` block: header lines, then name, description and location per skill, skipping `disableModelInvocation`. Pi's own rule (`system-prompt.js` ≈ lines 101–108): use `read` if declared, else `bash` if declared, else `"indirect"` when a reader is selected but hidden by `prepareLoadout`. With no reader at all, Pi **omits the skills section**. The extension can only see `pi.getActiveTools()`, not hidden declarations, so it approximates the rule:
  - `read` if active, else `bash` if active, else `"indirect"`;
  - with neither active, **deliver no delta and add nothing to the ledger**, because the skills would be unreadable. Retry at the next boundary.

  Hidden-declaration fidelity needs an implementation test against a `prepareLoadout` fixture **[verify]**.
- **Persistence and branch state.**
  - `pi.appendEntry(customType, data)` writes a non-context `custom` entry.
  - `ctx.sessionManager` is a `ReadonlySessionManager` with `getBranch`, `buildContextEntries` and `buildSessionProjection` (`dist/core/session-manager.d.ts` line 178).
  - Docs: "Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`."
  - Events: `session_start` (reasons `startup | reload | new | resume | fork`), `session_tree`, `session_compact { compactionEntry, reason, willRetry }`, `model_select`.
- **Compaction.** `buildContextEntries` keeps non-system entries from `firstKeptEntryId` onward and **drops every earlier, and every retained, system message** (`session-manager.js` ≈ lines 201–229; `docs/session-format.md`: "Pre-compaction system messages are folded into the complete checkpoint").
  - The next prompt re-emits the full current sections, so Route A state self-heals.
  - Route B custom messages before `firstKeptEntryId` are summarized away.
  - `context_edit` omissions (overflow recovery) can also hide a custom message. `buildSessionProjection()` reflects those edits.

### Rejected host routes

- `context` / `context_with_system` (request-local; the transcript diverges).
- `before_provider_request` (provider payload surgery).
- Retaining and mutating the run-options skills array (undocumented).
- Any removal of an already-advertised skill.

## Additive ledger design

### State, derived from the session branch (no hidden in-memory truth)

- **Delta entries:** `custom_message`, `customType: "context-decisions-skills"`, with:
  - `content` = `formatSkillsForPrompt(newSkills, reader)`;
  - `details` = `{ v: 1, added: string[], reason: "pick" | "redeliver" | "fail-open" }` (names only; never sent to the model);
  - `display: false`, plus `pi.registerMessageRenderer` for a compact "＋N skills: a, b…" line. Rendering is optional.
- **Base records:** `pi.appendEntry("context-decisions-base", { v: 1, names: string[] })`, appended only when the base set grows.
- **Derived on demand**, cached in memory and invalidated on `session_start`, `session_tree`, `session_compact` and after each append:
  - `ledger` = union of `added` over delta entries in `getBranch()`. This is the do-not-re-evaluate set.
  - `base` = union of base records on the branch, plus currently effective pins.
  - `visible` = `added` names from delta entries present in `buildSessionProjection().entries`.
  - `lost` = `ledger − visible − base`. These are additions summarized away or edited out, and need re-delivery.

### Per-boundary algorithm

At `before_agent_start` (prompt boundary):

1. Reconstruct state. Compute effective pins (global/project allowlists and legacy `pinned`) exactly as today.
2. If `base` grew, for example because pins were added, append a base record. Set `event.systemPromptOptions.skills = inventory.filter(s => base.has(s.name) || s.disableModelInvocation)`, keeping original references and inventory order.
   - Allowlist **removals** never shrink `base` within a branch.
3. Configuration error: fail closed. Base only; no picks; still re-deliver `lost`.
4. Disabled, unconfigured or below-minimum: these preserve full advertisement today. In ledger mode, append a base record with the **whole inventory** and set skills to it. From then on that branch stays full, because a later re-enable must not remove anything.
5. Empty task, for example a bare `/skill:x` (`taskWithoutExpandedSkill`): no picks. Base and `lost` re-delivery only. The branch is **not** flipped to full; this is a deliberate change from today.
6. Otherwise, score `candidates = inventory − base − ledger − disableModelInvocation` with the bounded task text. Keep at most `maxSkills` items with `score >= 2 * threshold`, ranked by score, ties broken by inventory order.
7. Return `{ message }` holding the formatted `lost ∪ added` skills, if any. Re-delivery makes no decision calls and does not count toward `maxSkills`.

At `turn_end` (inside a run):

- Run only if `event.toolResults.length > 0` (another request follows) **or** `context.pendingMessages` contains user text.
- Task text, in priority order:
  - the newest queued steer/follow-up user text (allowed, because it is a user prompt);
  - only with `cadence: "tool-round"` **and** an approved payload extension, the extended context (Q1);
  - otherwise skip picking. Re-scoring remaining candidates against the same prompt is pointless: they already failed this exact input.
- Always re-deliver `lost`, for example after a threshold compaction mid-run.
- Return `{ entries: [{ type: "custom_message", … }] }`. Never `continue: true`.

Failure handling:

- Fail closed adds nothing and records `last` with an error code.
- Fail open (explicit setting) adds all remaining candidates once as a `fail-open` delta: a large, one-time token cost.
- Generation bumps abort in-flight picks as today. A stale completion is never appended.

### Lifecycle and risk matrix

| Event | Behavior | Residual risk |
|---|---|---|
| New session | Empty ledger; base = pins. | None. |
| Resume, reload, fork | Rebuild from `getBranch()`. A fork inherits copied history. | A skill deleted on `/reload` stays mentioned in old deltas (cannot be removed). It drops out of base/formatting because it is not in the inventory. |
| `session_tree` (branch navigation) | Rebuild; the ledger follows the active branch. | None beyond the above. |
| Compaction (manual or threshold) | Deltas before `firstKeptEntryId` become `lost` and are re-delivered at the next boundary. The system checkpoint carries base. | Re-delivery tokens once per compaction. Compaction has already invalidated the cache. |
| Overflow recovery (`willRetry`) | The retry starts as a fresh run. **[verify]** whether `before_agent_start` fires. If not, re-delivery happens at the first `turn_end` after the retried request. | That retried request may lack lost additions. Documented limitation. |
| `context_edit` hides a delta | Shows up as `lost` via `buildSessionProjection`, then re-delivered. | None. |
| Model switch (`model_select`) | No action. Custom messages are model-agnostic user-role content. Base is unchanged, so no patch. | Provider caches are per model regardless. |
| Settings change (threshold, cap, cadence) | Affects only future rounds. Never removes anything. | A lower threshold later adds more. Expected. |
| Allowlist add / remove mid-session | Add grows base, which emits a Route A patch: collapse and a cache miss on non-flagged models, but rare and user-initiated. Remove does not shrink base on this branch. | Base patch cost (optional refinement: deliver new pins as a delta instead). |
| Extension disabled mid-session | Branch flips to full base, per today's semantics. | Irreversible within the branch. Explicit user action. |
| Steering / follow-up queued | Picked at `turn_end` from the queued text. | Picking latency blocks the loop (benchmark ≈ 0.3–1.4 s per call). |
| Concurrency / abort | Uses `ctx.signal`, the pending set and generation checks, as today. | None new. |

### Native API versus portable Pi route (truthful distinction)

- **Route B (chosen) is portable.** Pi sends custom content as ordinary user-role messages on every provider and API. Its cache behavior is a property of append-only prompts. **[verify]** Anthropic and OpenAI prefix-cache rules, TTLs and pricing from primary docs. Trade-offs: the framing is user-role, which carries less authority than system and could be argued with or ignored; and it is a persistent transcript entry.
- **Route A (base only) is native only where Pi's catalog flags support.** Pi represents section updates as provider-native mid-conversation system or developer messages only for models with `compat.supportsMidConvoSystemMessages`; every other model gets a collapsed head prompt. Each patch resends the whole section. That is why the design keeps base stable and does **not** grow it per pick.
- **No provider-specific code** in this extension. It never calls Anthropic or OpenAI chat APIs directly and never edits payloads.

### Token and cache cost model (local, qualitative)

- Each delta costs ≈ header (three fixed lines from `formatSkillsForPrompt`) + Σ per-skill (name + full description, up to 1024 characters per the Agent Skills spec, + absolute location + tags). New tokens are billed once as uncached input, then become part of the cacheable prefix. **[verify]** pricing and cache-write rules.
- Upper bound per branch: the whole inventory once, plus a header per delta, plus re-delivery after each compaction.
- Compared with today's per-prompt replacement:
  - Today, a selection change emits a full skills-section patch. On non-flagged models that rewrites the head prompt and costs a full-prefix cache miss on many prompts.
  - The ledger avoids those misses after the first prompt.
  - Decision cost also falls over time, because only unadvertised candidates are scored.
- Optional refinement: a `maxLedgerSkills` (session-total) cap. It was not requested, so it is not proposed by default.

### Decision payload policy

- **Default, unchanged:** bounded current user text plus remaining candidates' names and bounded descriptions. Current user text means the submitted prompt (after `/skill` expansion stripping) or the newest queued steer/follow-up text. No bodies, paths, transcripts, tool results or images.
  - Skill **locations** appear only in the **chat-model** delta, exactly as in Pi's own skills section. They are never in the decision payload.
- **`tool-round` cadence needs an approved extension (Q1).** Candidate inputs, least to most sensitive:
  - (a) tool names used in the round;
  - (b) bounded assistant text from the turn;
  - (c) tool arguments: **not** proposed (paths, commands);
  - (d) tool results: excluded.
- Until approved, `tool-round` is either not offered or offered disabled with an explanation.

### Reconciliation with `.agents/research/additive-skill-deltas-2026-10-13.md` (researcher, primary docs)

Points where the researcher's handoff and this design agree:

- A ledger scoped to the active branch.
- Candidates are filtered before sharding.
- The cap applies to new additions per round.
- `turn_end` returns `custom_message` drafts and never sets `continue: true`.
- No payload editing, `context_with_system`, native shell/container Skills or `previous_response_id`. The researcher confirms Pi's openai-responses path sends full `input` with `store: false`.
- Re-advertising after compaction is not re-evaluation.
- The decision payload stays unchanged unless approval is given.

Primary-doc facts the researcher supplied, which this design adopts and which close earlier **[verify]** items:

- Anthropic mid-conversation `system` messages leave the earlier prefix unchanged, while changing the top-level `system` invalidates the cache. They are documented only for listed models. They must follow a user or tool-result turn and never sit between `tool_use` and `tool_result`.
- OpenAI native shell Skills put name, description and path into **user-priority** prompt context. A user-role delta is therefore semantically aligned with OpenAI's own skill advertisement.

Adopted from the researcher's invariants:

1. `turn_end` skips turns whose `outcome` is aborted or error, and turns with neither tool results nor queued user text.
2. Guard against duplicate concurrent passes. The ledger is reconciled from **committed** branch entries, never written optimistically.
3. A one-line preface comes before the `formatSkillsForPrompt` block: "Additional skills are now available; previously listed skills remain available. Full instructions load on demand."

The one difference is how the prompt boundary delivers additions:

- **Researcher:** return the *union* through `systemPromptOptions.skills` and let Pi emit native mid-conversation system deltas. This gives system authority on flagged models.
- **This design:** a stable base plus user-role custom-message deltas.

The union route resends the whole skills section on each growth. On non-flagged models, including every OpenRouter `anthropic-messages` entry in the installed catalog, Pi collapses it into a rewritten head prompt, which means a full-prefix cache miss on every prompt that adds skills. The custom-message route is append-only on every provider and is consistent with the tool-round route. **Recommendation:** keep the custom-message delta as the default, and leave the union route as open question Q7, possibly a per-session opt-in. Do not pick a route per model by reading compat flags: a mid-session model switch would mix routes and complicate the ledger.

## Score-only changes (unchanged from rev. 1, condensed)

- `src/apps/relevance.ts`:
  - Score questions only.
  - `interpretRelevance` raises `invalid_response` on any non-score answer.
  - Remove `mode`, the thresholds and `label`.
  - `RelevanceItem = { name, score, normalized, confidence? }`.
  - Legacy option keys from untyped callers raise a config error, so the picker fails closed and never silently re-applies a policy.
- `src/apps/skill-filter.ts`:
  - `threshold` (0–1, default 0.375) replaces `minLabel`.
  - An invalid threshold makes the policy invalid, which fails closed even with `failMode: "open"`.
  - Pins bypass threshold and cap.
  - The stateless `pickSkills` / `filterSkills` public API stays for portable callers. The runtime calls them with the pre-filtered candidate inventory and `maxSkills` as the per-round addition cap.
- Exactness: halving and doubling IEEE-754 doubles is exact, so `score >= 2t` ≡ `score/2 >= t`, and migrating `t = raw/2` is lossless.
- Edge cases: `t = 0` keeps all scored skills up to the cap; `t = 1` requires exactly 2.0.
- `src/settings.ts`, new relevance shape: `enabled, threshold, maxSkills, chunkSize, cadence ("prompt" | "tool-round"), minCandidates, failMode, timeoutMs, maxPromptChars, maxDescriptionChars, concurrency, pinned`.
  - Legacy migration on input only: validate the old fields with the old rules (invalid stays a settings error, fail closed). If `threshold` is absent, `threshold = (minLabel === "directly_relevant" ? directThreshold : relatedThreshold) / 2`. `mode: "choice"` maps the same way and adds one load warning. An explicit `threshold` wins over legacy keys, with a warning.
  - Clean migrations raise no warning. The file is never rewritten on load; the next save writes the new shape.
  - `updateSetting`: `threshold` accepts decimals in [0, 1]; `cadence` accepts `prompt | tool-round`. `tool-round` is rejected with guidance until the payload policy is approved and implemented. Legacy keys are rejected with "use `/decisions relevance threshold <0–1>`".
- Advanced rows, in order:
  1. Skill filtering
  2. **Relevance threshold** (0–1)
  3. **Shard size** (1–50)
  4. **Max skills added per round** (0–1000; "always-allowed skills do not count; already-added skills are never re-scored")
  5. **Run picker** (`prompt`: "submitted prompts and queued messages"; `tool-round`: disabled or hidden until approved, with the reason)
  6. Then, unchanged: On failure, Timeout, Concurrency, Minimum inventory, Prompt size, Description size.

  Removed rows: Scoring mode, Minimum relevance, Related threshold, Direct threshold.
- Optional: rename UI `AdvancedKind "choice"` → `"enum"` and route `{ kind: "choice" }` → `{ kind: "options" }`.
- Status:
  - `relevance on, threshold 0.375, cadence prompt, fail-closed`
  - `Scoring: shard 50, concurrency …, max 12 added per round, …`
  - `Ledger: base B, added A (visible V, pending re-delivery L)`
  - `Last: added k of n candidates · ms · error`
- Allowlist picker shows `normalized.toFixed(2)` instead of a label.

## Affected files

- **Apps:** `src/apps/relevance.ts`, `src/apps/skill-filter.ts`, `src/index.ts` (public API break: `RelevanceLabel`, `RelevanceOptions.mode`/thresholds, `SkillFilterOptions.minLabel`, `RelevanceItem.label`).
- **New** `src/extension/skill-ledger.ts`:
  - pure-ish derivation of ledger state from a `ReadonlySessionManager`-shaped input, plus delta and base builders;
  - imports `formatSkillsForPrompt` (extension layer only; apps stay Pi-free).
- **Runtime:** `src/extension/runtime.ts`:
  - `before_agent_start` returns `{ message }`;
  - new handlers for `turn_end`, `session_tree` and `session_compact`;
  - message renderer registration.
- **Contracts:** `src/extension/contracts.ts`. `ExtensionHost` adds `appendEntry`, `getActiveTools` and `registerMessageRenderer`. The test host must mock these.
- **Settings and UI:** `src/settings.ts`, `src/extension/settings-model.ts`, `src/extension/settings-dialog.ts`, `src/extension/commands.ts`, `src/extension/allowlist-picker.ts`.
- **Demo:** `scripts/demo-skill-picker.ts` passes `threshold` directly. It stays stateless; no ledger.
- **Docs:**
  - `README.md`, `examples/skill-picker-demo/README.md`, `examples/skill-picker-demo/config/pi-context-decisions.example.json`.
  - A superseded note at the top of `docs/benchmarks/relevance-choice-vs-score.md`.
  - `AGENTS.md`: replace "Only mutate `before_agent_start.systemPromptOptions.skills`" with the additive rule (base skills only via that field; additions only via `before_agent_start.message` and `turn_end` `custom_message` entries; never remove; never `context_with_system` or payload edits). Also update the Advanced list, the threshold rule and the cadence/payload policy.
  - `CHANGELOG.md` is generated: use release notes.
- **Benchmark tooling** (owned by `/root/skill-method-benchmarks`): `scripts/benchmark-relevance-methods.ts` and its test use choice and `minLabel`.
  - Commit the benchmark first (user-authorized publisher).
  - Then make `--live` score-only with a threshold sweep, and keep `--summarize` for the historical JSON.

## Ordered steps

0. **Prerequisite:** land or commit the benchmark artifacts in their current form, so the choice arms remain reproducible at a known commit. Coordinate with the benchmark owner. Do not edit their files meanwhile.
1. **Apps score-only + threshold.**
   - Accept:
     - only score requests;
     - a choice answer gives `invalid_response` and fail-closed;
     - inclusive boundary; `t = 0` / `t = 1`;
     - global cap across shards;
     - pins bypass threshold and cap and survive fail-closed;
     - legacy options give a config error and fail closed even when `failMode` is open.
   - Validate: `node --experimental-strip-types --test test/relevance.test.ts test/skill-filter.test.ts test/allowlist-policy.test.ts test/large-inventory.test.ts test/skill-picker-backends.test.ts`.
2. **Settings and migration.**
   - Accept the matrix in Validation.
   - Validate: `test/settings.test.ts`.
3. **Ledger module (pure).**
   - Accept, deriving from synthetic entry arrays:
     - ledger / base / visible / lost;
     - after compaction (deltas before `firstKeptEntryId` are lost);
     - after `context_edit` omission;
     - on branch switch;
     - fork copy;
     - delta content equals `formatSkillsForPrompt(selected, reader)`, with reader chosen from active tools.
   - Validate: new `test/skill-ledger.test.ts`.
4. **Runtime wiring.**
   - Accept:
     - the first prompt sets base = pins and emits one delta with picked skills;
     - the second prompt scores only non-ledger candidates; already-added skills are never sent to `decide`;
     - `maxSkills` caps additions per round;
     - fail-closed adds nothing and still re-delivers lost additions;
     - disabled/unconfigured/below-minimum flip to full base and never shrink later;
     - empty task makes no picks and does not flip;
     - allowlist removal does not shrink base;
     - `turn_end` with queued steer text picks from that text; `turn_end` with tool results only and `cadence: "prompt"` makes zero decide calls;
     - compaction leads to re-delivery at the next boundary with zero decide calls;
     - a generation bump during a pick appends nothing;
     - `session_tree` / `session_start` rebuild from the branch;
     - the payload snapshot contains only task text and candidate names/descriptions (no paths, bodies, transcripts or tool results).
   - Validate: `test/extension-wiring.test.ts`, `test/extension-allowlist-runtime.test.ts`, `test/extension-large-inventory.test.ts` and a new runtime ledger test file.
5. **UI, headless and RPC.**
   - Accept:
     - exactly 11 rows in the order above (`tool-round` is an option inside the cadence row, not a row);
     - threshold decimal edit;
     - cadence options;
     - legacy key guidance;
     - status lines;
     - overlay height within `dialogHeightBudget`.
   - Validate: `test/extension-settings-model.test.ts`, `test/extension-settings-dialog.test.ts`, `test/extension-settings-overlay-render.test.ts`, `test/extension-decisions-settings.test.ts`, `test/extension-settings-command.test.ts`.
6. **Demo, docs and AGENTS.**
   - Accept:
     - demo output unchanged at its default threshold 0.5;
     - `grep -rn "minLabel\|relatedThreshold\|directThreshold" README.md AGENTS.md examples src` hits only migration code.
   - Validate: `test/demo-skill-picker.test.ts`.
7. **Benchmark realignment** (after step 0, by its owner).
8. **Full checks:**
   - `npm test`
   - `npm run typecheck`
   - `npm pack --dry-run --ignore-scripts`
   - Optional isolated tmux pass per AGENTS.
   - Optional opt-in live smoke of a two-prompt session, confirming the delta appears once and the second prompt makes fewer questions.

## Validation (minimum tests)

- **Settings:**
  - v0.2.0 defaults → 0.375, with no warning or error;
  - `directly_relevant` / 1.75 → 0.875;
  - `relatedThreshold` 1.25 → 0.625;
  - `mode: "choice"` → mapped, with one warning;
  - explicit `threshold` beats legacy, with a warning;
  - invalid legacy → error and fail closed;
  - threshold bounds and types (accept 0 and 1; reject −0.01, 1.01, NaN, strings, Infinity);
  - cadence enum; `tool-round` rejected until approved;
  - save writes only new keys;
  - `updateSetting`: decimal parsing, legacy-key guidance.
- **Apps:** listed in step 1.
- **Ledger and runtime:** listed in steps 3–4, plus:
  - delta `details` contains names only;
  - `display: false`;
  - the base record is appended only on growth;
  - no system-section patch on prompts without base growth: `systemPromptOptions.skills` is identical across prompts;
  - model switch has no effect.
- **UI:** listed in step 5.

## Rejected alternatives

| Alternative | Reason |
|---|---|
| Hidden legacy choice mode | Against requirement 1. |
| Two normalized thresholds | One threshold was requested; `directly_relevant` is just a higher single threshold. |
| Per-shard cap | Results depend on order and shard boundaries. |
| Growing the base skills section with each pick (Route A for additions) | Resends the whole section per change. On non-flagged models it collapses the head prompt, a full-prefix cache miss. Prompt boundary only. |
| `context` / `context_with_system` / `before_provider_request` injection | Request-local or payload surgery; diverges from the transcript; violates AGENTS. |
| Tool-round re-scoring against the same prompt | Identical inputs, wasted calls. |
| Removing or pruning advertised skills (section replacement, context edits) | Against requirement 3. |
| Rev. 1's `session` reuse cadence | Superseded by the ledger, which already avoids re-scoring. |
| Auto-rewriting settings on load | Side effect in the read path. |
| Changing the default threshold | The benchmark is too small and model-specific (Q2). |

## Risks

- **Public API break** for 0.x portable consumers: needs a minor bump and release-note callout. Untyped legacy callers get a config error and fail closed.
- **Weaker user-role framing.** A model may treat the custom-message delta as user text and attach less weight to it than to system skills. Mitigation: Pi's exact skills header text. Optional opt-in refinement: fold the ledger into base at compaction time, when the cache is already broken.
- **Monotonic growth.** A long session can accumulate many skills. Bounded by the inventory. Optional total cap.
- **Turn latency.** `turn_end` picks block the loop. They happen only for queued user text or an approved `tool-round`.
- **Overflow-retry gap and `/reload` stale mentions** (matrix above).
- **ExtensionHost surface grows:** `appendEntry`, `getActiveTools`, `registerMessageRenderer`. The mocked host in the tests must cover them.
- **Concurrent benchmark work:** do not touch `scripts/benchmark-relevance-methods.ts` or its test until that work lands.

## Open questions for the user

1. **Tool-round payload extension.** Approve none (`tool-round` hidden, recommended for now), (a) tool names only, or (a)+(b) bounded assistant text? Tool arguments and results stay excluded either way.
2. **Default threshold.** Keep 0.375 (no behavior change, recommended) or use 0.5 (demo default; better F1 in the small benchmark)?
3. **Other Advanced rows.** Keep them below the four requested rows (recommended) or move them to headless only?
4. **"Max per round".** Confirm it means newly added skills per round, ranked globally (recommended), not per shard. Add a session-total cap?
5. **Disabled / unconfigured / below-minimum.** Keep today's "advertise everything" semantics, which become irreversible per branch under additivity (recommended for compatibility), or base-only?
6. **Delta visibility.** `display: false` with a compact renderer (recommended), or fully visible in the transcript?
7. **Prompt-boundary authority versus cache.** Keep user-role custom-message deltas everywhere (recommended: portable and append-only), or grow the base skills section, which gives native system authority only on flagged models and costs a full-prefix cache miss on all others?
