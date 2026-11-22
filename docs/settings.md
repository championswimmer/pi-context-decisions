[README](../README.md) · [Documentation](README.md)

# Settings and commands

Run **`/decisions`** to open one **floating dialog** (powered by `pi-extension-settings-tui`) over the session. Output underneath keeps streaming and scrolling. There are four peer tabs:

| Tab | Settings |
|---|---|
| **Skills** | **Skill filtering** (`skillFilteringEnabled`), **Skills · Max added per round**, **Skills · Minimum inventory**, **Global** and **Project** always-allowed skill editors, and a refreshable Markdown **Status** viewer (`Inspect…`). |
| **Tools** | Independent **Tool filtering** (`toolFilteringEnabled`), **Mode** (`tools` / `mcp`), **Run picker** cadence, dynamic **Tools · …** / **MCP/exts · …** caps and minimum-candidate gates, **Subagents · Allow inherited tools**, and four global/project tool and MCP-server/extension allowlist editors. |
| **Decision** | Shared **Decision model** async picker, **Relevance threshold**, **On failure**, **Shard size**, **Concurrency**, **Timeout**, **Prompt size**, **Description size**, and **Footer icons**. |
| **Lab** | Experimental **Skills · Constant scoring matrix**, **Past turn summaries · Model** (Pi model + thinking-level picker), and **Past turn summaries · Enabled**. |

Skills can be off while tools are on, or vice versa. Selecting a provider/model never enables either feature. No master switch is needed.

**Decision** shows these rows in order: **Decision model**, **Relevance threshold**, **On failure**, **Shard size**, **Concurrency**, **Timeout**, **Prompt size**, **Description size**, and **Footer icons**. The decision model and `decision*` parameters are common to the entire framework: skill picking, tool/MCP/extension picking and explicit allowlist ranking use the same batching, concurrency, deadline and metadata limits. Threshold and failure policy apply to both automatic pickers; explicit ranking only sorts and never auto-selects anything.

The four labeled skill/tool caps and inventory gates remain feature-specific policy, not duplicate scoring knobs: a tool candidate can enable a whole server/extension, whereas a skill candidate is one advertisement. In the **Tools** tab, **Tools · Max added per round** and **Tools · Minimum candidates** update dynamically to **MCP/exts · Max added per round** and **MCP/exts · Minimum candidates** when **Mode** is `mcp`. This also preserves existing defaults (skills: cap **12**, minimum **8**; tools/groups: cap **8**, minimum **0**). Always-allowed and already-added candidates do not consume the cap.

Changes in the dialog auto-save immediately (`saveMode: "immediate"`) with strict validation. **On failure** and **Footer icons** open option pickers (**On failure** disables inline left/right stepping so fail-open requires an explicit picker choice and shows a framework-wide warning). **Decision model** opens an async, searchable, refreshable picker across Pi internal classifiers, the static OpenRouter catalog, and direct API backends. **Status** opens a refreshable Markdown viewer inside the dialog. Rows whose prerequisites are missing are grayed out with inline guidance: **Subagents · Allow inherited tools** is ineligible unless `pi-subagent-manager` is detected (or already enabled), and **Past turn summaries · Enabled** is ineligible until a usable, authenticated housekeeping model is selected. Legacy `pinnedSkills` stays on the `pin`/`unpin` commands, not in the dialog. There are no setter subcommands: everything editable lives here (or in equivalent RPC menus).

Dialog controls: **↑/↓/PgUp/PgDn** move between selectable rows, **←/→** step inline values (booleans, eligible enums, numbers, integers), **Enter/Space** toggle, edit inline, or open pickers/Markdown status/allowlist sub-routes. **Tab** / **Shift+Tab** cycle tabs (**Skills** ↔ **Tools** ↔ **Decision** ↔ **Lab**) at any tab root. **Esc** pops back from a sub-route, and closes from any tab root. Fullscreen mouse clicks (tabs, rows, footer pills) and wheel scrolling are supported across the dialog and its built-in sub-routes. While focused, Esc/Ctrl+C act on the dialog, not the running agent. Running `/decisions` again focuses or replaces the session cleanly; reload/shutdown closes it and cancels its in-flight work. RPC uses **Skills / Tools / Decision / Lab** select/input sub-menus; the custom allowlist editors remain terminal-only. Print/JSON mode prints status; edit the files below and `/reload` to change settings there.

**No backend is selected by default**, so startup and prompts make no decision calls until you configure one. Selection persists across sessions and opts in to sending bounded task/skill metadata on eligible prompts. Choosing a provider/model does not change either feature switch. In the async **Decision model** picker, options are labelled **configured** or **missing key** and unavailable selections are disabled with credential guidance before saving. Configure the relevant `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY` in the environment, or use `/login <provider>` in Pi. Credentials remain Pi-first/environment-second; OpenAI requires its API key, not Codex/ChatGPT OAuth.

### [lab] Past Turn Summaries

Off by default. In **Lab**, select **Past turn summaries · Model** first (using Pi's `field.model` picker to search available, authenticated Pi models and pick a thinking level), then enable **Past turn summaries · Enabled**. Until a usable, authenticated housekeeping model is selected, **Past turn summaries · Enabled** stays grayed out; clearing the model automatically turns **Past turn summaries · Enabled** back off. Unsupported thinking levels are clamped to the model's supported levels, and non-reasoning models use `off`. There is no implicit chat or decision model fallback. With no usable model, no summarization calls are made; `/decisions status` reports the condition. In v5 `settings.json`, these are stored as `"historyModel": { "model": "provider/model-id", "thinkingLevel": "off" }` (or omitted when unset/`null`) and `"historyEnabled": true` (omitted when `false`).

The selected model receives up to 8,000 characters of each visible user prompt after the decision, and of each completed final assistant reply. Thinking, tool outputs, and images are excluded. Each call can cost money and may send sensitive text to that model's provider. Summaries (up to 240 characters each) are stored as branch-local non-context session entries; they survive reloads. Skill and tool/MCP decisions receive up to the latest 12 summaries (2,000 characters), subject to the request size limit, so the selected decision provider also receives this potentially sensitive data. They are not injected into the coding model's chat context. Avoid enabling this for material you do not want sent to either provider.

Summarization is best-effort and asynchronous: decisions use only summaries already available and never wait for pending jobs. A serial queue holds at most eight waiting jobs and drops the oldest waiting job on overflow; requests time out after 20 seconds. Branch/session changes and settings saves cancel pending jobs. Because jobs may finish after another prompt or fail, history can be incomplete and is not guaranteed to improve decisions.


## Settings and relevance policy

### Commands

Everything that can be changed lives in the `/decisions` dialog, so the command has almost no arguments:

```text
/decisions
/decisions status
/decisions history
/decisions test
/decisions tools list
/decisions mcp list
```

- `/decisions`: floating settings dialog (TUI), select/input menus (RPC), or status (print/JSON).
- `/decisions status`: credentials, last decision, allowlist counts and tool filtering; no inference calls.
- `/decisions history`: read-only committed additions on this branch; no inference calls.
- `/decisions test`: explicit synthetic bool call to the selected model; may incur cost.
- `/decisions tools list`: read-only, names-only tool inventory and availability.
- `/decisions mcp list`: read-only MCP-server and extension-group inventory and availability.
- `/decisions pin <skill>` and `/decisions unpin <skill>`: legacy always-included skill names, not in the dialog. Replace `<skill>` with a loaded skill's name.

Removed in favour of the dialog: `settings`, `relevance <key> <value>`, `provider`, `model`, `enable`, `disable`, `allow`, `allowlist`, and every `tools`/`mcp` setter. They now answer with a usage line and change nothing. In a terminal there is nothing to type; RPC clients use the same menus; print/JSON runs edit `settings.json`, `allowlists.json`, and the project allowlist file by hand and `/reload`.

Settings live in `<Pi agent dir>/pi-context-decisions/settings.json`, atomically written with mode `0600` (`0o600`, symlink-refused, 64 KiB cap, secret-key rejected) by `pi-extension-settings-tui` using **override-only persistence** (only fields that differ from defaults are written to disk; `{}` when everything is at its default). Defaults:

- Relevance enabled, **score-only**; skips fewer than **8 unique automatic skills** (everything stays advertised) and empty prompts (no picks).
- Score rubric: **irrelevant → related → directly relevant** (indices 0–2). A skill's score is an expected rubric index, not a class probability or confidence; normalized score = score/2. The single **threshold** (`decisionThreshold`) is that normalized score in [0, 1], inclusive: a skill qualifies when its 0–2 score is at least `2 × threshold`. The default **0.375** equals the previous raw 0.75 ("related"). There is no choice mode, minimum label or second threshold: the decision `choice` primitive still exists in the library, but skill picking does not use it.
- Add up to **12 new** skills per round (*max added per round*, best first across all shards); pinned and scoped always-allowed names bypass scoring/cap/threshold. There is no session-total cap. Original skill references are preserved. Manual-only skills are not sent for classification.
- **Fail closed**: a failed round adds nothing; existing advertisements/availability stay. Shared `decisionFailMode: "open"` explicitly adds every remaining candidate in either picker when scoring fails; configuration errors and aborts always fail closed.
- **Inline v4 → v5 migration on first run:** when `settings.json` contains legacy v4 (or pre-0.3) nested blocks, loading during session startup validates every legacy field strictly and migrates inline:
  1. Legacy global allowlists (`globalAllowlist`, `tools.alwaysAllowedTools`, `tools.alwaysAllowedMcpServers`) are extracted and written **first** to `<Pi agent dir>/pi-context-decisions/allowlists.json` (when `allowlists.json` does not yet exist) so they are never lost.
  2. Pre-0.3 migrations are carried forward before flattening: top-level `enabled: false` disables both `skillFilteringEnabled` and `toolFilteringEnabled`; `relevance.mode: "choice"` migrates to score-only; `relatedThreshold / 2` (or `directThreshold / 2` when `minLabel` was `"directly_relevant"`) populates the legacy skill threshold unless `relevance.threshold` is set; legacy `relevance.*` and `tools.threshold`/`failMode`/`maxDescriptionChars` merge using the **higher** threshold, **shorter** description limit, and **`closed`** if either was closed, while explicit `decision.*` wins per field. **Every legacy value is validated even when shadowed**; invalid values remain visible settings errors and fail closed without rewriting the file.
  3. Nested `decision.*`, `relevance.*`, `tools.*`, and `history.*` blocks flatten into v5 keys (`history.model` + `history.thinkingLevel` merge into `historyModel: { model, thinkingLevel } | null`), and `settings.json` is rewritten in override-only v5 form (dropping `globalAllowlist`, `tools.alwaysAllowedTools`, `tools.alwaysAllowedMcpServers`, and old nested blocks).
- Whole round deadline **8000ms**, requested shards of **50 candidates**. Concurrency **0** means every shard starts in parallel: 300 candidates use six shards; 400 use eight. Set concurrency 1–32 to limit simultaneous shards per pass; skill and tool passes can run concurrently. A lower declared provider/client question limit reduces effective shard size, without omitting candidates.
- Configurable prompt ≤4000 characters and each description ≤400; names ≤64, JSON state ≤65536 characters per batch, inventory ≤1000 unique candidates. These are local safety bounds, not provider token-limit guarantees.

Canonical v5 flat settings shape (showing all defaults; `settings.json` on disk persists only overrides that differ from these defaults):

```json
{
  "skillFilteringEnabled": true,
  "skillMaxAdded": 12,
  "skillMinCandidates": 8,
  "pinnedSkills": [],
  "toolFilteringEnabled": false,
  "toolMode": "tools",
  "toolCadence": "prompt",
  "toolMaxAdded": 8,
  "toolMinCandidates": 0,
  "allowSubagentInheritedTools": false,
  "backend": null,
  "decisionThreshold": 0.375,
  "decisionFailMode": "closed",
  "decisionChunkSize": 50,
  "decisionConcurrency": 0,
  "decisionTimeoutMs": 8000,
  "decisionMaxPromptChars": 4000,
  "decisionMaxDescriptionChars": 400,
  "iconStyle": "unicode",
  "constantMatrix": false,
  "historyModel": null,
  "historyEnabled": false
}
```

When `historyModel` is set, its shape is `{ "model": "provider/model-id", "thinkingLevel": "off" }` (`thinkingLevel` may be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`).

Invalid persisted settings are reported explicitly and advertisements fail closed until repaired in the dialog or with a file edit + `/reload`. Unknown read fields are ignored with a warning; writes reject unknown fields and credentials. Failed writes do not change the active configuration.

### Compact footer

Choose **Footer icons** under `/decisions` → **Decision**: **ASCII / Unicode** (default, no patched font), **Emoji**, or **Nerd Font** (requires a Nerd Font terminal font). The saved `iconStyle` is `unicode`, `emoji`, or `nerd`; older settings files default to Unicode.

```text
◇ ≡ 12/40 ⚙ 18/120      ASCII / Unicode
🎯 📚 12/40 🔧 18/120    Emoji
◇ ≡ 12/40 ⚙ 3/15g       Group mode (Unicode)
```

The leading diamond, target or filter identifies Context Decisions; skills use a list/books/book icon and tools use a gear/wrench. Nerd Font uses the classic Font Awesome filter (`U+F0B0`), book (`U+F02D`) and wrench (`U+F0AD`) glyphs rather than the less portable scroll. Every count is separated from its icon by a space. Skills show **advertised / total invocable skills**, not loaded skill bodies or new additions this round. Tools show **available / total external tools** (built-ins excluded); `g` means MCP-server and extension **groups** instead. Tool counts stay hidden while tool filtering is off. `ready` means no round recorded yet, `setup` means select a model, and `off` means disabled. Short flags such as `!timeout`, `!config`, `!host` (missing host APIs), or `!open` (explicit fail-open fallback) preserve failure visibility. Timings, cache information and detailed reasons remain in `/decisions status`.

### Decisions history

**`/decisions history`** opens a read-only history route in the same floating dialog (never a second overlay). Newest non-empty **user-prompt turns** come first, for example `Turn 1: (3 skills, 2 tools/MCPs added)` and `Turn 20: (1 skills, 1 tools/MCPs added)`. **↑/↓/PgUp/PgDn** selects a prompt; **Enter** expands its internal-turn breakdown and added names. **↑/↓/PgUp/PgDn/Home/End** scrolls details, **Esc** returns, and **Ctrl+R** on the list refreshes the committed branch snapshot. RPC gets the same grouped notification report; print/JSON writes it to stderr, not the protocol stream. Reports are sanitized and capped at 240 lines / 24,000 characters plus a truncation notice; the terminal viewer can browse every stored turn and name.

**Turn numbering** is the one-based, cumulative **assistant-response index on the active branch**, including assistant tool-call rounds, errors and aborted responses. It does not restart at each prompt (unlike Pi's per-run lifecycle `turnIndex`), and does not count tool results, system messages or extension notices as separate turns. If 19 assistant responses follow the initial prompt, the next user prompt is **Turn 20**. Each committed native `user` message starts a top-level prompt, including queued steering/follow-up users; multiple users before the same assistant response share one row, because they have the same turn index. Pi persists no separate steering/source flag, so history does not guess one from message text. A hidden custom message is not a user prompt.

Internal additions are grouped **before the next assistant response**. Native skill-section updates and tool ledger records before the user, and tool `turn_end` additions before a queued user belong to that same response boundary and user prompt. Subsequent tool rounds without another user stay nested under the preceding prompt. Before any native user exists, records are grouped under an initial Turn 1 fallback. A boundary without a following response is marked **no response yet**. Prompts with no history events are omitted; legacy re-delivery-only or notice-only prompts remain browsable with zero new-addition counts. Unsuccessful picks and uncommitted drafts are omitted.

The overview counts newly advertised skills from committed native system sections and new tool-ledger grants. Re-deliveries and notice membership do not inflate those counts. In MCP/group mode, **MCP servers and extensions are equivalent bulk additions**: a recorded `mcp__…` or `ext__…` key is shown and counted once, never expanded into member tools. Tools-mode grants show individual tool names. New group-mode records omit member grants already covered by a whole-group grant (including individual pins that promote a homogeneous group); mixed-origin pins remain individual when no whole-group grant exists. Whole-group grants remain available after pin removal or a switch to tools mode.

For compatibility, old records can contain both a tool and its group. History collapses known members alongside a group granted at the **same response boundary**, including chunked records, using names-only membership from the filter's **existing session registry snapshot**. Reading history never refreshes the registry, scores anything, or persists a membership map. Earlier tools-mode additions are not erased when a later turn promotes their group. **Old records store no group membership:** when the snapshot is absent or a tool is unloaded/unknown, both identifiers remain visible/countable rather than guessing from name prefixes. A snapshot describes known session tools, not proof of their historical provenance if tool names were reused; history cannot fully reconstruct those old grants. Today's mode never relabels old records.

Compact details distinguish:

- **Skills advertised** in Pi's native system `skills` section: name/description/location metadata, **not loaded skill bodies**. History derives names from committed sections. For scored picks made after this change, a non-context session entry stores the selected names, scores and thresholds only after the native section is committed. Pins, unfiltered or failed-open additions and older native-only records have no recorded score or pin reason. Older custom-message records can retain their recorded scores and re-delivery information.
- **Tool / MCP / extension availability** from the opt-in tool ledger. Availability is not a declaration or proof that a description entered model context.
- **Notice membership**, summarized as names only (`+ mcp__exa`, for example), never the raw availability notice text. A notice at the same boundary is marked inline `· notice` beside its availability grant rather than repeating the name. Later/notice-only deliveries retain their own section. Long notice text may summarize lists; stored notice membership is bounded, while chunked availability records retain every name. Withholding, release bookkeeping, considered-only records and empty baseline notices are not additions.

Successful scored tool/group grants retain numeric picks through prompt, initial-tool cadence, cached tool-round additions, catch-up, and lazy-tool decisions (including an `agent_end` flush). A notice at a later boundary can show the original committed grant's score/threshold; it is not a new decision. **Missing picks show `unknown (no recorded pick)`**. Older records, fail-open additions, unconfigured/below-minimum tool grants, mid-session tool bases, and groups promoted from already available tools (without a new group decision) cannot be distinguished from the existing names-only records. In particular, history must not invent a `fail-open` reason or score. No unrecorded reason or score is inferred.

This is committed history, **not proof that a provider request consumed it**, and not a view of what remains visible now. Reload/resume/fork/tree navigation derive it from the current branch; compaction and context edits do not erase historical additions or renumber responses. No separate history file is maintained; pending score metadata is held only until the native section is committed.

History never sends task text or metadata to a decision model, and does not display prompts, assistant text, tool arguments/results, skill bodies, or stored descriptions/paths. It cannot reconstruct old scores, exact scoring triggers, or grants made while tool filtering was off. Tool filtering remains relevance routing, **not a sandbox or permission boundary**.

### Global and project allowlists

From `/decisions`, select **Global always-allowed skills** or **Project always-allowed skills** on the **Skills** tab (or the four **Global / Project always-allowed tools** and **MCP / extensions** rows on the **Tools** tab). Each opens an ejected custom allowlist editor (`createAllowlistComponent`) as a sub-route inside the same dialog, and **Esc** returns to the originating tab. Like the reference extension's **Always allowed** lists, these are **always-included entries, not restriction/permission lists**. Matching skill entries bypass thresholds and the per-round cap (and bypass scoring unless the constant-matrix lab is enabled), join the selected system skills (so removing an entry never withdraws a skill already advertised on the branch) and remain advertised on fail-closed decision/configuration errors. A global entry matches only user/temporary/missing-scope entries; a project entry matches only project-scoped entries. Legacy `pin` names still apply across scopes. Manual-only skills remain unchanged.

- **Global allowlists** are stored separately from `settings.json` in `<Pi agent dir>/pi-context-decisions/allowlists.json` (`0600`, atomic, symlink-refused, 64 KiB cap) as `{ "alwaysAllowed": ["skill-name"], "alwaysAllowedTools": ["tool-name"], "alwaysAllowedMcpServers": ["mcp__server", "ext__extension"] }` (`alwaysAllowed` is always written; `alwaysAllowedTools` and `alwaysAllowedMcpServers` are written when non-empty; read-modify-write preserves unsupplied lists).
- **Project allowlists** are stored in `<cwd>/.pi/pi-context-decisions.json` with the same `{ "alwaysAllowed": [...], "alwaysAllowedTools": [...], "alwaysAllowedMcpServers": [...] }` format. It can be shared in the repository; this is scoped to Pi's working directory, so starting in different subdirectories uses different lists. A malformed allowlist file is warned about and treated as empty, not a full-inventory fallback.
- Lists store names only, sorted and deduplicated. Saved names for unloaded entries appear as **(not loaded)** and survive saves unless explicitly removed.

The editor starts in **A-Z**, with immediate local fuzzy search across names and descriptions. **Typing and changing tabs never make decision calls.** Press **Ctrl+R** (or Enter from the search box) for **Relevance** ranking of all loaded candidates in the chosen scope against the search term. This explicitly uses the same selected decision backend and 50-candidate parallel batches, and may incur charges—even when automatic filtering is disabled. Only search text and candidate names/descriptions are sent. Empty searches and missing models/credentials make no call; inline guidance leaves local fuzzy search usable. Query changes mark old results stale; restarting/closing cancels in-flight work.

Keys: **↓** enter list, **↑/↓** navigate, **Space** toggle (or pin/unpin a whole group in the nested tool editor), **Enter** expand description / collapse group, **Tab** switch A-Z/Relevance, **Ctrl+K** clear search, **Ctrl+S** save in place. **Esc** returns to search; Esc again closes and discards unsaved changes. Selection changes do not save automatically, and ranking never changes selections. The editors need Pi's terminal UI. RPC and print/JSON clients edit `<Pi agent dir>/pi-context-decisions/allowlists.json` or `<cwd>/.pi/pi-context-decisions.json` by hand, then `/reload`.

Before the first prompt the editor uses Pi's loaded skill commands. Afterward it uses an in-memory, metadata-only pre-filter inventory snapshot; after `/reload`, a fresh prompt updates it. Project skills still follow Pi project trust. These lists change advertisements only; explicit skill invocation, tools, and MCP access are unchanged.
